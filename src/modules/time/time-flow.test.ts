import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { listNotifications } from "@/platform/notifications/service";
import { createEmployee } from "@/modules/hr/service";
import { runOutbox } from "@/modules/events";
import { zonedToUtc } from "@/modules/roster/queries";
import { monthTarget } from "./rules";
import {
  addAccountAdjustment, addEntryDirect, approvePeriod, cancelRequest, clockIn, clockOut, correctEntryDirect, decideEntryRequest, deleteEntryDirect,
  discardClock, endBreak, getClock, getEmployeeTime, getPayCodeRules, listAccountEntries, listTeam, reopenPeriod, requestEntry, returnPeriod,
  setPayCodeRules, startBreak, submitPeriod,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const TZ = "Europe/Vienna";
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);

// Vormonat (Zeitbuchungen dürfen nicht in der Zukunft liegen)
const now0 = new Date();
const PM = now0.getUTCMonth() === 0 ? { year: now0.getUTCFullYear() - 1, month: 12 } : { year: now0.getUTCFullYear(), month: now0.getUTCMonth() };
const pad = (n: number) => String(n).padStart(2, "0");
function dayOfPm(n: number) { return `${PM.year}-${pad(PM.month)}-${pad(n)}`; }
function firstMonday() { for (let d = 8; d < 15; d++) if (new Date(`${dayOfPm(d)}T00:00:00Z`).getUTCDay() === 1) return d; throw new Error(); }
const M = firstMonday();           // Montag der 2. Woche
const D1 = dayOfPm(M);             // Montag
const D2 = dayOfPm(M + 1);         // Dienstag
const D3 = dayOfPm(M + 2);         // Mittwoch
const D4 = dayOfPm(M + 3);

describe.skipIf(!hasDb)("Zeiterfassung", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const emp: Record<string, string> = {};
  const userIds: string[] = [];

  async function makeOrg(name: string) {
    const org = await db.organization.create({ data: { tenantId, name } });
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await db.role.create({ data: { organizationId: org.id, key, name: def.name, system: true } });
      const perms = await db.permission.findMany({ where: { key: { in: [...def.permissions] } } });
      await db.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
    return org.id;
  }
  async function makeUser(org: string, label: string, role: RoleKey) {
    const user = await db.user.create({ data: { email: `${label}-${org}@test.invalid`, name: label, passwordHash: await bcrypt.hash("x", 4) } });
    userIds.push(user.id);
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    c[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
  }
  const hrBot = (org: string): Ctx => ({ userId: "hr-bot", organizationId: org, permissions: new Set(SYSTEM_ROLES.hr!.permissions as readonly Permission[]) as Ctx["permissions"] });
  async function makeEmployee(label: string, org: string, managerLabel?: string) {
    emp[label] = (await createEmployee(hrBot(org), { number: label.toUpperCase(), firstName: label, lastName: "Test", userId: c[label]?.userId ?? null, managerId: managerLabel ? emp[managerLabel] : null })).id;
  }
  const titles = async (who: string) => (await listNotifications(c[who]!)).map((n) => n.title);
  const run = () => runOutbox({ organizationId: orgA, batch: 1000 });
  const ym = { year: PM.year, month: PM.month };
  const view = (ctx: Ctx, who: string) => getEmployeeTime(ctx, emp[who]!, PM.year, PM.month);
  const req = (who: string, date: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
    requestEntry(c[who]!, { type: "ADD", date, startTime: from, endTime: to, breakMinutes: 30, reason: "Nachtrag", ...extra });
  const effectiveEntries = async (who: string) => (await view(c.hr!, who)).entries.filter((e) => e.kind === "WORK" && !e.reversedBy);

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Time" } })).id;
    orgA = await makeOrg("TEST-TI-A");
    orgB = await makeOrg("TEST-TI-B");
    for (const [l, r] of [["hr", "hr"], ["mgr", "manager"], ["mgr2", "manager"], ["e1", "employee"], ["e2", "employee"], ["e3", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "hrB", "hr");
    await makeEmployee("hr", orgA); await makeEmployee("mgr", orgA); await makeEmployee("mgr2", orgA);
    await makeEmployee("e1", orgA, "mgr"); await makeEmployee("e2", orgA, "mgr2"); await makeEmployee("e3", orgA, "mgr");
    await makeEmployee("hrB", orgB);
    for (const who of ["e1", "e3", "mgr"]) await db.employment.create({ data: { organizationId: orgA, employeeId: emp[who]!, validFrom: new Date("2000-01-01T00:00:00Z"), contractType: "FULL_TIME", weeklyHours: 40 } });
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["notification", "outboxEvent", "auditLog", "publishedShift", "absenceRequest", "timeEntryRequest", "timeClock", "timeEntry", "timeAccountEntry", "timesheetPeriod", "payCodeRule", "employment", "absenceType", "employee", "approvalPolicy"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: ids } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: ids } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  describe("Stempeluhr", () => {
    it("Kommen, Pause, Gehen erzeugt eine unveränderliche Buchung mit Pausenzeit", async () => {
      expect(await getClock(c.e1!)).toBeNull();
      await clockIn(c.e1!, {}, at(D1, "08:00"));
      await expect(clockIn(c.e1!, {}, at(D1, "08:01"))).rejects.toBeInstanceOf(ConflictError);
      await startBreak(c.e1!, at(D1, "12:00"));
      await expect(startBreak(c.e1!, at(D1, "12:01"))).rejects.toBeInstanceOf(ConflictError);
      await endBreak(c.e1!, at(D1, "12:30"));
      await expect(endBreak(c.e1!, at(D1, "12:31"))).rejects.toBeInstanceOf(ConflictError);
      const e = await clockOut(c.e1!, at(D1, "16:30"));
      expect([e.breakMinutes, e.source, e.kind]).toEqual([30, "CLOCK", "WORK"]);
      expect(await getClock(c.e1!)).toBeNull();
      await expect(clockOut(c.e1!, at(D1, "17:00"))).rejects.toBeInstanceOf(ConflictError);
      // Unveränderlich
      await expect(db.timeEntry.update({ where: { id: e.id }, data: { breakMinutes: 0 } })).rejects.toThrow(/append-only/);
      await expect(db.timeEntry.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
    });
    it("Überschneidung, vergessenes Ausstempeln und Verwerfen", async () => {
      await expect(clockIn(c.e1!, {}, at(D1, "10:00"))).rejects.toThrow(/überschneidet/);
      await clockIn(c.e1!, {}, at(D2, "08:00"));
      await expect(clockOut(c.e1!, at(D2, "08:00"))).rejects.toThrow(/kürzer als eine Minute/);
      await expect(clockOut(c.e1!, new Date(at(D2, "08:00").getTime() + 17 * 3_600_000))).rejects.toThrow(/16 Stunden/);
      await discardClock(c.e1!);
      await expect(discardClock(c.e1!)).rejects.toBeInstanceOf(ConflictError);
    });
    it("ohne Mitarbeiterprofil oder Berechtigung nicht möglich; Kostenstelle anderer Organisation nicht", async () => {
      await expect(clockIn({ ...c.e2!, userId: "kein-profil" }, {}, at(D1, "08:00"))).rejects.toBeInstanceOf(ConflictError);
      await expect(clockIn({ ...c.e2!, permissions: new Set<Permission>() }, {}, at(D1, "08:00"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(clockIn(c.e2!, { costCenterId: "gibt-es-nicht" }, at(D1, "08:00"))).rejects.toBeInstanceOf(NotFoundError);
    });
    it("parallele Einstempelungen: genau eine gewinnt", async () => {
      const r = await Promise.allSettled([clockIn(c.e3!, {}, at(D1, "09:00")), clockIn(c.e3!, {}, at(D1, "09:00"))]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      await discardClock(c.e3!);
    });
  });

  describe("Anträge und Korrekturen", () => {
    it("Antrag und Freigabe", async () => {
      const r = await req("e1", D2, "22:00", "06:00", { reason: "Nachtdienst" });
      await run();
      expect((await titles("mgr")).some((t) => t === "Zeitantrag: e1 Test")).toBe(true);
      expect((await titles("hr")).some((t) => t === "Zeitantrag: e1 Test")).toBe(true);
      expect((await titles("mgr2")).some((t) => t.startsWith("Zeitantrag"))).toBe(false);
      expect((await titles("e1")).some((t) => t.startsWith("Zeitantrag"))).toBe(false);

      await expect(decideEntryRequest(c.e1!, { requestId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError); // eigener Antrag
      await expect(decideEntryRequest(c.e3!, { requestId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError); // ohne Berechtigung
      await expect(decideEntryRequest(c.mgr2!, { requestId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError); // fremdes Team
      await expect(decideEntryRequest(c.hrB!, { requestId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(NotFoundError);
      await decideEntryRequest(c.mgr!, { requestId: r.id, decision: "APPROVE" });
      await expect(decideEntryRequest(c.mgr!, { requestId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);
      const entries = await effectiveEntries("e1");
      expect(entries.map((e) => e.source).sort()).toEqual(["CLOCK", "MANUAL"]);
      await run();
      expect((await titles("e1")).includes("Zeitantrag genehmigt")).toBe(true);

      // Führungskraft kann eigene Anträge nicht selbst freigeben
      const own = await req("mgr", D1, "08:00", "16:30", { reason: "Nachtrag" });
      await expect(decideEntryRequest(c.mgr!, { requestId: own.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);
      await decideEntryRequest(c.hr!, { requestId: own.id, decision: "APPROVE" });
    });

    it("Validierung: Zukunft, Überschneidung, Begründung, Pause", async () => {
      const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      await expect(req("e1", future, "08:00", "16:00")).rejects.toThrow(/Zukunft/);
      await expect(req("e1", D1, "10:00", "11:00")).rejects.toThrow(/überschneidet/); // gegen die Stempelung
      await expect(req("e1", D3, "08:00", "09:00", { reason: "x" })).rejects.toThrow(/Begründung/);
      await expect(req("e1", D3, "08:00", "09:00", { breakMinutes: 60 })).rejects.toThrow(/Pause/);
      await expect(req("e1", D3, "08:00", "09:00", { costCenterId: "gibt-es-nicht" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("Korrektur ersetzt per Gegenbuchung; Historie bleibt sichtbar; Löschen ebenso; doppelte offene Anträge nicht", async () => {
      const original = (await effectiveEntries("e1")).find((e) => e.source === "CLOCK")!; // Montag 08:00–16:30, Pause 30
      const corr = await requestEntry(c.e1!, { type: "CORRECT", targetEntryId: original.id, date: D1, startTime: "08:00", endTime: "17:00", breakMinutes: 30, reason: "Ausstempeln zu früh" });
      await expect(requestEntry(c.e1!, { type: "DELETE", targetEntryId: original.id, reason: "falsch" })).rejects.toThrow(/offenen Antrag/);
      await expect(requestEntry(c.e2!, { type: "DELETE", targetEntryId: original.id, reason: "fremd" })).rejects.toBeInstanceOf(NotFoundError);
      await decideEntryRequest(c.mgr!, { requestId: corr.id, decision: "APPROVE", comment: "ok" });

      const all = (await view(c.hr!, "e1")).entries;
      const eff = all.filter((e) => e.kind === "WORK" && !e.reversedBy);
      expect(eff.some((e) => e.id === original.id)).toBe(false);
      expect(eff.find((e) => e.replacesId === original.id)).toMatchObject({ source: "CORRECTION", breakMinutes: 30 });
      expect(all.some((e) => e.kind === "REVERSAL" && e.reversesId === original.id)).toBe(true); // Gegenbuchung vorhanden
      expect(all.some((e) => e.id === original.id)).toBe(true); // Original bleibt
      await expect(db.timeEntry.create({ data: { organizationId: orgA, employeeId: emp.e1!, kind: "REVERSAL", startAt: original.startAt, endAt: original.endAt, localDate: original.localDate, source: "REVERSAL", reversesId: original.id, createdById: "x" } })).rejects.toThrow(); // nur eine Gegenbuchung je Buchung

      const del = await requestEntry(c.e1!, { type: "DELETE", targetEntryId: eff.find((e) => e.source === "MANUAL")!.id, reason: "doch nicht gearbeitet" });
      await cancelRequest(c.e1!, del.id);
      await expect(cancelRequest(c.e1!, del.id)).rejects.toBeInstanceOf(NotFoundError);
      const rejected = await requestEntry(c.e1!, { type: "DELETE", targetEntryId: eff.find((e) => e.source === "MANUAL")!.id, reason: "nochmal" });
      await decideEntryRequest(c.mgr!, { requestId: rejected.id, decision: "REJECT", comment: "Nachtdienst war" });
      expect((await effectiveEntries("e1")).some((e) => e.source === "MANUAL")).toBe(true);
    });

    it("Personalwesen bucht direkt (mit Begründung); Mitarbeiter und Führungskräfte nicht", async () => {
      const iv = { employeeId: emp.e1, date: D4, startTime: "08:00", endTime: "12:00", breakMinutes: 0, reason: "Schulung" };
      await expect(addEntryDirect(c.e1!, iv)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addEntryDirect(c.mgr!, iv)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addEntryDirect(c.hr!, { ...iv, reason: "" })).rejects.toThrow(/Begründung/);
      await expect(addEntryDirect(c.hrB!, iv)).rejects.toBeInstanceOf(NotFoundError);
      const e = await addEntryDirect(c.hr!, iv);
      await expect(addEntryDirect(c.hr!, { ...iv, startTime: "11:00", endTime: "13:00" })).rejects.toThrow(/überschneidet/);
      const fixed = await correctEntryDirect(c.hr!, { entryId: e.id, date: D4, startTime: "08:00", endTime: "13:00", breakMinutes: 30, reason: "Länger" });
      expect(fixed.replacesId).toBe(e.id);
      await deleteEntryDirect(c.hr!, { entryId: fixed.id, reason: "Irrtum" });
      expect((await effectiveEntries("e1")).some((x) => x.id === fixed.id)).toBe(false);
      const logs = await db.auditLog.findMany({ where: { organizationId: orgA, action: { in: ["time.add_direct", "time.correct_direct", "time.delete_direct"] } } });
      expect(logs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Monatsauswertung", () => {
    it("Ist, Soll (Wochenstunden/5 an Arbeitstagen), Nachtminuten und Hinweise", async () => {
      const t = await view(c.hr!, "e1");
      const s = t.summary;
      const target = monthTarget(PM.year, PM.month, [{ from: "2000-01-01", to: null, weeklyHours: "40" }], new Set());
      expect(s.targetMinutes).toBe(target.targetMinutes);
      // Montag 08:00–17:00 (Pause 30) = 510 min netto; Dienstagnacht 22:00–06:00 (Pause 30) = 450 min netto
      expect(s.workedMinutes).toBe(510 + 450);
      expect(s.deltaMinutes).toBe(s.workedMinutes - s.targetMinutes);
      expect(s.categories.night).toBe(450);
      expect(s.categories.overtime).toBe(Math.max(0, s.deltaMinutes));
      // Pause: 8-h-Schicht mit 30 min ist ok; Hinweise nur für echte Verstöße
      expect(s.hints.filter((h) => h.severity === "ERROR")).toEqual([]);
    });
    it("Plan/Ist: fehlende Buchung am geplanten Tag und Abweichung werden markiert, Abwesenheit ist neutral", async () => {
      const type = await db.absenceType.create({ data: { organizationId: orgA, key: "VACATION", name: "Urlaub", deductsLeave: true } });
      const mkShift = (day: string, from: string, to: string) => db.publishedShift.create({
        data: { organizationId: orgA, rosterId: "r", version: 1, shiftId: `s-${day}-${from}`, employeeId: emp.e1!, startAt: at(day, from), endAt: at(day, to), breakMinutes: 30, siteName: "X" },
      });
      await mkShift(D3, "08:00", "16:30");   // geplant, nichts gebucht → MISSING
      await mkShift(D1, "08:00", "14:30");   // geplant 360 min, gebucht 510 → DEVIATION
      const w = dayOfPm(M + 7);
      await mkShift(w, "08:00", "16:30");    // geplant, aber genehmigter Urlaub → keine Markierung
      await db.absenceRequest.create({ data: { organizationId: orgA, employeeId: emp.e1!, typeId: type.id, startDate: new Date(`${w}T00:00:00Z`), endDate: new Date(`${w}T00:00:00Z`), days: 1, status: "APPROVED" } });
      const s = (await view(c.hr!, "e1")).summary;
      expect(s.days.find((d) => d.date === D3)).toMatchObject({ planned: 480, actual: 0, flag: "MISSING" });
      expect(s.days.find((d) => d.date === D1)).toMatchObject({ planned: 360, actual: 510, delta: 150, flag: "DEVIATION" });
      expect(s.days.find((d) => d.date === w)).toMatchObject({ absence: true, flag: null });
      const target = monthTarget(PM.year, PM.month, [{ from: "2000-01-01", to: null, weeklyHours: "40" }], new Set([w]));
      expect(s.targetMinutes).toBe(target.targetMinutes); // Urlaubstag zählt nicht ins Soll
    });
    it("Compliance: fehlende Pause und zu kurze Ruhezeit werden als Hinweis gemeldet", async () => {
      await addEntryDirect(c.hr!, { employeeId: emp.e3, date: D1, startTime: "08:00", endTime: "16:00", breakMinutes: 0, reason: "Test" });
      await addEntryDirect(c.hr!, { employeeId: emp.e3, date: D2, startTime: "02:00", endTime: "10:00", breakMinutes: 30, reason: "Test" });
      const h = (await view(c.hr!, "e3")).summary.hints.map((x) => x.code);
      expect(h).toEqual(expect.arrayContaining(["BREAK", "REST_DAILY"]));
    });
    it("ohne Beschäftigungsdaten: Hinweis und kein Soll", async () => {
      await addEntryDirect(c.hr!, { employeeId: emp.e2, date: D1, startTime: "08:00", endTime: "12:00", breakMinutes: 0, reason: "Test" });
      const s = (await view(c.hr!, "e2")).summary;
      expect(s.targetMinutes).toBe(0);
      expect(s.hints.some((x) => x.code === "NO_EMPLOYMENT")).toBe(true);
    });
  });

  describe("Zugriff und Datenschutz", () => {
    it("jede Person sieht ihre Daten; Führungskraft nur ihr Team; Personalwesen alle; Fremdzugriffe werden protokolliert", async () => {
      await expect(view(c.e1!, "e1")).resolves.toBeDefined();
      await expect(view(c.e2!, "e1")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(view(c.mgr2!, "e1")).rejects.toBeInstanceOf(ForbiddenError); // anderes Team
      await expect(view(c.hrB!, "e1")).rejects.toBeInstanceOf(NotFoundError);
      const before = await db.auditLog.count({ where: { organizationId: orgA, action: "time.read_other" } });
      await view(c.mgr!, "e1");
      await view(c.hr!, "e2");
      await view(c.e1!, "e1"); // eigene Daten: kein Protokolleintrag
      expect(await db.auditLog.count({ where: { organizationId: orgA, action: "time.read_other" } })).toBe(before + 2);
    });
    it("Teamübersicht: Führungskraft sieht nur direkte Mitarbeiter, Personalwesen alle, Mitarbeiter nichts", async () => {
      expect((await listTeam(c.mgr!, PM.year, PM.month)).rows.map((r) => r.id).sort()).toEqual([emp.e1, emp.e3].sort());
      expect((await listTeam(c.hr!, PM.year, PM.month)).rows.length).toBe(6);
      await expect(listTeam(c.e1!, PM.year, PM.month)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("Monatsabschluss und Zeitkonto", () => {
    it("einreichen → sperrt Eigenaktionen; Freigabe nur durch Berechtigte; Freigabe sperrt und bucht ins Zeitkonto", async () => {
      await expect(submitPeriod(c.e1!, { year: PM.year + 1, month: PM.month })).rejects.toThrow(/Zukunft/);
      await expect(approvePeriod(c.mgr!, { employeeId: emp.e1, ...ym })).rejects.toThrow(/nicht eingereicht/);
      await requestEntry(c.e1!, { type: "ADD", date: dayOfPm(M + 8), startTime: "08:00", endTime: "09:00", breakMinutes: 0, reason: "offen" });
      await expect(submitPeriod(c.e1!, ym)).rejects.toThrow(/offene Korrekturanträge/);
      const open = await db.timeEntryRequest.findFirstOrThrow({ where: { organizationId: orgA, employeeId: emp.e1!, status: "PENDING" } });
      await cancelRequest(c.e1!, open.id);

      await submitPeriod(c.e1!, ym);
      await expect(submitPeriod(c.e1!, ym)).rejects.toThrow(/bereits eingereicht/);
      await expect(clockIn(c.e1!, {}, at(dayOfPm(M + 9), "08:00"))).rejects.toThrow(/eingereicht/);
      await expect(req("e1", dayOfPm(M + 9), "08:00", "09:00")).rejects.toThrow(/eingereicht/);
      await run();
      expect((await titles("mgr")).some((t) => t.startsWith("Monatsabschluss eingereicht: e1"))).toBe(true);

      await expect(approvePeriod(c.e1!, { employeeId: emp.e1, ...ym })).rejects.toBeInstanceOf(ConflictError); // nicht selbst
      await expect(approvePeriod(c.e3!, { employeeId: emp.e1, ...ym })).rejects.toBeInstanceOf(ForbiddenError); // ohne Berechtigung
      await expect(approvePeriod(c.mgr2!, { employeeId: emp.e1, ...ym })).rejects.toBeInstanceOf(ForbiddenError);
      const s = await approvePeriod(c.mgr!, { employeeId: emp.e1, ...ym });
      const t = await view(c.hr!, "e1");
      expect(t.period?.status).toBe("APPROVED");
      expect(t.balance).toBe(s.deltaMinutes);
      await expect(approvePeriod(c.mgr!, { employeeId: emp.e1, ...ym })).rejects.toThrow(/nicht eingereicht/);

      // gesperrt für alle, auch für das Personalwesen
      await expect(addEntryDirect(c.hr!, { employeeId: emp.e1, date: dayOfPm(M + 9), startTime: "08:00", endTime: "09:00", breakMinutes: 0, reason: "Test" })).rejects.toThrow(/gesperrt/);
      const eff = (await effectiveEntries("e1"))[0]!;
      await expect(correctEntryDirect(c.hr!, { entryId: eff.id, date: D1, startTime: "08:00", endTime: "09:00", breakMinutes: 0, reason: "Test" })).rejects.toThrow(/gesperrt/);
      await expect(deleteEntryDirect(c.hr!, { entryId: eff.id, reason: "Test" })).rejects.toThrow(/gesperrt/);
      await run();
      expect((await titles("e1")).some((t) => t.includes("freigegeben"))).toBe(true);
    });

    it("Wiedereröffnen nur Personalwesen mit Begründung: Gegenbuchung im Zeitkonto, erneute Freigabe bucht neu", async () => {
      const before = (await view(c.hr!, "e1")).balance;
      await expect(reopenPeriod(c.mgr!, { employeeId: emp.e1, ...ym, reason: "Fehler" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reopenPeriod(c.hr!, { employeeId: emp.e1, ...ym, reason: "" })).rejects.toThrow(/Begründung/);
      await reopenPeriod(c.hr!, { employeeId: emp.e1, ...ym, reason: "Pause nachtragen" });
      await expect(reopenPeriod(c.hr!, { employeeId: emp.e1, ...ym, reason: "nochmal" })).rejects.toThrow(/nicht freigegeben/);
      const t = await view(c.hr!, "e1");
      expect(t.balance).toBe(0);
      expect(t.period).toMatchObject({ status: "OPEN", reopenCount: 1 });
      const journal = await listAccountEntries(c.hr!, emp.e1!);
      expect(journal.map((j) => j.kind).sort()).toEqual(["PERIOD", "REVERSAL"]);
      expect(journal.reduce((s, j) => s + j.minutes, 0)).toBe(0);

      await addEntryDirect(c.hr!, { employeeId: emp.e1, date: dayOfPm(M + 9), startTime: "08:00", endTime: "09:00", breakMinutes: 0, reason: "Nachtrag" });
      await submitPeriod(c.e1!, ym);
      await approvePeriod(c.hr!, { employeeId: emp.e1, ...ym });
      const after = await view(c.hr!, "e1");
      expect(after.balance).toBe(after.summary.deltaMinutes);
      expect(after.balance).toBe(before + 60);
    });

    it("zurückgeben an die Person; keine Freigabe ohne Beschäftigungsdaten; keine Selbstfreigabe; parallele Freigaben", async () => {
      // e2 (keine Beschäftigungsdaten)
      await submitPeriod(c.e2!, ym);
      await expect(approvePeriod(c.mgr2!, { employeeId: emp.e2, ...ym })).rejects.toThrow(/keine Beschäftigungsdaten/);
      await expect(returnPeriod(c.mgr2!, { employeeId: emp.e2, ...ym, comment: "" })).rejects.toThrow(/Grund/);
      await returnPeriod(c.mgr2!, { employeeId: emp.e2, ...ym, comment: "Bitte Beschäftigungsdaten klären" });
      expect((await view(c.hr!, "e2")).period?.status).toBe("OPEN");
      await run();
      expect((await titles("e2")).some((t) => t.includes("zurückgegeben"))).toBe(true);

      // Führungskraft reicht eigenen Monat ein und kann ihn nicht selbst freigeben
      await addEntryDirect(c.hr!, { employeeId: emp.mgr, date: D3, startTime: "08:00", endTime: "16:30", breakMinutes: 30, reason: "Test" });
      await submitPeriod(c.mgr!, ym);
      await expect(approvePeriod(c.mgr!, { employeeId: emp.mgr, ...ym })).rejects.toBeInstanceOf(ConflictError);

      // parallele Freigabe durch Personalwesen: genau eine wirkt, Zeitkonto nur einmal gebucht
      const r = await Promise.allSettled([approvePeriod(c.hr!, { employeeId: emp.mgr, ...ym }), approvePeriod(c.hr!, { employeeId: emp.mgr, ...ym })]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(await db.timeAccountEntry.count({ where: { organizationId: orgA, employeeId: emp.mgr!, kind: "PERIOD" } })).toBe(1);
    });

    it("Zeitkonto-Korrektur nur mit Berechtigung; Journal unveränderlich; Zuschlagsregeln konfigurierbar", async () => {
      await expect(addAccountAdjustment(c.mgr!, { employeeId: emp.e1, minutes: 60, note: "Auszahlung" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addAccountAdjustment(c.hr!, { employeeId: emp.e1, minutes: 0, note: "nichts" })).rejects.toThrow();
      const before = (await view(c.hr!, "e1")).balance;
      const adj = await addAccountAdjustment(c.hr!, { employeeId: emp.e1, minutes: -120, note: "Zeitausgleich genommen" });
      expect((await view(c.hr!, "e1")).balance).toBe(before - 120);
      await expect(db.timeAccountEntry.update({ where: { id: adj.id }, data: { minutes: 1 } })).rejects.toThrow(/append-only/);
      await expect(db.timeAccountEntry.delete({ where: { id: adj.id } })).rejects.toThrow(/append-only/);

      expect(await getPayCodeRules(c.hr!)).toEqual({ NIGHT: 25, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 });
      await expect(setPayCodeRules(c.mgr!, { NIGHT: 30, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 })).rejects.toBeInstanceOf(ForbiddenError);
      await setPayCodeRules(c.hr!, { NIGHT: 30, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 });
      expect((await getPayCodeRules(c.hr!)).NIGHT).toBe(30);
      expect((await getPayCodeRules(c.hrB!)).NIGHT).toBe(25); // andere Organisation unberührt
    });
  });
});

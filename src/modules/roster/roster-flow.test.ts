import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { listNotifications } from "@/platform/notifications/service";
import { createEmployee } from "@/modules/hr/service";
import { runOutbox } from "@/modules/events";
import {
  addShift, assignEmployee, cancelSwap, createQualification, createRoster, createSite, decideSwap, getRoster, getRules, listMyShifts, listRosters,
  listSwaps, publishRoster, removeShift, requestSwap, respondSwap, setEmployeeQualification, setRules, unassignEmployee,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;

const Y = new Date().getFullYear() + 1;
function monday(month: number, week = 0) {
  const d = new Date(Date.UTC(Y, month - 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * week);
  return d.toISOString().slice(0, 10);
}
const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Dienstplanung", () => {
  let tenantId = "", orgA = "", orgB = "", siteA = "", siteB = "", qualKasse = "";
  const c: Record<string, Ctx> = {};
  const emp: Record<string, string> = {};
  const userIds: string[] = [];
  const W1 = monday(6, 0); // Montag Juni, 1. Woche

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
  const hrCtx = (org: string): Ctx => ({ userId: "hr-bot", organizationId: org, permissions: new Set(SYSTEM_ROLES.hr!.permissions as readonly Permission[]) as Ctx["permissions"] });
  async function makeEmployee(label: string, org: string, managerLabel?: string) {
    emp[label] = (await createEmployee(hrCtx(org), { number: label.toUpperCase(), firstName: label, lastName: "Test", userId: c[label]?.userId ?? null, managerId: managerLabel ? emp[managerLabel] : null })).id;
  }
  const titles = async (who: string) => (await listNotifications(c[who]!)).map((n) => n.title);
  const shift = (rosterId: string, date: string, from = "08:00", to = "16:30", extra: Record<string, unknown> = {}) =>
    addShift(c.planner!, { rosterId, date, startTime: from, endTime: to, breakMinutes: 30, requiredCount: 1, ...extra });
  const assign = (shiftId: string, who: string, ctx = c.planner!) => assignEmployee(ctx, { shiftId, employeeId: emp[who] });
  const run = () => runOutbox({ organizationId: orgA, batch: 500 });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Roster" } })).id;
    orgA = await makeOrg("TEST-RO-A");
    orgB = await makeOrg("TEST-RO-B");
    for (const [l, r] of [["planner", "scheduler"], ["mgr", "manager"], ["mgr2", "manager"], ["e1", "employee"], ["e2", "employee"], ["e3", "employee"], ["e4", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "plannerB", "scheduler");
    await makeEmployee("mgr", orgA); await makeEmployee("mgr2", orgA);
    await makeEmployee("e1", orgA, "mgr"); await makeEmployee("e2", orgA, "mgr"); await makeEmployee("e3", orgA, "mgr2"); await makeEmployee("e4", orgA, "mgr2");
    await makeEmployee("plannerB", orgB);
    siteA = (await createSite(c.planner!, { name: "Filiale Wien", timeZone: "Europe/Vienna" })).id;
    siteB = (await createSite(c.plannerB!, { name: "Filiale B", timeZone: "Europe/Vienna" })).id;
    qualKasse = (await createQualification(c.planner!, { name: "Kasse" })).id;
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["notification", "outboxEvent", "auditLog", "publishedShift", "absenceRequest", "roster", "employeeQualification", "shiftTemplate", "qualification", "rosterRules", "absenceType", "employee", "approvalPolicy"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: ids } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: ids } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  describe("Berechtigungen und Mandantentrennung", () => {
    it("planen nur mit roster.plan, veröffentlichen nur mit roster.publish, Lesen mit roster.read_all", async () => {
      await expect(createRoster(c.e1!, { siteId: siteA, startDate: W1, endDate: plus(W1, 6) })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createRoster(c.mgr!, { siteId: siteA, startDate: W1, endDate: plus(W1, 6) })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listRosters(c.e1!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setRules(c.planner!, { restDailyMinutes: 600, maxDailyMinutes: 720, maxWeeklyMinutes: 3600, breakAfterMinutes: 360, minBreakMinutes: 30, weeklyRestMinutes: 2160 })).rejects.toBeInstanceOf(ForbiddenError);
      expect((await getRules(c.mgr!)).restDailyMinutes).toBe(660);
    });
    it("Standort/Qualifikation einer anderen Organisation sind nicht erreichbar", async () => {
      await expect(createRoster(c.planner!, { siteId: siteB, startDate: W1, endDate: plus(W1, 6) })).rejects.toBeInstanceOf(NotFoundError);
      await expect(setEmployeeQualification(c.planner!, emp.plannerB!, qualKasse, true)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("Plan, Schichten und Zuweisung", () => {
    let rosterId = "";
    it("Plan: Zeitraum ≤ 42 Tage, keine Überschneidung je Standort", async () => {
      await expect(createRoster(c.planner!, { siteId: siteA, startDate: W1, endDate: plus(W1, 60) })).rejects.toBeInstanceOf(ConflictError);
      await expect(createRoster(c.planner!, { siteId: siteA, startDate: plus(W1, 6), endDate: W1 })).rejects.toThrow();
      rosterId = (await createRoster(c.planner!, { siteId: siteA, startDate: W1, endDate: plus(W1, 13) })).id;
      await expect(createRoster(c.planner!, { siteId: siteA, startDate: plus(W1, 13), endDate: plus(W1, 20) })).rejects.toBeInstanceOf(ConflictError);
    });

    it("Schicht: Datum im Zeitraum, Pausen-/Längenregel, Zeitumstellung", async () => {
      await expect(shift(rosterId, plus(W1, 20))).rejects.toBeInstanceOf(ConflictError); // außerhalb
      await expect(addShift(c.planner!, { rosterId, date: W1, startTime: "08:00", endTime: "17:00", breakMinutes: 0, requiredCount: 1 })).rejects.toThrow(/Pause/);
      await expect(addShift(c.planner!, { rosterId, date: W1, startTime: "06:00", endTime: "20:00", breakMinutes: 30, requiredCount: 1 })).rejects.toThrow(/Höchstarbeitszeit/);
      await expect(shift(rosterId, W1, "25:00", "08:00")).rejects.toThrow();
      await expect(addShift(c.e1!, { rosterId, date: W1, startTime: "08:00", endTime: "16:00", breakMinutes: 30, requiredCount: 1 })).rejects.toBeInstanceOf(ForbiddenError);

      // Sommerzeit-Umstellung: Zeit existiert nicht / Nachtschicht dauert 7 h
      const dstRoster = (await createRoster(c.planner!, { siteId: siteA, startDate: `${Y}-03-22`, endDate: `${Y}-04-02` })).id;
      const sunday = new Date(Date.UTC(Y, 2, 31));
      while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() - 1); // letzter Sonntag im März
      const sun = sunday.toISOString().slice(0, 10);
      await expect(addShift(c.planner!, { rosterId: dstRoster, date: sun, startTime: "02:30", endTime: "09:00", breakMinutes: 30, requiredCount: 1 })).rejects.toThrow(/existiert .* nicht/);
      const night = await addShift(c.planner!, { rosterId: dstRoster, date: plus(sun, -1), startTime: "22:00", endTime: "06:00", breakMinutes: 30, requiredCount: 1 });
      expect((night.endAt.getTime() - night.startAt.getTime()) / 3_600_000).toBe(7);
    });

    it("Zuweisung: Qualification, Doppelbuchung, Ruhezeit, Abwesenheit, Beschäftigung", async () => {
      const day1 = await shift(rosterId, W1, "08:00", "16:30");
      const kasse = await shift(rosterId, plus(W1, 1), "08:00", "16:30", { qualificationId: qualKasse });
      const overlap = await shift(rosterId, W1, "12:00", "20:30");
      const early = await shift(rosterId, plus(W1, 1), "07:00", "15:30"); // < 11 h nach 20:30 des Vortags

      expect((await assign(day1.id, "e1")).warnings).toEqual([]);
      await expect(assign(day1.id, "e1")).rejects.toBeInstanceOf(ConflictError); // schon zugewiesen
      await expect(assign(overlap.id, "e1")).rejects.toThrow(/Überschneidende Schichten/);

      await expect(assign(kasse.id, "e2")).rejects.toThrow(/Qualifikation/);
      await setEmployeeQualification(c.planner!, emp.e2!, qualKasse, true);
      await assign(kasse.id, "e2");

      await assign(overlap.id, "e3");
      await expect(assign(early.id, "e3")).rejects.toThrow(/Ruhezeit/);

      // genehmigte Abwesenheit blockiert (e4: Urlaub am Tag)
      const type = await db.absenceType.create({ data: { organizationId: orgA, key: "VACATION", name: "Urlaub", deductsLeave: true } });
      await db.absenceRequest.create({ data: { organizationId: orgA, employeeId: emp.e4!, typeId: type.id, startDate: new Date(`${W1}T00:00:00Z`), endDate: new Date(`${W1}T00:00:00Z`), days: 1, status: "APPROVED" } });
      await expect(assign(day1.id, "e4")).rejects.toThrow(/Abwesenheit/);

      // Beschäftigungsdaten vorhanden, aber nicht gültig → blockiert; ohne Daten → erlaubt
      await db.employment.create({ data: { organizationId: orgA, employeeId: emp.mgr!, validFrom: new Date("2000-01-01T00:00:00Z"), validTo: new Date("2001-01-01T00:00:00Z"), contractType: "FULL_TIME", weeklyHours: 38.5 } });
      await expect(assign(day1.id, "mgr")).rejects.toThrow(/Beschäftigungsverhältnis/);

      await unassignEmployee(c.planner!, overlap.id, emp.e3!);
      await expect(unassignEmployee(c.planner!, overlap.id, emp.e3!)).rejects.toBeInstanceOf(NotFoundError);
      await removeShift(c.planner!, early.id);
      await removeShift(c.planner!, overlap.id);
    });

    it("andere Organisation: kein Zugriff, keine Zuweisung fremder Mitarbeiter", async () => {
      await expect(getRoster(c.plannerB!, rosterId)).rejects.toBeInstanceOf(NotFoundError);
      expect(await listRosters(c.plannerB!)).toEqual([]);
      const s = (await getRoster(c.planner!, rosterId)).roster.shifts[0]!;
      await expect(assignEmployee(c.plannerB!, { shiftId: s.id, employeeId: emp.plannerB })).rejects.toBeInstanceOf(NotFoundError);
      await expect(assignEmployee(c.planner!, { shiftId: s.id, employeeId: emp.plannerB })).rejects.toBeInstanceOf(NotFoundError);
      await expect(publishRoster(c.plannerB!, rosterId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(removeShift(c.plannerB!, s.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("parallele Zuweisungen derselben Person zu überschneidenden Schichten: genau eine gewinnt", async () => {
      const a = await shift(rosterId, plus(W1, 4), "08:00", "16:30");
      const b = await shift(rosterId, plus(W1, 4), "10:00", "18:30");
      const r = await Promise.allSettled([assign(a.id, "e4"), assign(b.id, "e4")]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const mine = await db.shiftAssignment.count({ where: { employeeId: emp.e4!, shiftId: { in: [a.id, b.id] } } });
      expect(mine).toBe(1);
      await removeShift(c.planner!, a.id);
      await removeShift(c.planner!, b.id);
    });

    it("Regeln sind je Organisation einstellbar und wirken auf Zuweisungen", async () => {
      const owner: Ctx = { ...c.planner!, permissions: new Set(PERMISSIONS) as Ctx["permissions"] };
      const a = await shift(rosterId, plus(W1, 9), "14:00", "22:30"); // endet 22:30
      const b = await shift(rosterId, plus(W1, 10), "09:30", "18:00"); // 11 h Pause: erlaubt
      await assign(a.id, "e1");
      await assign(b.id, "e1");
      await unassignEmployee(c.planner!, b.id, emp.e1!);
      await setRules(owner, { restDailyMinutes: 12 * 60, maxDailyMinutes: 720, maxWeeklyMinutes: 3600, breakAfterMinutes: 360, minBreakMinutes: 30, weeklyRestMinutes: 2160 });
      await expect(assign(b.id, "e1")).rejects.toThrow(/Ruhezeit/);
      await setRules(owner, { restDailyMinutes: 660, maxDailyMinutes: 720, maxWeeklyMinutes: 3600, breakAfterMinutes: 360, minBreakMinutes: 30, weeklyRestMinutes: 2160 });
      await assign(b.id, "e1");
      await removeShift(c.planner!, a.id);
      await removeShift(c.planner!, b.id);
    });
  });

  describe("Veröffentlichen (Versionen)", () => {
    let rosterId = "";
    let s1 = "", s2 = "";
    const W = monday(8, 0);

    it("Erstveröffentlichung: Version 1, Projektion, Benachrichtigung; Warnung bei Unterbesetzung blockiert nicht", async () => {
      rosterId = (await createRoster(c.planner!, { siteId: siteA, startDate: W, endDate: plus(W, 6) })).id;
      s1 = (await shift(rosterId, W, "08:00", "16:30", { requiredCount: 2 })).id;
      s2 = (await shift(rosterId, plus(W, 1), "08:00", "16:30")).id;
      await assign(s1, "e1");
      await assign(s2, "e2");
      const check = (await getRoster(c.planner!, rosterId)).check;
      expect(check.violations.some((v) => v.code === "UNDERSTAFFED" && v.shiftIds.includes(s1))).toBe(true);
      expect(check.errors).toBe(0);

      await expect(publishRoster(c.e1!, rosterId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(publishRoster(c.mgr!, rosterId)).rejects.toBeInstanceOf(ForbiddenError);
      const r = await publishRoster(c.planner!, rosterId);
      expect(r.version).toBe(1);
      expect(r.added).toHaveLength(2);
      expect(await db.publishedShift.count({ where: { rosterId } })).toBe(2);
      expect((await listMyShifts(c.e1!, new Date(0))).map((x) => x.shiftId)).toContain(s1);

      await run();
      expect((await titles("e1")).some((t) => t.includes("Filiale Wien") && t.includes("neue Schicht"))).toBe(true);
      expect((await titles("e3")).some((t) => t.includes("Filiale Wien"))).toBe(false); // nicht betroffen
    });

    it("Version ist unveränderlich (Datenbank-Trigger); ohne Änderung keine neue Version", async () => {
      const v = (await db.rosterVersion.findFirst({ where: { rosterId } }))!;
      await expect(db.rosterVersion.update({ where: { id: v.id }, data: { snapshot: [] } })).rejects.toThrow(/unveränderlich/);
      await expect(db.rosterVersion.delete({ where: { id: v.id } })).rejects.toThrow(/unveränderlich/);
      await expect(publishRoster(c.planner!, rosterId)).rejects.toBeInstanceOf(ConflictError);
    });

    it("Änderungen bleiben bis zur Veröffentlichung unsichtbar; Version 2 enthält die Differenz und benachrichtigt", async () => {
      await assign(s1, "e3");
      await unassignEmployee(c.planner!, s2, emp.e2!);
      expect((await db.roster.findUniqueOrThrow({ where: { id: rosterId } })).dirty).toBe(true);
      // Mitarbeiter sehen weiterhin Version 1
      expect((await listMyShifts(c.e2!, new Date(0))).map((x) => x.shiftId)).toContain(s2);
      expect((await listMyShifts(c.e3!, new Date(0))).map((x) => x.shiftId)).not.toContain(s1);

      const r = await publishRoster(c.planner!, rosterId, "Krankheitsvertretung");
      expect(r.version).toBe(2);
      expect(r.added.map((p) => p.employeeId)).toEqual([emp.e3]);
      expect(r.removed.map((p) => p.employeeId)).toEqual([emp.e2]);
      expect((await listMyShifts(c.e2!, new Date(0))).map((x) => x.shiftId)).not.toContain(s2);
      expect((await listMyShifts(c.e3!, new Date(0))).map((x) => x.shiftId)).toContain(s1);

      await run();
      expect((await titles("e2")).some((t) => t.includes("entfernt"))).toBe(true);
      expect((await titles("e3")).some((t) => t.includes("neue Schicht"))).toBe(true);
      const versions = await db.rosterVersion.findMany({ where: { rosterId }, orderBy: { version: "asc" } });
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect((versions[1]!.changes as { reason: string }).reason).toBe("Krankheitsvertretung");
    });

    it("Veröffentlichung wird verweigert, wenn inzwischen ein Regelverstoß besteht (z. B. neu genehmigte Abwesenheit)", async () => {
      const a = await db.absenceRequest.create({
        data: { organizationId: orgA, employeeId: emp.e1!, typeId: (await db.absenceType.findFirstOrThrow({ where: { organizationId: orgA } })).id, startDate: new Date(`${W}T00:00:00Z`), endDate: new Date(`${W}T00:00:00Z`), days: 1, status: "APPROVED" },
      });
      await assign(s2, "e4");
      await expect(publishRoster(c.planner!, rosterId)).rejects.toThrow(/Regelverstöße.*Abwesenheit/);
      await db.absenceRequest.delete({ where: { id: a.id } });
      expect((await publishRoster(c.planner!, rosterId)).version).toBe(3);
    });
  });

  describe("Schichttausch", () => {
    let rosterId = "", sh = "", other = "";
    const W = monday(10, 0);

    it("Anfrage → Zustimmung der Kollegin → Freigabe → neue Version", async () => {
      rosterId = (await createRoster(c.planner!, { siteId: siteA, startDate: W, endDate: plus(W, 6) })).id;
      sh = (await shift(rosterId, plus(W, 2), "08:00", "16:30")).id;
      other = (await shift(rosterId, plus(W, 2), "12:00", "20:30")).id;
      await assign(sh, "e1");
      await assign(other, "e2");
      await publishRoster(c.planner!, rosterId);

      await expect(requestSwap(c.e3!, { shiftId: sh, toEmployeeId: emp.e1 })).rejects.toBeInstanceOf(NotFoundError); // nicht meine Schicht
      await expect(requestSwap(c.e1!, { shiftId: sh, toEmployeeId: emp.e1 })).rejects.toBeInstanceOf(ConflictError); // mit sich selbst
      const swap = await requestSwap(c.e1!, { shiftId: sh, toEmployeeId: emp.e3, note: "Arzttermin" });
      await expect(requestSwap(c.e1!, { shiftId: sh, toEmployeeId: emp.e4 })).rejects.toBeInstanceOf(ConflictError); // läuft bereits
      await run();
      expect((await titles("e3")).some((t) => t.startsWith("Tauschanfrage von e1"))).toBe(true);

      await expect(respondSwap(c.e4!, swap.id, true)).rejects.toBeInstanceOf(ForbiddenError); // nur der Adressat
      await expect(decideSwap(c.planner!, swap.id, true)).rejects.toBeInstanceOf(ConflictError); // noch nicht zugestimmt
      await respondSwap(c.e3!, swap.id, true);
      await run();
      expect((await titles("planner")).some((t) => t.startsWith("Schichttausch wartet auf Freigabe"))).toBe(true);
      expect((await titles("mgr")).some((t) => t.startsWith("Schichttausch wartet auf Freigabe"))).toBe(true); // direkte Führungskraft von e1
      expect((await titles("mgr2")).some((t) => t.startsWith("Schichttausch wartet auf Freigabe"))).toBe(false);

      await expect(decideSwap(c.e1!, swap.id, true)).rejects.toBeInstanceOf(ForbiddenError); // fehlt die Berechtigung
      await expect(decideSwap(c.mgr2!, swap.id, true)).rejects.toBeInstanceOf(ForbiddenError); // nicht deren Team
      const before = (await db.roster.findUniqueOrThrow({ where: { id: rosterId } })).publishedVersion;
      await decideSwap(c.mgr!, swap.id, true);
      expect((await db.roster.findUniqueOrThrow({ where: { id: rosterId } })).publishedVersion).toBe(before + 1);
      expect((await listMyShifts(c.e3!, new Date(0))).map((x) => x.shiftId)).toContain(sh);
      expect((await listMyShifts(c.e1!, new Date(0))).map((x) => x.shiftId)).not.toContain(sh);
      await expect(decideSwap(c.mgr!, swap.id, true)).rejects.toBeInstanceOf(ConflictError);
      await run();
      expect((await titles("e1")).includes("Schichttausch genehmigt")).toBe(true);
    });

    it("Kollegin kann nicht zusagen, wenn die Schicht gegen Regeln verstößt; Ablehnung und Abbruch", async () => {
      // e2 arbeitet 12:00–20:30 am selben Tag → Überschneidung mit der getauschten Schicht 08:00–16:30
      const swap = await requestSwap(c.e3!, { shiftId: sh, toEmployeeId: emp.e2 });
      await expect(respondSwap(c.e2!, swap.id, true)).rejects.toThrow(/nicht übernehmen.*Überschneidende/);
      await respondSwap(c.e2!, swap.id, false);
      await run();
      expect((await titles("e3")).some((t) => t.includes("abgelehnt"))).toBe(true);

      const again = await requestSwap(c.e3!, { shiftId: sh, toEmployeeId: emp.e4 });
      await expect(cancelSwap(c.e4!, again.id)).rejects.toBeInstanceOf(ForbiddenError);
      await cancelSwap(c.e3!, again.id);
      await expect(cancelSwap(c.e3!, again.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("Freigabe nicht möglich, solange der Plan unveröffentlichte Änderungen hat; Beteiligte dürfen nicht selbst freigeben", async () => {
      const swap = await requestSwap(c.e3!, { shiftId: sh, toEmployeeId: emp.e4 });
      await respondSwap(c.e4!, swap.id, true);
      await shift(rosterId, plus(W, 5), "08:00", "16:30"); // Arbeitskopie ändern
      await expect(decideSwap(c.planner!, swap.id, true)).rejects.toThrow(/unveröffentlichte Änderungen/);
      const lst = await listSwaps(c.planner!);
      expect(lst.approvable.map((s) => s.id)).toContain(swap.id); // Zustand zurückgerollt, weiterhin offen
      await publishRoster(c.planner!, rosterId);
      await decideSwap(c.planner!, swap.id, false);
      expect((await db.shiftSwapRequest.findUniqueOrThrow({ where: { id: swap.id } })).status).toBe("REJECTED");
    });
  });
});

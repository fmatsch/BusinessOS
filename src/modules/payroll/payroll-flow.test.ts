import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createEmployee } from "@/modules/hr/service";
import { createExport, getExportFile, getProfile, listExports, previewExport, setProfile } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;

const now0 = new Date();
const PM = now0.getUTCMonth() === 0 ? { year: now0.getUTCFullYear() - 1, month: 12 } : { year: now0.getUTCFullYear(), month: now0.getUTCMonth() };
const ym = { year: PM.year, month: PM.month };
const pad = (n: number) => String(n).padStart(2, "0");
const first = `${PM.year}-${pad(PM.month)}-01`;

const CODES = { NORMAL: "1000", MEHRZEIT: "2000", NIGHT: "3000", SUNDAY: "3100", HOLIDAY: "3200", VACATION: "9000", SICK: "9100", CARE: "9200", SPECIAL: "9300" };
const PROFILE = { delimiter: ";", decimalSeparator: ",", includeHeader: true, encoding: "utf8-bom", unit: "HOURS", includeSurcharge: true, codes: CODES };

function summary(worked: number, target: number, night = 0, sunday = 0, holiday = 0, missingDays = 0) {
  return {
    year: PM.year, month: PM.month, workedMinutes: worked, targetMinutes: target, deltaMinutes: worked - target, coveredDays: 20,
    categories: { night, sunday, holiday, overtime: Math.max(0, worked - target) },
    days: Array.from({ length: missingDays }, (_, i) => ({ date: `${first}-${i}`, planned: 480, actual: 0, delta: -480, absence: false, flag: "MISSING" })),
    hints: [],
  };
}

describe.skipIf(!hasDb)("Lohn-Export", () => {
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
  async function makeEmployee(label: string, org: string, number: string) {
    emp[label] = (await createEmployee(hrBot(org), { number, firstName: label, lastName: "Test" })).id;
    await db.employment.create({ data: { organizationId: org, employeeId: emp[label]!, validFrom: new Date("2000-01-01T00:00:00Z"), contractType: "FULL_TIME", weeklyHours: 40 } });
  }
  const setPeriod = (who: string, status: "OPEN" | "SUBMITTED" | "APPROVED", s?: ReturnType<typeof summary>) =>
    db.timesheetPeriod.upsert({
      where: { organizationId_employeeId_year_month: { organizationId: orgA, employeeId: emp[who]!, ...ym } },
      create: { organizationId: orgA, employeeId: emp[who]!, ...ym, status, summary: s ?? undefined },
      update: { status, summary: s ?? undefined },
    });
  const lineMap = (pv: Awaited<ReturnType<typeof previewExport>>, who: string) =>
    Object.fromEntries((pv.employees.find((e) => e.employeeId === emp[who])?.lines ?? []).map((l) => [l.wageType, l.quantity]));

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Payroll" } })).id;
    orgA = await makeOrg("TEST-PA-A");
    orgB = await makeOrg("TEST-PA-B");
    for (const [l, r] of [["hr", "hr"], ["fin", "finance"], ["mgr", "manager"], ["e1", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "hrB", "hr");
    await makeEmployee("e1", orgA, "P101"); await makeEmployee("e2", orgA, "P102"); await makeEmployee("e3", orgA, "P103");
    await makeEmployee("hrB", orgB, "B001");
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["auditLog", "payrollExportLine", "payrollExport", "payrollProfile", "payCodeRule", "absenceRequest", "absenceType", "timesheetPeriod", "employment", "employee", "approvalPolicy"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: ids } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: ids } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Berechtigungen: lesen Personalwesen und Finanzen; erzeugen und Profil nur Personalwesen; sonst nichts", async () => {
    await expect(previewExport(c.mgr!, ym)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewExport(c.e1!, ym)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listExports(c.mgr!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createExport(c.fin!, { ...ym, acceptIncomplete: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setProfile(c.fin!, PROFILE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewExport(c.fin!, ym)).resolves.toBeDefined();
    expect((await getProfile(c.fin!)).delimiter).toBe(";"); // Voreinstellung
  });

  it("Profil: Validierung (Trennzeichen ≠ Dezimalzeichen, Lohnart-Zeichen) und Speichern", async () => {
    await expect(setProfile(c.hr!, { ...PROFILE, delimiter: ",", decimalSeparator: "," })).rejects.toThrow(/verschieden/);
    await expect(setProfile(c.hr!, { ...PROFILE, codes: { ...CODES, NORMAL: "10;00" } })).rejects.toThrow(/Lohnart/);
    await expect(setProfile(c.hr!, { ...PROFILE, delimiter: "x" })).rejects.toThrow();
  });

  it("Vorschau: ohne Lohnart-Zuordnung blockiert; freigegebene Monate werden zu Zeilen, offene sind unvollständig", async () => {
    await setPeriod("e1", "APPROVED", summary(9600, 9000, 450, 480, 0, 2)); // 160 h gearbeitet, Soll 150 h
    await setPeriod("e2", "SUBMITTED");
    const type = await db.absenceType.create({ data: { organizationId: orgA, key: "VACATION", name: "Urlaub", deductsLeave: true } });
    // zwei Urlaubstage (Mo–Di) irgendwo in der Monatsmitte
    const monday = new Date(`${first}T00:00:00Z`);
    while (monday.getUTCDay() !== 1 || monday.getUTCDate() < 8) monday.setUTCDate(monday.getUTCDate() + 1);
    const tuesday = new Date(monday.getTime() + 86_400_000);
    await db.absenceRequest.create({ data: { organizationId: orgA, employeeId: emp.e1!, typeId: type.id, startDate: monday, endDate: tuesday, days: 2, status: "APPROVED" } });

    const pv = await previewExport(c.hr!, ym);
    expect(pv.nextVersion).toBe(1);
    expect(pv.checks.some((x) => x.severity === "ERROR" && /Lohnart-Zuordnung/.test(x.message))).toBe(true);
    expect(lineMap(pv, "e1")).toMatchObject({ NORMAL: 9000, MEHRZEIT: 600, NIGHT: 450, SUNDAY: 480 });
    expect(Object.keys(lineMap(pv, "e1")).includes("HOLIDAY")).toBe(false); // 0 wird nicht ausgegeben
    expect(pv.employees.find((e) => e.employeeId === emp.e1)!.lines.find((l) => l.wageType === "NIGHT")!.percent).toBe(25);
    expect(pv.employees.find((e) => e.employeeId === emp.e1)!.lines.find((l) => l.wageType === "MEHRZEIT")!.percent).toBe(50);
    expect(pv.incomplete.map((i) => [i.number, i.reason]).sort()).toEqual([["P102", "Monat eingereicht, noch nicht freigegeben"], ["P103", "Monat nicht eingereicht"]]);
    expect(pv.checks.some((x) => /2 geplante Arbeitstage ohne Zeitbuchung/.test(x.message))).toBe(true);
    expect(pv.employees.find((e) => e.employeeId === emp.e1)!.lines.find((l) => l.wageType === "VACATION")?.quantity).toBe(2);
    await expect(createExport(c.hr!, { ...ym, acceptIncomplete: true })).rejects.toThrow(/Lohnart-Zuordnung/);
  });

  it("Export: Monat muss abgeschlossen sein; Unvollständige nur nach Bestätigung; Datei, Hash und Zeilen", async () => {
    await setProfile(c.hr!, PROFILE);
    await expect(createExport(c.hr!, ym, new Date(Date.UTC(PM.year, PM.month - 1, 15)))).rejects.toThrow(/noch nicht abgeschlossen/);
    await expect(createExport(c.hr!, { ...ym, acceptIncomplete: false })).rejects.toThrow(/keinen freigegebenen Monat/);

    const e = await createExport(c.hr!, { ...ym, acceptIncomplete: true });
    expect(e.version).toBe(1);
    expect(e.fileName).toBe(`lohnexport-${PM.year}-${pad(PM.month)}-erstexport.csv`);
    const lines = e.content.split("\r\n");
    const period = `${PM.year}-${pad(PM.month)}`;
    expect(lines[0]).toBe("Personalnummer;Zeitraum;Lohnart;Bezeichnung;Menge;Einheit;Zuschlag %;Lauf");
    expect(lines).toContain(`P101;${period};1000;Normalarbeitszeit;150,00;Std;;1`);
    expect(lines).toContain(`P101;${period};2000;Mehrzeit über Soll;10,00;Std;50;1`);
    expect(lines).toContain(`P101;${period};3000;Nachtarbeit (Zuschlagsbasis);7,50;Std;25;1`);
    expect(lines).toContain(`P101;${period};9000;Urlaub;2;Tage;;1`);
    expect(lines.filter((l) => l.startsWith("P102") || l.startsWith("P103"))).toEqual([]); // unvollständige Mitarbeiter fehlen
    expect(e.lineCount).toBe(lines.filter((l) => l.startsWith("P101")).length);
    expect((e.excluded as unknown[]).length).toBe(2);

    const file = await getExportFile(c.fin!, e.id); // Finanzen darf lesen
    expect([...file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM
    expect(file.fileName).toBe(e.fileName);
    expect(await db.payrollExportLine.count({ where: { exportId: e.id } })).toBe(e.lineCount);
    expect((await db.auditLog.findMany({ where: { organizationId: orgA, action: { in: ["payroll.export", "payroll.download"] } } })).map((a) => a.action).sort()).toEqual(["payroll.download", "payroll.export"]);

    // unveränderlich
    await expect(db.payrollExport.update({ where: { id: e.id }, data: { content: "x" } })).rejects.toThrow(/append-only/);
    await expect(db.payrollExport.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
    const line = (await db.payrollExportLine.findFirst({ where: { exportId: e.id } }))!;
    await expect(db.payrollExportLine.update({ where: { id: line.id }, data: { quantity: 1 } })).rejects.toThrow(/append-only/);
    await expect(db.payrollExportLine.delete({ where: { id: line.id } })).rejects.toThrow(/append-only/);
  });

  it("direkt danach: keine Änderungen, kein zweiter Lauf; parallele Aufrufe erzeugen höchstens einen Lauf", async () => {
    await expect(createExport(c.hr!, { ...ym, acceptIncomplete: true })).rejects.toThrow(/keine Änderungen/);
    expect((await previewExport(c.hr!, ym)).checks.some((x) => /Keine Änderungen|bereits 1 Lauf/.test(x.message))).toBe(true);
    // Änderung herstellen und zweimal gleichzeitig exportieren
    await setPeriod("e1", "APPROVED", summary(9660, 9000, 450, 480, 0, 2)); // +60 Minuten
    const r = await Promise.allSettled([createExport(c.hr!, { ...ym, acceptIncomplete: true }), createExport(c.hr!, { ...ym, acceptIncomplete: true })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.payrollExport.count({ where: { organizationId: orgA, ...ym } })).toBe(2);
  });

  it("Nachtrag enthält nur Differenzen; Erstexport + Nachträge = aktueller Stand; später freigegebene Mitarbeiter folgen vollständig", async () => {
    const runs = await db.payrollExport.findMany({ where: { organizationId: orgA, ...ym }, orderBy: { version: "asc" } });
    expect(runs[1]!.fileName).toBe(`lohnexport-${PM.year}-${pad(PM.month)}-nachtrag1.csv`);
    const v2 = runs[1]!.content.split("\r\n").filter((l) => l.startsWith("P1"));
    expect(v2).toEqual([`P101;${PM.year}-${pad(PM.month)};2000;Mehrzeit über Soll;1,00;Std;50;2`]); // nur +60 Minuten Mehrzeit

    // Korrektur nach unten: negative Menge
    await setPeriod("e1", "APPROVED", summary(9600, 9000, 450, 480, 0, 2));
    const down = await createExport(c.hr!, { ...ym, acceptIncomplete: true });
    expect(down.content).toContain(";-1,00;Std;50;3");
    // e2 wird später freigegeben → vollständige Mengen im nächsten Lauf
    await setPeriod("e2", "APPROVED", summary(8000, 8000));
    const v4 = await createExport(c.hr!, { ...ym, acceptIncomplete: true });
    expect(v4.content.split("\r\n").filter((l) => l.startsWith("P102")).length).toBe(1);
    expect(v4.content).toContain(`P102;${PM.year}-${pad(PM.month)};1000;Normalarbeitszeit;133,33;Std;;4`);
    expect(v4.content).not.toContain("P101");

    // Summe über alle Läufe je Lohnart = aktueller Stand
    const sums = await db.payrollExportLine.groupBy({ by: ["employeeId", "wageType"], where: { organizationId: orgA, export: ym }, _sum: { quantity: true } });
    const e1 = Object.fromEntries(sums.filter((s) => s.employeeId === emp.e1).map((s) => [s.wageType, s._sum.quantity]));
    expect(e1).toMatchObject({ NORMAL: 9000, MEHRZEIT: 600, NIGHT: 450, SUNDAY: 480, VACATION: 2 });
  });

  it("nach dem Export wieder geöffneter Monat: Person ist unvollständig und nicht im Lauf", async () => {
    await setPeriod("e1", "OPEN");
    const pv = await previewExport(c.hr!, ym);
    expect(pv.incomplete.find((i) => i.employeeId === emp.e1)?.reason).toBe("Monat nach dem Export wieder geöffnet");
    expect(pv.employees.find((e) => e.employeeId === emp.e1)).toBeUndefined();
  });

  it("Zeichensatz Latin-1 aus dem Profil wird beim Abruf angewendet (Umlaut = 1 Byte)", async () => {
    await setProfile(c.hr!, { ...PROFILE, encoding: "latin1", delimiter: "|" });
    await setPeriod("e3", "APPROVED", summary(9000, 8000));
    const e = await createExport(c.hr!, { ...ym, acceptIncomplete: true });
    const bytes = (await getExportFile(c.hr!, e.id)).bytes;
    expect(bytes.includes(0xfc)).toBe(true); // „Mehrzeit über Soll"
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(e.content.split("\r\n")[0]).toContain("|");
    await setProfile(c.hr!, PROFILE);
  });

  it("Mandantentrennung: andere Organisation sieht keine Läufe, Dateien und Profile", async () => {
    const run = (await db.payrollExport.findFirst({ where: { organizationId: orgA } }))!;
    await expect(getExportFile(c.hrB!, run.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listExports(c.hrB!)).toEqual([]);
    expect((await getProfile(c.hrB!)).codes).toEqual({});
    const pv = await previewExport(c.hrB!, ym);
    expect(pv.employees).toEqual([]);
    expect(pv.incomplete.map((i) => i.number)).toEqual(["B001"]);
  });

  it("Eingaben: ungültiger Monat wird abgelehnt", async () => {
    await expect(previewExport(c.hr!, { year: 2026, month: 13 })).rejects.toThrow();
    await expect(createExport(c.hr!, { year: 1999, month: 1 })).rejects.toThrow();
    await expect(createExport(c.hr!, { year: PM.year - 5, month: 1, acceptIncomplete: true })).rejects.toBeInstanceOf(ConflictError); // keine Änderungen
  });
});

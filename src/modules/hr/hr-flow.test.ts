import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { listNotifications } from "@/platform/notifications/service";
import { createDepartment } from "@/modules/masterdata/service";
import { runOutbox } from "@/modules/events";
import {
  addEmployment, addLeaveEntry, cancelAbsence, closeEmployment, createEmployee, decideAbsence, getEmployee, leaveBalance,
  listAbsences, listEmployees, listEmployments, listLeaveEntries, listPendingAbsenceApprovals, readSensitive, requestAbsence,
  updateEmployee, writeSensitive,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const Y = new Date().getFullYear() + 1; // zukünftiges Jahr: Stornos „vor Beginn" sind erlaubt
const MON = `${Y}-03-01`; // Montag? wird unten geprüft
function mondayOf(year: number, month: number, week = 0) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * week);
  return d.toISOString().slice(0, 10);
}
const plus = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
void MON;

describe.skipIf(!hasDb)("HR-Basis: Mitarbeiter, Beschäftigung, Urlaub, Abwesenheiten", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const emp: Record<string, string> = {}; // Label -> Employee-ID
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
  const hrOf = (org: string) => (org === orgA ? c.hr! : c.hrB!);
  async function makeEmployee(label: string, ctx: Ctx, managerLabel?: string, linkUser = true) {
    const e = await createEmployee(ctx, {
      number: label.toUpperCase(), firstName: label, lastName: "Test", userId: linkUser ? c[label]?.userId : null,
      managerId: managerLabel ? emp[managerLabel] : null,
    });
    emp[label] = e.id;
  }
  const entitle = (employee: string, year: number, days: string) => addLeaveEntry(c.hr!, { employeeId: emp[employee], year, kind: "ENTITLEMENT", days });
  const request = (who: string, from: string, to: string, typeKey = "VACATION") => requestAbsence(c[who]!, { typeKey, startDate: from, endDate: to });
  const titles = async (who: string) => (await listNotifications(c[who]!)).map((n) => n.title);

  beforeAll(async () => {
    expect(new Date(`${mondayOf(Y, 3)}T00:00:00Z`).getUTCDay()).toBe(1);
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-HR" } })).id;
    orgA = await makeOrg("TEST-HR-A");
    orgB = await makeOrg("TEST-HR-B");
    for (const [l, r] of [["hr", "hr"], ["mgr", "manager"], ["mgr2", "manager"], ["e1", "employee"], ["e2", "employee"], ["e3", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "hrB", "hr");
    await makeEmployee("hr", c.hr!);
    await makeEmployee("mgr", c.hr!);
    await makeEmployee("mgr2", c.hr!);
    await makeEmployee("e1", c.hr!, "mgr");
    await makeEmployee("e2", c.hr!, "mgr2");
    await makeEmployee("e3", c.hr!, undefined, false); // ohne Benutzerkonto
    await makeEmployee("hrB", c.hrB!);
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`; // nur für das Aufräumen von Testdaten
      for (const m of ["notification", "outboxEvent", "auditLog", "leaveBalanceEntry", "absenceRequest", "employee", "approvalPolicy", "absenceType", "department"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: ids } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: ids } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  describe("Mitarbeiterverzeichnis", () => {
    it("Anlegen/Ändern nur mit hr.employee.write; Verzeichnis nur mit hr.employee.read", async () => {
      await expect(createEmployee(c.e1!, { number: "X", firstName: "a", lastName: "b" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listEmployees(c.e1!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateEmployee(c.mgr!, emp.e1!, { firstName: "x", lastName: "y" })).rejects.toBeInstanceOf(ForbiddenError);
      expect((await listEmployees(c.mgr!)).length).toBeGreaterThanOrEqual(6);
    });
    it("Personalnummer ist je Organisation eindeutig", async () => {
      await expect(createEmployee(c.hr!, { number: "E1", firstName: "Dup", lastName: "Dup" })).rejects.toThrow();
    });
    it("Mitarbeiter sieht nur das eigene Profil", async () => {
      expect((await getEmployee(c.e1!, emp.e1!)).lastName).toBe("Test");
      await expect(getEmployee(c.e1!, emp.e2!)).rejects.toBeInstanceOf(ForbiddenError);
    });
    it("Hierarchie ohne Zyklen; Verweise nur innerhalb der Organisation", async () => {
      await expect(updateEmployee(c.hr!, emp.mgr!, { firstName: "mgr", lastName: "Test", managerId: emp.e1 })).rejects.toBeInstanceOf(ConflictError); // e1 -> mgr -> e1
      await expect(updateEmployee(c.hr!, emp.mgr!, { firstName: "mgr", lastName: "Test", managerId: emp.mgr })).rejects.toBeInstanceOf(ConflictError); // selbst
      await expect(createEmployee(c.hr!, { number: "FOREIGN", firstName: "a", lastName: "b", managerId: emp.hrB })).rejects.toBeInstanceOf(NotFoundError);
      await expect(createEmployee(c.hr!, { number: "FOREIGN2", firstName: "a", lastName: "b", departmentId: "gibt-es-nicht" })).rejects.toBeInstanceOf(NotFoundError);
      const dept = await createDepartment({ ...c.hr!, permissions: new Set(PERMISSIONS) as Ctx["permissions"] }, { code: "D", name: "Abt" });
      await expect(updateEmployee(c.hrB!, emp.hrB!, { firstName: "hrB", lastName: "Test", departmentId: dept.id })).rejects.toBeInstanceOf(NotFoundError);
    });
    it("Mandantentrennung", async () => {
      await expect(getEmployee(c.hrB!, emp.e1!)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listEmployees(c.hrB!)).map((e) => e.number)).toEqual(["HRB"]);
      await expect(updateEmployee(c.hrB!, emp.e1!, { firstName: "x", lastName: "y" })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("Sensible Daten", () => {
    it("Schreiben/Lesen nur mit Sonderrecht; Lesezugriffe werden protokolliert; Inhalte stehen nicht im Audit-Log", async () => {
      await writeSensitive(c.hr!, emp.e1!, { birthDate: "1990-05-17", addressLine: "Teststraße 1", phone: "+43 000 TESTTELEFON", emergencyContact: "" });
      await expect(writeSensitive(c.mgr!, emp.e1!, { phone: "1" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(readSensitive(c.mgr!, emp.e1!)).rejects.toBeInstanceOf(ForbiddenError); // auch nicht die Führungskraft
      await expect(readSensitive(c.e2!, emp.e1!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(readSensitive(c.hrB!, emp.e1!)).rejects.toBeInstanceOf(NotFoundError);

      const own = await readSensitive(c.e1!, emp.e1!); // eigene Daten
      expect(own).toMatchObject({ birthDate: "1990-05-17", addressLine: "Teststraße 1", emergencyContact: null });
      const hrRead = await readSensitive(c.hr!, emp.e1!);
      expect(hrRead.phone).toContain("TESTTELEFON");

      const logs = await db.auditLog.findMany({ where: { organizationId: orgA, entityId: emp.e1!, action: { in: ["employee.read_sensitive", "employee.write_sensitive"] } } });
      expect(logs.filter((l) => l.action === "employee.read_sensitive")).toHaveLength(2);
      expect(JSON.stringify(logs)).not.toContain("TESTTELEFON");
      expect(JSON.stringify(logs)).not.toContain("1990-05-17");
    });
    it("Geburtsdatum muss in der Vergangenheit liegen", async () => {
      await expect(writeSensitive(c.hr!, emp.e1!, { birthDate: "2999-01-01" })).rejects.toThrow();
    });
  });

  describe("Beschäftigungsverhältnisse", () => {
    it("keine Überschneidungen, Anschluss erlaubt, Beenden, Validierung, Sichtbarkeit", async () => {
      const base = { employeeId: emp.e1, contractType: "FULL_TIME", weeklyHours: "38.5" };
      const a = await addEmployment(c.hr!, { ...base, validFrom: "2020-01-01", validTo: "2022-12-31" });
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2022-12-31", validTo: "2023-06-30" })).rejects.toBeInstanceOf(ConflictError);
      await addEmployment(c.hr!, { ...base, validFrom: "2023-01-01", weeklyHours: "20", contractType: "PART_TIME" }); // offen
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2024-01-01" })).rejects.toBeInstanceOf(ConflictError);
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2019-01-01", validTo: "2020-01-01" })).rejects.toBeInstanceOf(ConflictError); // Grenztag
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2018-01-01", validTo: "2017-01-01" })).rejects.toThrow();
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2010-01-01", validTo: "2010-12-31", weeklyHours: "0" })).rejects.toThrow();
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2010-01-01", validTo: "2010-12-31", weeklyHours: "61" })).rejects.toThrow();
      await expect(addEmployment(c.hr!, { ...base, validFrom: "2010-01-01", validTo: "2010-12-31", costCenterId: "gibt-es-nicht" })).rejects.toBeInstanceOf(NotFoundError);

      await expect(closeEmployment(c.hr!, a.id, "2023-01-01")).rejects.toBeInstanceOf(ConflictError); // bereits beendet
      const open = (await listEmployments(c.hr!, emp.e1!)).find((e) => !e.validTo)!;
      await expect(closeEmployment(c.hr!, open.id, "2022-01-01")).rejects.toBeInstanceOf(ConflictError); // vor Beginn
      await closeEmployment(c.hr!, open.id, "2025-12-31");
      expect((await listEmployments(c.e1!, emp.e1!)).length).toBe(2); // eigene Daten
      await expect(listEmployments(c.e2!, emp.e1!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listEmployments(c.mgr!, emp.e1!)).rejects.toBeInstanceOf(ForbiddenError); // Wochenstunden: nur Personal
      await expect(addEmployment(c.mgr!, { ...base, validFrom: "2030-01-01" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addEmployment(c.hrB!, { ...base, validFrom: "2030-01-01" })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("Urlaub und Abwesenheiten", () => {
    const w1 = mondayOf(Y, 3, 0), w1end = plus(w1, 4); // Mo–Fr, 5 Arbeitstage
    const w2 = mondayOf(Y, 3, 1), w2end = plus(w2, 4);
    const w3 = mondayOf(Y, 3, 2), w3end = plus(w3, 4);

    it("Antrag braucht Guthaben und Mitarbeiterprofil; Überschneidungen und leere Zeiträume werden abgelehnt", async () => {
      await expect(request("e1", w1, w1end)).rejects.toBeInstanceOf(ConflictError); // kein Anspruch
      await entitle("e1", Y, "10");
      const a = await request("e1", w1, w1end);
      expect(a.status).toBe("PENDING");
      expect(a.days.toString()).toBe("5");
      const b = await leaveBalance(c.e1!, emp.e1!, Y);
      expect([b.remaining, b.reserved, b.available].map(String)).toEqual(["10", "5", "5"]);

      await expect(request("e1", plus(w1, 2), plus(w1, 9))).rejects.toBeInstanceOf(ConflictError); // überschneidet
      await expect(request("e1", w2, plus(w2, 9))).rejects.toThrow(/Resturlaub reicht nicht/); // 10 > 5 verfügbar
      await expect(request("e1", plus(w1, 5), plus(w1, 6))).rejects.toThrow(/keine Arbeitstage/); // Wochenende
      await expect(request("e1", w2end, w2)).rejects.toThrow(); // Ende vor Beginn
      await expect(requestAbsence(c.e1!, { typeKey: "GIBTSNICHT", startDate: w2, endDate: w2end })).rejects.toBeInstanceOf(NotFoundError);
      await expect(request("e3" as never, w2, w2end)).rejects.toThrow(); // e3 hat kein Benutzerkonto -> kein Ctx
      await cancelAbsence(c.e1!, a.id); // aufräumen für Folgetests
    });

    it("Freigabe nur durch die direkte Führungskraft oder Personal; keine Selbstfreigabe; Abzug im Journal", async () => {
      const a = await request("e1", w1, w1end);
      expect((await listPendingAbsenceApprovals(c.mgr!)).map((x) => x.absenceRequestId)).toContain(a.id);
      expect((await listPendingAbsenceApprovals(c.mgr2!)).map((x) => x.absenceRequestId)).not.toContain(a.id); // fremdes Team
      expect((await listPendingAbsenceApprovals(c.e1!)).length).toBe(0);

      await expect(decideAbsence(c.mgr2!, { absenceId: a.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideAbsence(c.e2!, { absenceId: a.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideAbsence(c.e1!, { absenceId: a.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideAbsence(c.hrB!, { absenceId: a.id, decision: "APPROVE" })).rejects.toBeInstanceOf(NotFoundError);

      expect((await decideAbsence(c.mgr!, { absenceId: a.id, decision: "APPROVE" })).status).toBe("APPROVED");
      const entries = await listLeaveEntries(c.e1!, emp.e1!, Y);
      expect(entries.filter((e) => e.kind === "TAKEN").map((e) => e.days.toString())).toEqual(["-5"]);
      const b = await leaveBalance(c.hr!, emp.e1!, Y);
      expect([b.entitlement, b.taken, b.remaining].map(String)).toEqual(["10", "5", "5"]);
      await expect(decideAbsence(c.mgr!, { absenceId: a.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError); // nicht mehr offen

      // HR darf eigenen Antrag nicht selbst entscheiden
      await addLeaveEntry(c.hr!, { employeeId: emp.hr, year: Y, kind: "ENTITLEMENT", days: "5" });
      const own = await request("hr", w2, w2end);
      await expect(decideAbsence(c.hr!, { absenceId: own.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);
      await cancelAbsence(c.hr!, own.id);
    });

    it("Stornieren: Gegenbuchung statt Löschen; Saldo = Summe des Journals; nur eigene bzw. Personal", async () => {
      const [a] = (await listAbsences(c.e1!, "mine")).filter((x) => x.status === "APPROVED");
      await expect(cancelAbsence(c.e2!, a!.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(cancelAbsence(c.mgr!, a!.id)).rejects.toBeInstanceOf(ForbiddenError); // Führungskraft ohne Personalrecht
      await cancelAbsence(c.e1!, a!.id);
      await expect(cancelAbsence(c.e1!, a!.id)).rejects.toBeInstanceOf(ConflictError);

      const entries = await listLeaveEntries(c.hr!, emp.e1!, Y);
      expect(entries.map((e) => [e.kind, e.days.toString()])).toEqual([["ENTITLEMENT", "10"], ["TAKEN", "-5"], ["REVERSAL", "5"]]);
      const b = await leaveBalance(c.e1!, emp.e1!, Y);
      expect(b.remaining.toString()).toBe("10");
      const sum = entries.reduce((s, e) => s.plus(e.days.toString()), new Decimal(0));
      expect(sum.equals(b.remaining)).toBe(true);
    });

    it("Ablehnung bucht nichts und gibt die Reservierung frei", async () => {
      const a = await request("e1", w2, w2end);
      expect((await leaveBalance(c.e1!, emp.e1!, Y)).available.toString()).toBe("5");
      expect((await decideAbsence(c.mgr!, { absenceId: a.id, decision: "REJECT", comment: "Projektphase" })).status).toBe("REJECTED");
      const b = await leaveBalance(c.e1!, emp.e1!, Y);
      expect([b.remaining, b.reserved, b.available].map(String)).toEqual(["10", "0", "10"]);
    });

    it("Jahreswechsel: Abzug je Kalenderjahr getrennt, Feiertag (6. Jänner) zählt nicht", async () => {
      await addLeaveEntry(c.hr!, { employeeId: emp.e2, year: Y, kind: "ENTITLEMENT", days: "10" });
      await addLeaveEntry(c.hr!, { employeeId: emp.e2, year: Y + 1, kind: "CARRYOVER", days: "10" });
      // Montag der letzten Dezemberwoche bis Freitag der ersten Jännerwoche des Folgejahres
      let dec = new Date(Date.UTC(Y, 11, 27));
      while (dec.getUTCDay() !== 1) dec.setUTCDate(dec.getUTCDate() + 1);
      const from = dec.toISOString().slice(0, 10), to = plus(from, 11);
      const a = await request("e2", from, to);
      await decideAbsence(c.mgr2!, { absenceId: a.id, decision: "APPROVE" });
      const taken = (await db.leaveBalanceEntry.findMany({ where: { absenceRequestId: a.id }, orderBy: { year: "asc" } })).map((e) => [e.year, e.days.toString()]);
      expect(taken.length).toBe(2);
      expect(new Decimal(taken[0]![1]!).abs().plus(new Decimal(taken[1]![1]!).abs()).toString()).toBe(a.days.toString());
      await cancelAbsence(c.hr!, a.id);
      expect((await leaveBalance(c.e2!, emp.e2!, Y)).remaining.toString()).toBe("10");
    });

    it("parallele Anträge überbuchen den Urlaub nicht", async () => {
      await entitle("e3" as never, Y, "5").catch(() => undefined);
      await addLeaveEntry(c.hr!, { employeeId: emp.mgr, year: Y, kind: "ENTITLEMENT", days: "5" });
      const results = await Promise.allSettled([request("mgr", w1, w1end), request("mgr", w3, w3end)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const b = await leaveBalance(c.mgr!, emp.mgr!, Y);
      expect(b.available.toString()).toBe("0");
    });

    it("parallele Entscheidungen: genau eine gewinnt, Abzug nur einmal", async () => {
      await addLeaveEntry(c.hr!, { employeeId: emp.e1, year: Y, kind: "ADJUSTMENT", days: "-5", note: "Test" }); // verfügbar 5
      const a = await request("e1", w3, w3end);
      const r = await Promise.allSettled([
        decideAbsence(c.mgr!, { absenceId: a.id, decision: "APPROVE" }),
        decideAbsence(c.hr!, { absenceId: a.id, decision: "APPROVE" }),
      ]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(await db.leaveBalanceEntry.count({ where: { absenceRequestId: a.id, kind: "TAKEN" } })).toBe(1);
    });

    it("Krankenstand: sofort erfasst, ohne Freigabe und ohne Urlaubsabzug", async () => {
      const before = (await leaveBalance(c.e2!, emp.e2!, Y)).remaining.toString();
      const s = await requestAbsence(c.e2!, { typeKey: "SICK", startDate: mondayOf(Y, 6), endDate: mondayOf(Y, 6), note: "" });
      expect(s.status).toBe("APPROVED");
      expect(await db.approval.count({ where: { absenceRequestId: s.id } })).toBe(0);
      expect((await leaveBalance(c.e2!, emp.e2!, Y)).remaining.toString()).toBe(before);
    });

    it("Sichtbarkeit: mine / team / all", async () => {
      expect((await listAbsences(c.e1!, "mine")).every((x) => x.employee.firstName === "e1")).toBe(true);
      await expect(listAbsences(c.e1!, "team")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listAbsences(c.e1!, "all")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listAbsences(c.mgr!, "all")).rejects.toBeInstanceOf(ForbiddenError);
      expect((await listAbsences(c.mgr!, "team")).every((x) => x.employee.firstName === "e1")).toBe(true);
      expect((await listAbsences(c.hr!, "all")).length).toBeGreaterThan(2);
      expect(await listAbsences(c.hrB!, "all")).toEqual([]); // andere Organisation
      await expect(leaveBalance(c.e1!, emp.e2!, Y)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(leaveBalance(c.mgr!, emp.e2!, Y)).rejects.toBeInstanceOf(ForbiddenError); // anderes Team
      await expect(addLeaveEntry(c.hrB!, { employeeId: emp.e1, year: Y, kind: "ENTITLEMENT", days: "1" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("Benachrichtigungen: direkte Führungskraft und Personal, nicht fremde Führungskräfte; Entscheidung an Antragsteller", async () => {
      await addLeaveEntry(c.hr!, { employeeId: emp.e1, year: Y, kind: "ADJUSTMENT", days: "20" });
      const w = mondayOf(Y, 9);
      const a = await request("e1", w, plus(w, 1));
      await runOutbox({ organizationId: orgA, batch: 500 }); // solange der Antrag offen ist, gehen Freigabe-Hinweise raus
      expect((await titles("mgr")).some((t) => t.startsWith("Abwesenheitsantrag: e1"))).toBe(true);
      expect((await titles("hr")).some((t) => t.startsWith("Abwesenheitsantrag: e1"))).toBe(true);
      expect((await titles("mgr2")).some((t) => t.startsWith("Abwesenheitsantrag: e1"))).toBe(false);
      expect((await titles("e1")).some((t) => t.startsWith("Abwesenheitsantrag"))).toBe(false);
      await decideAbsence(c.mgr!, { absenceId: a.id, decision: "APPROVE" });
      await runOutbox({ organizationId: orgA, batch: 500 });
      expect((await titles("e1")).some((t) => t === "Urlaub genehmigt")).toBe(true);
      expect((await titles("mgr2")).some((t) => t.startsWith("Krankenstand gemeldet: e2"))).toBe(true);
      expect((await titles("hrB"))).toEqual([]);
    });

    it("Urlaubsjournal ist unveränderlich (Datenbank-Trigger)", async () => {
      const e = (await db.leaveBalanceEntry.findFirst({ where: { organizationId: orgA } }))!;
      await expect(db.leaveBalanceEntry.update({ where: { id: e.id }, data: { days: 999 } })).rejects.toThrow(/append-only/);
      await expect(db.leaveBalanceEntry.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
      expect(await db.leaveBalanceEntry.count({ where: { id: e.id } })).toBe(1);
    });
  });
});

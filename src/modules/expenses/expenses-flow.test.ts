import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import {
  addExpenseLine, cancelExpenseReport, createExpenseReport, decideExpenseReport, getExpenseReceipt, getExpenseReport, getMileageRate, listExpenseReports,
  listPendingExpenseApprovals, markExpensePaid, removeExpenseLine, setMileageRate, submitExpenseReport,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const dayIso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const pdf = { name: "beleg.pdf", bytes: new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n") };

describe.skipIf(!hasDb)("Spesenabrechnung", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];
  const emps: Record<string, string> = {};

  async function makeOrg(name: string) {
    const org = await db.organization.create({ data: { tenantId, name } });
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await db.role.create({ data: { organizationId: org.id, key, name: def.name, system: true } });
      const perms = await db.permission.findMany({ where: { key: { in: [...def.permissions] } } });
      await db.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
    return org.id;
  }
  async function makeUser(org: string, label: string, role: RoleKey, opts: { employee?: boolean; managerOf?: string } = {}) {
    const user = await db.user.create({ data: { email: `${label}-${org}@test.invalid`, name: label, passwordHash: await bcrypt.hash("x", 4) } });
    userIds.push(user.id);
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    if (opts.employee !== false) emps[label] = (await db.employee.create({ data: { organizationId: org, number: `E-${label}`, firstName: label, lastName: "Test", userId: user.id } })).id;
    c[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
  }
  const report = (who = "emp", extra: Record<string, unknown> = {}) => createExpenseReport(c[who]!, { title: "Kundentermin Graz", ...extra });
  const line = (reportId: string, extra: Record<string, unknown> = {}, receipt: typeof pdf | null = null, who = "emp") =>
    addExpenseLine(c[who]!, { reportId, date: dayIso(-1), category: "TRAVEL", description: "Bahnticket", amount: "120", ...extra }, receipt);
  const submitted = async (amount = "120", who = "emp") => { const r = await report(who); await line(r.id, { amount }, pdf, who); await submitExpenseReport(c[who]!, r.id); return r; };

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Expenses" } })).id;
    orgA = await makeOrg("TEST-EX-A");
    orgB = await makeOrg("TEST-EX-B");
    await makeUser(orgA, "mgr", "manager");
    await makeUser(orgA, "mgr2", "manager");
    await makeUser(orgA, "emp", "employee");
    await makeUser(orgA, "emp2", "employee");
    await makeUser(orgA, "fin", "finance");
    await makeUser(orgA, "noprofile", "employee", { employee: false });
    await db.employee.update({ where: { id: emps.emp! }, data: { managerId: emps.mgr! } });
    await makeUser(orgB, "finB", "finance");
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["auditLog", "expenseReport", "expenseSettings", "approvalPolicy", "financeFile", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.employee.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Positionen: Prüfungen, Kilometergeld nach einstellbarem Satz, Beleg nach Inhaltsprüfung, Summe", async () => {
    await expect(createExpenseReport(c.noprofile!, { title: "x" })).rejects.toThrow(/Mitarbeiterprofil/);
    await expect(report("emp", { tripFrom: "2027-03-02", tripTo: "2027-03-01" })).rejects.toThrow(/Reiseende/);
    const r = await report("emp", { tripFrom: dayIso(-5), tripTo: dayIso(-1) });
    await expect(line(r.id, { date: dayIso(1) })).rejects.toThrow(/Zukunft/);
    await expect(line(r.id, { date: dayIso(-9) })).rejects.toThrow(/Reisebeginn/);
    await expect(line(r.id, { amount: "10001" })).rejects.toThrow();
    await expect(line(r.id, { amount: "0" })).rejects.toThrow();
    await expect(line(r.id, {}, { name: "x.pdf", bytes: new TextEncoder().encode("kein pdf") })).rejects.toThrow(/PDF/);
    await expect(line("fremd")).rejects.toBeInstanceOf(NotFoundError);
    await expect(line(r.id, {}, null, "emp2")).rejects.toBeInstanceOf(ForbiddenError); // nicht die eigene Abrechnung

    const a = await line(r.id, {}, pdf);
    expect(String(a.amount)).toBe("120");
    expect((await getMileageRate(c.emp!)).toString()).toBe("0.5");
    const km = await line(r.id, { category: "MILEAGE", description: "Graz retour", amount: "100" });
    expect(String(km.amount)).toBe("50");
    await expect(setMileageRate(c.emp!, "0.42")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setMileageRate(c.fin!, "0")).rejects.toThrow();
    await setMileageRate(c.fin!, "0.42");
    const km2 = await line(r.id, { category: "MILEAGE", description: "Rückfahrt", amount: "100" });
    expect(String(km2.amount)).toBe("42"); // neuer Satz gilt für neue Positionen
    expect(String((await getExpenseReport(c.emp!, r.id)).totalAmount)).toBe("212");
    await removeExpenseLine(c.emp!, km2.id);
    expect(String((await getExpenseReport(c.emp!, r.id)).totalAmount)).toBe("170");
    await expect(removeExpenseLine(c.emp2!, km.id)).rejects.toBeInstanceOf(ForbiddenError);
    await setMileageRate(c.fin!, "0.5");
  });

  it("Einreichen: Nummer, danach unveränderlich; Freigabe nur durch die direkte Führungskraft", async () => {
    const empty = await report();
    await expect(submitExpenseReport(c.emp!, empty.id)).rejects.toThrow(/keine Positionen/);
    const r = await report();
    const l = await line(r.id, {}, pdf);
    await expect(submitExpenseReport(c.emp2!, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    const number = await submitExpenseReport(c.emp!, r.id);
    expect(number).toMatch(/^EX-\d{4}-\d{4}$/);
    await expect(submitExpenseReport(c.emp!, r.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(line(r.id)).rejects.toThrow(/nur im Entwurf/);
    await expect(removeExpenseLine(c.emp!, l.id)).rejects.toThrow(/nur im Entwurf/);

    expect((await listPendingExpenseApprovals(c.mgr!)).map((a) => a.expenseReportId)).toContain(r.id);
    expect((await listPendingExpenseApprovals(c.mgr2!)).map((a) => a.expenseReportId)).not.toContain(r.id); // nicht ihr Team
    expect((await listPendingExpenseApprovals(c.emp!)).length).toBe(0);
    await expect(decideExpenseReport(c.emp!, { reportId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideExpenseReport(c.fin!, { reportId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError); // Stufe „Führungskraft“
    await expect(decideExpenseReport(c.mgr2!, { reportId: r.id, decision: "APPROVE" })).rejects.toThrow(/direkte Führungskraft/);
    await expect(decideExpenseReport(c.finB!, { reportId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await decideExpenseReport(c.mgr!, { reportId: r.id, decision: "APPROVE" })).toEqual({ status: "APPROVED" });
    await expect(decideExpenseReport(c.mgr!, { reportId: r.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);

    await expect(markExpensePaid(c.mgr!, { reportId: r.id, paidOn: dayIso(0) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markExpensePaid(c.fin!, { reportId: r.id, paidOn: dayIso(1) })).rejects.toThrow(/Zukunft/);
    await markExpensePaid(c.fin!, { reportId: r.id, paidOn: dayIso(0) });
    await expect(markExpensePaid(c.fin!, { reportId: r.id, paidOn: dayIso(0) })).rejects.toBeInstanceOf(ConflictError);
    expect((await getExpenseReport(c.fin!, r.id)).status).toBe("PAID");
    await expect(cancelExpenseReport(c.emp!, r.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("Betrag über der Regelgrenze braucht zusätzlich Finanzen; Ablehnung braucht Begründung", async () => {
    const big = await submitted("1500");
    expect(await decideExpenseReport(c.mgr!, { reportId: big.id, decision: "APPROVE" })).toEqual({ status: "SUBMITTED" });
    await expect(decideExpenseReport(c.mgr!, { reportId: big.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError); // zweite Stufe: Finanzen
    expect((await listPendingExpenseApprovals(c.fin!)).map((a) => a.expenseReportId)).toContain(big.id);
    expect(await decideExpenseReport(c.fin!, { reportId: big.id, decision: "APPROVE" })).toEqual({ status: "APPROVED" });

    const r = await submitted("80");
    await expect(decideExpenseReport(c.mgr!, { reportId: r.id, decision: "REJECT" })).rejects.toThrow(/Begründung/);
    expect(await decideExpenseReport(c.mgr!, { reportId: r.id, decision: "REJECT", comment: "Beleg fehlt" })).toEqual({ status: "REJECTED" });
    await expect(markExpensePaid(c.fin!, { reportId: r.id, paidOn: dayIso(0) })).rejects.toBeInstanceOf(ConflictError);
  });

  it("Sichtbarkeit: eigene, Team, alle (Finanzen); Belege nur für Berechtigte; Mandantentrennung", async () => {
    const r = await submitted();
    const l = (await getExpenseReport(c.emp!, r.id)).lines[0]!;
    expect((await getExpenseReport(c.mgr!, r.id)).employeeName).toContain("emp");
    expect((await getExpenseReport(c.fin!, r.id)).isOwn).toBe(false);
    await expect(getExpenseReport(c.emp2!, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getExpenseReport(c.mgr2!, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getExpenseReport(c.finB!, r.id)).rejects.toBeInstanceOf(NotFoundError);
    for (const who of ["emp", "mgr", "fin"]) expect((await getExpenseReceipt(c[who]!, l.id)).mime).toBe("application/pdf");
    for (const who of ["emp2", "mgr2", "finB"]) await expect(getExpenseReceipt(c[who]!, l.id)).rejects.toBeInstanceOf(NotFoundError);

    expect((await listExpenseReports(c.emp!, "mine")).every((x) => x.employeeId === emps.emp)).toBe(true);
    expect((await listExpenseReports(c.emp2!, "mine")).length).toBe(0);
    expect((await listExpenseReports(c.mgr!, "team")).some((x) => x.id === r.id)).toBe(true);
    expect((await listExpenseReports(c.mgr2!, "team")).length).toBe(0);
    expect((await listExpenseReports(c.fin!, "all")).length).toBeGreaterThan(2);
    await expect(listExpenseReports(c.emp!, "all")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listExpenseReports(c.finB!, "all").then((x) => x.length)).resolves.toBe(0);
    // Entwürfe sieht das Team nicht
    const draft = await report();
    expect((await listExpenseReports(c.mgr!, "team")).some((x) => x.id === draft.id)).toBe(false);
  });

  it("Zurückziehen: Entwurf und eingereichte Abrechnung, nicht freigegebene", async () => {
    const d = await report();
    await cancelExpenseReport(c.emp!, d.id);
    await expect(cancelExpenseReport(c.emp2!, d.id)).rejects.toBeInstanceOf(ForbiddenError);
    const s = await submitted();
    await cancelExpenseReport(c.emp!, s.id);
    await expect(decideExpenseReport(c.mgr!, { reportId: s.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);
    expect((await getExpenseReport(c.emp!, s.id)).status).toBe("CANCELLED");
  });
});

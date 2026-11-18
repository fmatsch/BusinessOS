import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError } from "@/platform/errors";
import { createEmployee } from "@/modules/hr/service";
import { approveRun, cancelRun, createParamSet, createRun, discardRun, getRun, listPayrollTerms, listRuns, myPayslip, myPayslips, recalcRun, runCsv, setPayrollTerms, validateParamSet } from "./run";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const SRC = "Prüfbeleg des Steuerberaters (Testdaten)";

describe.skipIf(!hasDb)("Lohnabrechnung", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const emp: Record<string, string> = {};
  const userIds: string[] = [];
  const S: Record<string, string> = {};

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
  async function makeEmployee(label: string, org: string, number: string, userId?: string) {
    emp[label] = (await createEmployee(hrBot(org), { number, firstName: label, lastName: "Test" })).id;
    await db.employment.create({ data: { organizationId: org, employeeId: emp[label]!, validFrom: new Date("2000-01-01T00:00:00Z"), contractType: "FULL_TIME", weeklyHours: 40 } });
    if (userId) await db.employee.update({ where: { id: emp[label]! }, data: { userId } });
  }

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Lohn" } })).id;
    orgA = await makeOrg("TEST-LA-A");
    orgB = await makeOrg("TEST-LA-B");
    for (const [l, r] of [["hr", "hr"], ["owner", "owner"], ["fin", "finance"], ["e1", "employee"], ["e2", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "ownerB", "owner");
    await makeEmployee("e1", orgA, "L101", c.e1!.userId);
    await makeEmployee("e2", orgA, "L102", c.e2!.userId);
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["payrollRunLine", "payrollRun", "payrollTerms", "payrollParamSet", "auditLog", "employment", "employee"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: ids } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: ids } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Parametersatz: Berechtigung, Schema, Prüfung nur durch eine andere Person, danach unveränderlich", async () => {
    await expect(createParamSet(c.fin!, { label: "x", validFrom: "2026-01-01", source: SRC })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createParamSet(c.hr!, { label: "x", validFrom: "2026-01-01", source: "" })).rejects.toThrow();
    await expect(createParamSet(c.hr!, { label: "x", validFrom: "2026-01-01", source: SRC, params: { sv: {} } })).rejects.toThrow();
    const set = await createParamSet(c.hr!, { label: "AT 2026 (Entwurf)", validFrom: "2026-01-01", source: SRC });
    S.set = set.id;
    await expect(validateParamSet(c.hr!, set.id)).rejects.toThrow(/andere Person/);
    await expect(validateParamSet(c.ownerB!, set.id)).rejects.toThrow(/Parametersatz/); // andere Organisation
    await validateParamSet(c.owner!, set.id);
    await expect(validateParamSet(c.owner!, set.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(db.payrollParamSet.update({ where: { id: set.id }, data: { label: "geändert" } })).rejects.toThrow(/unveränderlich/);
  });

  it("Vertragsdaten: Berechtigung, append-only, Lesen protokolliert, Mandantentrennung", async () => {
    await expect(setPayrollTerms(c.fin!, { employeeId: emp.e1, validFrom: "2026-01-01", monthlyGross: "3000" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setPayrollTerms(c.hr!, { employeeId: emp.e1, validFrom: "2026-01-01", monthlyGross: "-5" })).rejects.toThrow();
    await expect(setPayrollTerms(c.ownerB!, { employeeId: emp.e1, validFrom: "2026-01-01", monthlyGross: "3000" })).rejects.toThrow(/Mitarbeiter/);
    const t = await setPayrollTerms(c.hr!, { employeeId: emp.e1, validFrom: "2026-01-01", monthlyGross: "3000" });
    await expect(setPayrollTerms(c.hr!, { employeeId: emp.e1, validFrom: "2026-01-01", monthlyGross: "3100" })).rejects.toBeInstanceOf(ConflictError);
    await expect(db.payrollTerms.update({ where: { id: t.id }, data: { monthlyGross: "9999" } })).rejects.toThrow(/append-only/);
    const audit = await db.auditLog.findMany({ where: { organizationId: orgA, action: "payroll_terms.set" } });
    expect(JSON.stringify(audit)).not.toContain("3000");
    await listPayrollTerms(c.hr!);
    expect(await db.auditLog.count({ where: { organizationId: orgA, action: "payroll_terms.read" } })).toBe(1);
  });

  it("Lauf: fehlende Vertragsdaten, Berechnung, Entwurf neu berechnen, ein Lauf je Monat", async () => {
    await expect(createRun(c.fin!, { year: 2026, month: 3 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createRun(c.hr!, { year: 2026, month: 3 })).rejects.toThrow(/Vertragsdaten für die Abrechnung fehlen: L102/);
    await setPayrollTerms(c.hr!, { employeeId: emp.e2, validFrom: "2026-01-01", monthlyGross: "500", marginal: true });
    await expect(createRun(c.hr!, { year: 2026, month: 3, inputs: [{ employeeId: "fremd", regularExtra: "0", special: "0" }] })).rejects.toThrow(/ohne Beschäftigung/);
    await expect(createRun(c.hr!, { year: 2026, month: 3, inputs: [{ employeeId: emp.e1, regularExtra: "0", special: "9000" }] })).rejects.toThrow(/Sechstel/);
    const run = await createRun(c.hr!, { year: 2026, month: 3 });
    S.run = run.id;
    await expect(createRun(c.hr!, { year: 2026, month: 3 })).rejects.toThrow(/bereits einen Lauf/);
    let full = await getRun(c.hr!, run.id);
    expect(full.status).toBe("DRAFT");
    const l1 = full.lines.find((l) => l.employeeId === emp.e1)!;
    expect([l1.gross, l1.svEmployee, l1.tax, l1.net, l1.employerCost].map(String)).toEqual(["3000", "543.6", "286.67", "2169.73", "3886.8"]);
    expect(String(full.lines.find((l) => l.employeeId === emp.e2)!.net)).toBe("500");
    expect(String(full.totals.net)).toBe("2669.73");
    await recalcRun(c.hr!, run.id, { inputs: [{ employeeId: emp.e1, regularExtra: "100", special: "0" }] });
    full = await getRun(c.hr!, run.id);
    expect(String(full.lines.find((l) => l.employeeId === emp.e1)!.gross)).toBe("3100");
    await expect(runCsv(c.hr!, run.id)).rejects.toThrow(/freigegebene/);
  });

  it("Freigabe: Vier-Augen, geprüfter Parametersatz; danach gesperrt (auch per SQL); Eigene Abrechnung nur nach Freigabe", async () => {
    expect(await myPayslips(c.e1!)).toEqual([]); // Entwurf nicht sichtbar
    await expect(approveRun(c.fin!, S.run!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveRun(c.hr!, S.run!)).rejects.toBeInstanceOf(ForbiddenError); // hr darf nicht freigeben
    // Eigener Lauf des Inhabers: nicht selbst freigeben
    const own = await createRun(c.owner!, { year: 2026, month: 4 });
    await expect(approveRun(c.owner!, own.id)).rejects.toThrow(/Vier-Augen/);
    await discardRun(c.owner!, own.id);
    // Satz ungeprüft → keine Freigabe
    await createParamSet(c.hr!, { label: "AT 2026-07", validFrom: "2026-07-01", source: SRC });
    const draftJuly = await createRun(c.hr!, { year: 2026, month: 7 });
    await expect(approveRun(c.owner!, draftJuly.id)).rejects.toThrow(/nicht geprüft/);
    await discardRun(c.hr!, draftJuly.id);

    await approveRun(c.owner!, S.run!);
    await expect(approveRun(c.owner!, S.run!)).rejects.toBeInstanceOf(ConflictError);
    await expect(recalcRun(c.hr!, S.run!, { inputs: [] })).rejects.toThrow(/Entwürfe/);
    await expect(discardRun(c.hr!, S.run!)).rejects.toBeInstanceOf(ConflictError);
    await expect(db.payrollRunLine.updateMany({ where: { runId: S.run! }, data: { net: "99999" } })).rejects.toThrow(/unveränderlich/);
    await expect(db.payrollRunLine.deleteMany({ where: { runId: S.run! } })).rejects.toThrow(/unveränderlich/);
    await expect(db.payrollRun.update({ where: { id: S.run! }, data: { status: "DRAFT" } })).rejects.toThrow(/gesperrt/);

    const mine = await myPayslips(c.e1!);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.employeeId).toBe(emp.e1);
    expect(await myPayslips(c.e2!)).toHaveLength(1);
    await expect(myPayslip(c.e2!, mine[0]!.id)).rejects.toThrow(/Abrechnung/); // fremde Zeile
    await expect(myPayslips(c.fin!)).resolves.toEqual([]); // kein Mitarbeiter verknüpft
    const csv = await runCsv(c.hr!, S.run!);
    expect(csv.fileName).toBe("Lohnabrechnung-2026-03-v1.csv");
    expect(csv.content).toContain("L101");
  });

  it("Storno und neue Version; Mandantentrennung", async () => {
    await expect(cancelRun(c.hr!, S.run!, "Fehler")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelRun(c.owner!, S.run!, "")).rejects.toThrow();
    await expect(cancelRun(c.ownerB!, S.run!, "Fremdzugriff")).rejects.toBeInstanceOf(ConflictError);
    await cancelRun(c.owner!, S.run!, "Gehalt falsch erfasst");
    expect(await myPayslips(c.e1!)).toEqual([]);
    const v2 = await createRun(c.hr!, { year: 2026, month: 3 });
    expect(v2.version).toBe(2);
    expect((await listRuns(c.hr!)).map((r) => `${r.version}:${r.status}`).sort()).toEqual(["1:CANCELLED", "2:DRAFT"]);
    expect(await listRuns(c.ownerB!)).toEqual([]);
    await expect(getRun(c.ownerB!, v2.id)).rejects.toThrow(/Abrechnungslauf/);
  });
});

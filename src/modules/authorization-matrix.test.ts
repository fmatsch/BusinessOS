import { describe, expect, it } from "vitest";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { budgetOverview, committedByDepartment, setBudget } from "./budget/service";
import { createCostCenter, createDepartment, listCostCenters, listDepartments } from "./masterdata/service";
import { createOrder, createRequest, createSupplier, getRequest, listOrders, listRequests, listSuppliers } from "./procurement/service";

const none: Ctx = { userId: "u", organizationId: "o", permissions: new Set<Permission>() };
const valid = {
  department: { code: "D1", name: "Test" },
  costCenter: { code: "K1", name: "Test" },
  supplier: { number: "L1", name: "Test" },
  request: { title: "Test", lines: [{ description: "x", quantity: "1", unitPrice: "1" }] },
  order: { requestId: "r", supplierId: "s", costCenterId: "c" },
  budget: { costCenterId: "c", fiscalYear: 2026, amount: "1" },
};

/** Jede Service-Funktion muss ohne die passende Berechtigung verweigern – und zwar bevor die Datenbank berührt wird. */
const protectedOperations: [string, Permission, () => Promise<unknown>][] = [
  ["listDepartments", "master.department.read", () => listDepartments(none)],
  ["createDepartment", "master.department.write", () => createDepartment(none, valid.department)],
  ["listCostCenters", "master.costcenter.read", () => listCostCenters(none)],
  ["createCostCenter", "master.costcenter.write", () => createCostCenter(none, valid.costCenter)],
  ["listSuppliers", "procurement.supplier.read", () => listSuppliers(none)],
  ["createSupplier", "procurement.supplier.write", () => createSupplier(none, valid.supplier)],
  ["listRequests", "procurement.request.create", () => listRequests(none)],
  ["getRequest", "procurement.request.create", () => getRequest(none, "x")],
  ["createRequest", "procurement.request.create", () => createRequest(none, valid.request)],
  ["listOrders", "procurement.order.create", () => listOrders(none)],
  ["createOrder", "procurement.order.create", () => createOrder(none, valid.order)],
  ["budgetOverview", "finance.budget.read", () => budgetOverview(none, 2026)],
  ["committedByDepartment", "finance.budget.read", () => committedByDepartment(none, 2026)],
  ["setBudget", "finance.budget.write", () => setBudget(none, valid.budget)],
];

describe("Autorisierungsmatrix: Services", () => {
  it.each(protectedOperations)("%s verweigert ohne %s", async (_name, permission, op) => {
    const error = await op().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).permission).toBe(permission);
  });

  it("jede registrierte Schreib-Permission wird von mindestens einer Operation geschützt", () => {
    const guarded = new Set(protectedOperations.map(([, p]) => p));
    const writes = PERMISSIONS.filter((p) => /\.(write|create)$/.test(p));
    expect(writes.filter((p) => !guarded.has(p))).toEqual([]);
  });
});

describe("Autorisierungsmatrix: Rollen", () => {
  const roles = (p: Permission) => Object.entries(SYSTEM_ROLES).filter(([, r]) => r.permissions.includes(p)).map(([k]) => k).sort();

  it("Organisations-Verwaltung und Audit-Zugriff gehören nur dem Inhaber (Audit zusätzlich Finanzen)", () => {
    expect(roles("org.settings.manage")).toEqual(["owner"]);
    expect(roles("org.members.manage")).toEqual(["owner"]);
    expect(roles("org.audit.read")).toEqual(["finance", "owner"]);
  });
  it("Sensible HR-Daten sieht nur der Inhaber", () => {
    expect(roles("hr.employee.read_sensitive")).toEqual(["owner"]);
  });
  it("Freigabe: Führungskraft und Inhaber für Schritt 1, Finanzen und Inhaber für Schritt 2", () => {
    expect(roles("procurement.request.approve")).toEqual(["manager", "owner"]);
    expect(roles("procurement.request.approve_finance")).toEqual(["finance", "owner"]);
  });
  it("Mitarbeiter dürfen nur anfordern und Stammdaten lesen – nichts schreiben oder freigeben", () => {
    const perms = SYSTEM_ROLES.employee!.permissions;
    expect(perms.filter((p) => !p.endsWith(".read") && p !== "procurement.request.create")).toEqual([]);
  });
  it("Budgets ändern dürfen nur Finanzen und Inhaber", () => {
    expect(roles("finance.budget.write")).toEqual(["finance", "owner"]);
  });
});

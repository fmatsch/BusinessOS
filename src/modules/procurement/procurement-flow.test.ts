import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { budgetOverview, setBudget } from "@/modules/budget/service";
import { createCostCenter } from "@/modules/masterdata/service";
import { createOrder, createRequest, createSupplier, decideRequest, getRequest, listPendingApprovals } from "./service";

// Integrationstest gegen eine migrierte Datenbank (DATABASE_URL).
const hasDb = !!process.env.DATABASE_URL;

function ctxFor(organizationId: string, userId: string, role: keyof typeof SYSTEM_ROLES): Ctx {
  return { userId, organizationId, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
}

describe.skipIf(!hasDb)("Beschaffungsprozess Ende-zu-Ende", () => {
  let orgA = "", orgB = "", tenantId = "", ccId = "", supplierId = "";
  let employee: Ctx, manager: Ctx, finance: Ctx, otherOrgFinance: Ctx;
  const year = new Date().getFullYear();
  const line = (price: string, qty = "1") => ({ description: "Laptop", quantity: qty, unitPrice: price });

  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { name: "TEST-Flow" } })).id;
    orgA = (await db.organization.create({ data: { tenantId, name: "TEST-Flow-A" } })).id;
    orgB = (await db.organization.create({ data: { tenantId, name: "TEST-Flow-B" } })).id;
    employee = ctxFor(orgA, "u-emp", "employee");
    manager = ctxFor(orgA, "u-mgr", "manager");
    finance = ctxFor(orgA, "u-fin", "finance");
    otherOrgFinance = ctxFor(orgB, "u-fin-b", "finance");
    const owner = { ...finance, permissions: new Set([...finance.permissions, "master.costcenter.write"]) as Ctx["permissions"] };
    ccId = (await createCostCenter(owner, { code: "IT", name: "IT" })).id;
    supplierId = (await createSupplier(finance, { number: "L1", name: "Muster Lieferant" })).id;
    await setBudget(finance, { costCenterId: ccId, fiscalYear: year, amount: "10000" });
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    await db.outboxEvent.deleteMany({ where: { organizationId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { organizationId: { in: ids } } });
    await db.purchaseOrder.deleteMany({ where: { organizationId: { in: ids } } });
    await db.purchaseRequest.deleteMany({ where: { organizationId: { in: ids } } }); // Zeilen + Freigaben per Cascade
    await db.budget.deleteMany({ where: { organizationId: { in: ids } } });
    await db.supplier.deleteMany({ where: { organizationId: { in: ids } } });
    await db.costCenter.deleteMany({ where: { organizationId: { in: ids } } });
    await db.sequence.deleteMany({ where: { organizationId: { in: ids } } });
    await db.organization.deleteMany({ where: { id: { in: ids } } });
    await db.tenant.delete({ where: { id: tenantId } });
    await db.$disconnect();
  });

  it("Anforderung bis 5.000 → Freigabe → Bestellung → Budget gebunden", async () => {
    const req = await createRequest(employee, { title: "Laptops", costCenterId: ccId, lines: [line("1000", "3")] });
    expect(req.status).toBe("SUBMITTED");
    expect(req.totalAmount.toString()).toBe("3000");

    // Mitarbeiter darf nicht freigeben
    await expect(decideRequest(employee, { requestId: req.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
    // Ohne Freigabe keine Bestellung
    await expect(createOrder(finance, { requestId: req.id, supplierId, costCenterId: ccId })).rejects.toBeInstanceOf(ConflictError);

    expect((await listPendingApprovals(manager)).map((a) => a.requestId)).toContain(req.id);
    expect((await decideRequest(manager, { requestId: req.id, decision: "APPROVE" })).status).toBe("APPROVED");

    const { order, overBudget } = await createOrder(finance, { requestId: req.id, supplierId, costCenterId: ccId });
    expect(order.totalAmount.toString()).toBe("3000");
    expect(overBudget).toBe(false);
    expect((await getRequest(finance, req.id)).status).toBe("ORDERED");

    // Doppelte Bestellung derselben Anforderung ist ausgeschlossen
    await expect(createOrder(finance, { requestId: req.id, supplierId, costCenterId: ccId })).rejects.toBeInstanceOf(ConflictError);

    const row = (await budgetOverview(finance, year)).find((r) => r.costCenterId === ccId)!;
    expect(row.committed.toString()).toBe("3000");
    expect(row.remaining!.toString()).toBe("7000");
  });

  it("über 5.000 braucht zusätzlich Finanzen; Reihenfolge wird erzwungen", async () => {
    const req = await createRequest(employee, { title: "Server", costCenterId: ccId, lines: [line("6000")] });
    const steps = (await getRequest(finance, req.id)).approvals.map((a) => a.stepKey);
    expect(steps).toEqual(["MANAGER", "FINANCE"]);

    // Finanz-Schritt kommt erst nach der Führungskraft: Finanzen hat nicht das Recht für Schritt 1
    await expect(decideRequest(finance, { requestId: req.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await decideRequest(manager, { requestId: req.id, decision: "APPROVE" })).status).toBe("SUBMITTED");
    expect((await decideRequest(finance, { requestId: req.id, decision: "APPROVE" })).status).toBe("APPROVED");

    const { overBudget } = await createOrder(finance, { requestId: req.id, supplierId, costCenterId: ccId });
    expect(overBudget).toBe(false); // 3.000 + 6.000 = 9.000 von 10.000

    const req3 = await createRequest(employee, { title: "Monitore", costCenterId: ccId, lines: [line("2000")] });
    await decideRequest(manager, { requestId: req3.id, decision: "APPROVE" });
    const third = await createOrder(finance, { requestId: req3.id, supplierId, costCenterId: ccId });
    expect(third.overBudget).toBe(true); // 11.000 > 10.000
    const row = (await budgetOverview(finance, year)).find((r) => r.costCenterId === ccId)!;
    expect(row.remaining!.toString()).toBe("-1000");
  });

  it("Ablehnung beendet den Prozess; Selbstfreigabe ist verboten", async () => {
    const req = await createRequest(employee, { title: "Stühle", lines: [line("100")] });
    expect((await decideRequest(manager, { requestId: req.id, decision: "REJECT", comment: "Nicht nötig" })).status).toBe("REJECTED");
    await expect(decideRequest(manager, { requestId: req.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);

    const own = await createRequest(manager, { title: "Eigene", lines: [line("100")] });
    await expect(decideRequest(manager, { requestId: own.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("parallele Entscheidungen: genau eine gewinnt", async () => {
    const req = await createRequest(employee, { title: "Parallel", lines: [line("50")] });
    const results = await Promise.allSettled([
      decideRequest(manager, { requestId: req.id, decision: "APPROVE" }),
      decideRequest(manager, { requestId: req.id, decision: "APPROVE" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("Mandantentrennung: andere Organisation sieht und ändert nichts", async () => {
    const req = await createRequest(employee, { title: "Geheim", lines: [line("10")] });
    await expect(getRequest(otherOrgFinance, req.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideRequest({ ...otherOrgFinance, permissions: new Set(SYSTEM_ROLES.manager!.permissions) as Ctx["permissions"] }, { requestId: req.id, decision: "APPROVE" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createOrder(otherOrgFinance, { requestId: req.id, supplierId, costCenterId: ccId })).rejects.toBeInstanceOf(NotFoundError);
    expect((await budgetOverview(otherOrgFinance, year)).length).toBe(0);
  });

  it("Audit-Log und Outbox enthalten die Schritte", async () => {
    const actions = (await db.auditLog.findMany({ where: { organizationId: orgA } })).map((a) => a.action);
    for (const a of ["purchase_request.submit", "purchase_request.approve_step", "purchase_request.reject", "purchase_order.create", "budget.set", "supplier.create"])
      expect(actions).toContain(a);
    expect(await db.outboxEvent.count({ where: { organizationId: orgA, type: "purchase_order.created" } })).toBe(3);
  });
});

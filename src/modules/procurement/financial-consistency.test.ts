import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import type { Ctx } from "@/platform/authz/authorize";
import { SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { budgetOverview, setBudget } from "@/modules/budget/service";
import { committedOf, fiscalYearRange } from "@/modules/budget/queries";
import { createCostCenter } from "@/modules/masterdata/service";
import { createOrder, createRequest, createSupplier, decideRequest } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const ctxFor = (organizationId: string, userId: string, role: keyof typeof SYSTEM_ROLES, extra: Permission[] = []): Ctx => ({
  userId, organizationId,
  permissions: new Set([...(SYSTEM_ROLES[role]!.permissions as readonly Permission[]), ...extra]) as Ctx["permissions"],
});

describe.skipIf(!hasDb)("Finanzielle Konsistenz", () => {
  let org = "", tenantId = "", ccId = "", supplierId = "";
  let employee: Ctx, manager: Ctx, finance: Ctx;
  const year = new Date().getFullYear();

  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { name: "TEST-Fin" } })).id;
    org = (await db.organization.create({ data: { tenantId, name: "TEST-Fin-A" } })).id;
    employee = ctxFor(org, "f-emp", "employee");
    manager = ctxFor(org, "f-mgr", "manager");
    finance = ctxFor(org, "f-fin", "finance", ["master.costcenter.write"]);
    ccId = (await createCostCenter(finance, { code: "K", name: "K" })).id;
    supplierId = (await createSupplier(finance, { number: "L", name: "L" })).id;
    await setBudget(finance, { costCenterId: ccId, fiscalYear: year, amount: "100000" });
  });

  afterAll(async () => {
    for (const m of ["outboxEvent", "auditLog", "purchaseOrder", "purchaseRequest", "budget", "supplier", "costCenter", "sequence"] as const)
      await (db[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
    await db.tenant.delete({ where: { id: tenantId } });
    await db.$disconnect();
  });

  async function orderedRequest(lines: { quantity: string; unitPrice: string }[], title = "T") {
    const req = await createRequest(employee, { title, costCenterId: ccId, lines: lines.map((l) => ({ description: "p", ...l })) });
    await decideRequest(manager, { requestId: req.id, decision: "APPROVE" });
    // über 5.000 braucht zusätzlich Finanzen
    if (new Decimal(req.totalAmount.toString()).gt(5000)) await decideRequest(finance, { requestId: req.id, decision: "APPROVE" });
    const { order } = await createOrder(finance, { requestId: req.id, supplierId, costCenterId: ccId });
    return { req, order };
  }

  it("rechnet ohne Gleitkommafehler und speichert vier Nachkommastellen exakt", async () => {
    const { req, order } = await orderedRequest([
      { quantity: "3", unitPrice: "0.1" },
      { quantity: "3", unitPrice: "0.0001" },
      { quantity: "0,5", unitPrice: "19,99" }, // Komma als Dezimaltrenner
    ]);
    expect(req.totalAmount.toString()).toBe("10.2953"); // 0.3 + 0.0003 + 9.995, exakt (Float ergäbe 10.295300000000001 o. ä.)
    expect(order.totalAmount.toString()).toBe(req.totalAmount.toString());
  });

  it("Bestellsumme = Anforderungssumme = Summe der Positionen; gebunden = Summe aller Bestellungen", async () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({ quantity: String(i + 1), unitPrice: `${(i + 1) * 13}.37` }));
    const expected = lines.reduce((s, l) => s.plus(new Decimal(l.quantity).times(l.unitPrice)), new Decimal(0));
    const { req, order } = await orderedRequest(lines);
    expect(new Decimal(req.totalAmount.toString()).equals(expected)).toBe(true);
    expect(order.totalAmount.toString()).toBe(req.totalAmount.toString());

    const all = await db.purchaseOrder.findMany({ where: { organizationId: org } });
    const sum = all.reduce((s, o) => s.plus(o.totalAmount.toString()), new Decimal(0));
    const row = (await budgetOverview(finance, year)).find((r) => r.costCenterId === ccId)!;
    expect(row.committed.equals(sum)).toBe(true);
    expect(row.remaining!.equals(new Decimal(100000).minus(sum))).toBe(true);
  });

  it("stornierte Bestellungen binden kein Budget mehr", async () => {
    const before = (await budgetOverview(finance, year)).find((r) => r.costCenterId === ccId)!.committed;
    const { order } = await orderedRequest([{ quantity: "1", unitPrice: "250" }]);
    const mid = (await budgetOverview(finance, year)).find((r) => r.costCenterId === ccId)!.committed;
    expect(mid.minus(before).toString()).toBe("250");
    await db.purchaseOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    const after = (await budgetOverview(finance, year)).find((r) => r.costCenterId === ccId)!.committed;
    expect(after.equals(before)).toBe(true);
  });

  it("Geschäftsjahresgrenzen: Bestellung zählt nur im Jahr ihres Anlegens", async () => {
    const { order } = await orderedRequest([{ quantity: "1", unitPrice: "111" }]);
    const dec31 = new Date(Date.UTC(year - 1, 11, 31, 23, 59, 59));
    await db.purchaseOrder.update({ where: { id: order.id }, data: { createdAt: dec31 } });
    const lastYear = await committedOf(db, org, ccId, fiscalYearRange(year - 1));
    expect(lastYear.toString()).toBe("111");
    const jan1 = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    await db.purchaseOrder.update({ where: { id: order.id }, data: { createdAt: jan1 } });
    expect((await committedOf(db, org, ccId, fiscalYearRange(year - 1))).toString()).toBe("0");
  });

  it("Belegnummern sind auch bei parallelem Anlegen eindeutig und lückenlos", async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createRequest(employee, { title: `P${i}`, lines: [{ description: "x", quantity: "1", unitPrice: "1" }] })),
    );
    const numbers = created.map((r) => Number(r.number.split("-").pop())).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[11]! - numbers[0]!).toBe(11);
  });

  it("lehnt negative, null und ungültige Beträge ab – es wird nichts gespeichert", async () => {
    const before = await db.purchaseRequest.count({ where: { organizationId: org } });
    for (const bad of [
      { quantity: "-1", unitPrice: "5" },
      { quantity: "0", unitPrice: "5" },
      { quantity: "1", unitPrice: "-5" },
      { quantity: "abc", unitPrice: "5" },
      { quantity: "1e3", unitPrice: "5" },
    ]) {
      await expect(createRequest(employee, { title: "Bad", lines: [{ description: "x", ...bad }] })).rejects.toThrow();
    }
    expect(await db.purchaseRequest.count({ where: { organizationId: org } })).toBe(before);
  });

  it("Transaktion: schlägt die Bestellung fehl, bleibt die Anforderung freigegeben (kein halber Zustand)", async () => {
    const req = await createRequest(employee, { title: "Rollback", costCenterId: ccId, lines: [{ description: "x", quantity: "1", unitPrice: "10" }] });
    await decideRequest(manager, { requestId: req.id, decision: "APPROVE" });
    await expect(createOrder(finance, { requestId: req.id, supplierId: "gibt-es-nicht", costCenterId: ccId })).rejects.toThrow();
    expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
    expect(await db.purchaseOrder.count({ where: { requestId: req.id } })).toBe(0);
  });
});

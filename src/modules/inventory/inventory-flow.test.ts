import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createCostCenter } from "@/modules/masterdata/service";
import { createOrder, createRequest, createSupplier, decideRequest, recordReceipt, reverseReceipt } from "@/modules/procurement/service";
import { adjustStock, createItem, getItem, issueStock, listItems, listStockableReceiptLines, reverseMovement, stockReceiptLine, updateItem } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Lager: Artikel und Bestandsbewegungen", () => {
  let tenantId = "", orgA = "", orgB = "", ccId = "", orderId = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];
  const ids: Record<string, string> = {};

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
  const stock = async (itemId: string) => (await getItem(c.fin!, itemId)).onHand.toString();
  /** Ein Wareneingang über `qty` Stück „Teil A“ (eigene Bestellung je Aufruf) → Position und Beleg */
  async function receive(qty: string) {
    const req = await createRequest(c.emp!, { title: "Ware", costCenterId: ccId, lines: [{ description: "Teil A", quantity: "100", unitPrice: "1" }] });
    await decideRequest(c.mgr!, { requestId: req.id, decision: "APPROVE" });
    const supplier = await createSupplier(c.fin!, { number: `L-${Math.random().toString(36).slice(2, 8)}`, name: "Lieferant" });
    orderId = (await createOrder(c.fin!, { requestId: req.id, supplierId: supplier.id, costCenterId: ccId })).order.id;
    const line = await db.purchaseRequestLine.findFirstOrThrow({ where: { requestId: req.id } });
    await recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.id, quantity: qty }] });
    const receipt = await db.goodsReceipt.findFirstOrThrow({ where: { orderId }, include: { lines: true } });
    return { receiptId: receipt.id, lineId: receipt.lines[0]!.id };
  }

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Inventory" } })).id;
    orgA = await makeOrg("TEST-INV-A");
    orgB = await makeOrg("TEST-INV-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    ccId = (await createCostCenter(c.fin!, { code: "LG1", name: "Lager" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.goodsReceiptLine.deleteMany({ where: { receipt: { organizationId: { in: orgs } } } });
      await tx.goodsReceipt.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      await tx.goodsReceipt.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "item", "purchaseOrder", "purchaseRequest", "sequence", "supplier", "costCenter"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Artikel: Berechtigungen, Prüfungen, eindeutige Nummer, Mandantentrennung", async () => {
    await expect(listItems(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createItem(c.mgr!, { number: "A1", name: "x" })).rejects.toBeInstanceOf(ForbiddenError); // Führungskraft darf buchen, nicht anlegen
    await expect(createItem(c.fin!, { number: "A 1", name: "x" })).rejects.toThrow(/Artikelnummer/);
    await expect(createItem(c.fin!, { number: "A1", name: "x", reorderLevel: "-1" })).rejects.toThrow();
    const a = await createItem(c.fin!, { number: "A1", name: "Schraube M6", unit: "Stk", reorderLevel: "5" });
    ids.a = a.id;
    await expect(createItem(c.fin!, { number: "A1", name: "doppelt" })).rejects.toThrow();
    expect((await listItems(c.mgr!)).map((i) => i.number)).toContain("A1");
    expect(await listItems(c.finB!)).toEqual([]);
    await expect(getItem(c.finB!, a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(issueStock(c.finB!, { itemId: a.id, quantity: "1" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Wareneingang einbuchen: nur einmal je Position, nur aktive Artikel, Bestand = Summe", async () => {
    const r = await receive("10");
    ids.receipt = r.receiptId; ids.line = r.lineId;
    expect((await listStockableReceiptLines(c.fin!)).map((l) => l.id)).toContain(r.lineId);
    await expect(listStockableReceiptLines(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: r.lineId })).rejects.toThrow(/Artikel wählen/);
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: "fremd", itemId: ids.a })).rejects.toBeInstanceOf(NotFoundError);
    await expect(stockReceiptLine(c.finB!, { goodsReceiptLineId: r.lineId, itemId: ids.a })).rejects.toBeInstanceOf(NotFoundError);
    const off = await createItem(c.fin!, { number: "OFF", name: "inaktiv" });
    await updateItem(c.fin!, off.id, { name: "inaktiv", reorderLevel: "", active: "" });
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: r.lineId, itemId: off.id })).rejects.toThrow(/deaktiviert/);

    await stockReceiptLine(c.mgr!, { goodsReceiptLineId: r.lineId, itemId: ids.a });
    expect(await stock(ids.a!)).toBe("10");
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: r.lineId, itemId: ids.a })).rejects.toThrow(/bereits eingebucht/);
    expect((await listStockableReceiptLines(c.fin!)).map((l) => l.id)).not.toContain(r.lineId);
  });

  it("Entnahme, Inventur, Mindestbestand; kein negativer Bestand auch bei Parallelität", async () => {
    await expect(issueStock(c.fin!, { itemId: ids.a, quantity: "0" })).rejects.toThrow();
    await expect(issueStock(c.fin!, { itemId: ids.a, quantity: "11" })).rejects.toThrow(/Nicht genug Bestand/);
    await expect(issueStock(c.emp!, { itemId: ids.a, quantity: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    const m = await issueStock(c.mgr!, { itemId: ids.a, quantity: "4", costCenterId: ccId, note: "Montage" });
    ids.issue = m.id;
    expect(await stock(ids.a!)).toBe("6");
    const r = await Promise.allSettled([issueStock(c.fin!, { itemId: ids.a, quantity: "4" }), issueStock(c.mgr!, { itemId: ids.a, quantity: "4" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await stock(ids.a!)).toBe("2");
    expect((await listItems(c.fin!)).find((i) => i.id === ids.a)).toMatchObject({ belowReorder: true }); // 2 ≤ Mindestbestand 5

    await expect(adjustStock(c.fin!, { itemId: ids.a, counted: "2", reason: "Inventur" })).rejects.toThrow(/nichts zu korrigieren/);
    await expect(adjustStock(c.fin!, { itemId: ids.a, counted: "9", reason: "x" })).rejects.toThrow();
    await adjustStock(c.fin!, { itemId: ids.a, counted: "9", reason: "Inventur: 7 gefunden" });
    expect(await stock(ids.a!)).toBe("9");
    expect((await listItems(c.fin!)).find((i) => i.id === ids.a)).toMatchObject({ belowReorder: false });
    await expect(updateItem(c.fin!, ids.a!, { name: "Schraube M6", reorderLevel: "5", active: "" })).rejects.toThrow(/Bestand/);
  });

  it("Gegenbuchungen: Entnahme korrigierbar, Wareneingang nur über die Beschaffung, Journal unveränderlich", async () => {
    await expect(reverseMovement(c.fin!, ids.issue!, "x")).rejects.toThrow(/Begründung/);
    await reverseMovement(c.fin!, ids.issue!, "Falsch gebucht");
    expect(await stock(ids.a!)).toBe("13"); // 9 + 4
    await expect(reverseMovement(c.fin!, ids.issue!, "nochmal")).rejects.toBeInstanceOf(ConflictError);
    const mv = (await getItem(c.fin!, ids.a!)).movements;
    const receiptMv = mv.find((x) => x.kind === "RECEIPT")!, reversal = mv.find((x) => x.kind === "REVERSAL")!;
    await expect(reverseMovement(c.fin!, receiptMv.id, "zurück")).rejects.toThrow(/Beschaffung/);
    await expect(reverseMovement(c.fin!, reversal.id, "zurück")).rejects.toThrow(/Gegenbuchungen/);
    await expect(db.stockMovement.update({ where: { id: receiptMv.id }, data: { quantity: "99" } })).rejects.toThrow();
  });

  it("Wareneingang korrigiert: die Gegenbuchung verringert den Bestand des ursprünglichen Artikels", async () => {
    const r = await receive("5");
    const b = await createItem(c.fin!, { number: "B1", name: "Mutter M6" });
    await reverseReceipt(c.mgr!, r.receiptId, "Falsche Menge");
    const neg = (await listStockableReceiptLines(c.fin!)).find((l) => l.quantity.lt(0) && l.reversesLineId === r.lineId)!;
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: neg.id })).rejects.toThrow(/noch nicht eingebucht/); // Original nie eingebucht
    await stockReceiptLine(c.fin!, { goodsReceiptLineId: r.lineId, itemId: b.id }); // +5
    expect(await stock(b.id)).toBe("5");
    await issueStock(c.fin!, { itemId: b.id, quantity: "3" });
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: neg.id })).rejects.toThrow(/negativ/); // nur noch 2 da, −5 geht nicht
    await adjustStock(c.fin!, { itemId: b.id, counted: "5", reason: "Nachzählung" });
    await stockReceiptLine(c.fin!, { goodsReceiptLineId: neg.id }); // Artikel kommt vom ursprünglichen Eingang
    expect(await stock(b.id)).toBe("0");
  });
});

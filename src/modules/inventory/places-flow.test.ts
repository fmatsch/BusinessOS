import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError } from "@/platform/errors";
import { createCostCenter } from "@/modules/masterdata/service";
import { createOrder, createRequest, createSupplier, decideRequest, recordReceipt } from "@/modules/procurement/service";
import { adjustStock, createItem, createLocation, getItem, issueStock, itemValuation, listLocations, reverseMovement, setLocationActive, stockReceiptLine, transferStock, updateItem, valuationReport } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Lager: Lagerorte, Chargen, Seriennummern, Bewertung", () => {
  let tenantId = "", orgA = "", orgB = "", ccId = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];
  const I: Record<string, string> = {};

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
  /** Wareneingang über `qty` Stück zum Stückpreis `price` → Position */
  async function receive(qty: string, price: string) {
    const req = await createRequest(c.emp!, { title: "Ware", costCenterId: ccId, lines: [{ description: "Teil", quantity: qty, unitPrice: price }] });
    await decideRequest(c.mgr!, { requestId: req.id, decision: "APPROVE" });
    const supplier = await createSupplier(c.fin!, { number: `L-${Math.random().toString(36).slice(2, 8)}`, name: "Lieferant" });
    const orderId = (await createOrder(c.fin!, { requestId: req.id, supplierId: supplier.id, costCenterId: ccId })).order.id;
    const line = await db.purchaseRequestLine.findFirstOrThrow({ where: { requestId: req.id } });
    await recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.id, quantity: qty }] });
    return (await db.goodsReceipt.findFirstOrThrow({ where: { orderId }, include: { lines: true } })).lines[0]!.id;
  }
  const onHand = async (id: string) => (await getItem(c.fin!, id)).onHand.toString();

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-InvPlaces" } })).id;
    orgA = await makeOrg("TEST-IP-A");
    orgB = await makeOrg("TEST-IP-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    ccId = (await createCostCenter(c.fin!, { code: "LG2", name: "Lager" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.goodsReceiptLine.deleteMany({ where: { receipt: { organizationId: { in: orgs } } } });
      await tx.goodsReceipt.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["stockBatch", "stockLocation", "outboxEvent", "auditLog", "item", "purchaseOrder", "purchaseRequest", "sequence", "supplier", "costCenter"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Lagerorte: Berechtigung, eindeutiger Code, Mandantentrennung", async () => {
    await expect(createLocation(c.mgr!, { code: "L1", name: "Regal" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createLocation(c.fin!, { code: "L 1", name: "x" })).rejects.toThrow(/Lagerort-Code/);
    I.l1 = (await createLocation(c.fin!, { code: "L1", name: "Hauptlager" })).id;
    I.l2 = (await createLocation(c.fin!, { code: "L2", name: "Regal A" })).id;
    await expect(createLocation(c.fin!, { code: "L1", name: "doppelt" })).rejects.toThrow();
    expect((await listLocations(c.mgr!)).map((l) => l.code)).toEqual(["L1", "L2"]);
    expect(await listLocations(c.finB!)).toEqual([]);
    await expect(transferStock(c.finB!, { itemId: "x", fromLocationId: I.l1, toLocationId: I.l2, quantity: "1" })).rejects.toThrow(/Artikel/);
  });

  it("Chargen und Umbuchung: Pflichtangaben, Bestand je Lagerort und Charge, Umbuchung wertneutral", async () => {
    I.b = (await createItem(c.fin!, { number: "CH1", name: "Farbe", tracking: "BATCH" })).id;
    const line = await receive("10", "2");
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.b, locationId: I.l1 })).rejects.toThrow(/Charge angeben/);
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.b, locationId: "fremd", batchNumber: "C-1" })).rejects.toThrow(/Lagerort/);
    await stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.b, locationId: I.l1, batchNumber: "C-1", expiresOn: "2030-01-31" });
    expect(await onHand(I.b!)).toBe("10");
    const plain = await createItem(c.fin!, { number: "PL1", name: "Teil" });
    const line2 = await receive("1", "1");
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: line2, itemId: plain.id, batchNumber: "X" })).rejects.toThrow(/nicht chargenweise/);

    await expect(issueStock(c.fin!, { itemId: I.b, quantity: "1", locationId: I.l1 })).rejects.toThrow(/Charge angeben/);
    await expect(issueStock(c.fin!, { itemId: I.b, quantity: "1", locationId: I.l1, batchNumber: "UNBEKANNT" })).rejects.toThrow(/Charge/);
    await expect(issueStock(c.fin!, { itemId: I.b, quantity: "1", locationId: I.l2, batchNumber: "C-1" })).rejects.toThrow(/Nicht genug Bestand/); // anderer Lagerort
    await expect(transferStock(c.emp!, { itemId: I.b, quantity: "1", fromLocationId: I.l1, toLocationId: I.l2, batchNumber: "C-1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(transferStock(c.fin!, { itemId: I.b, quantity: "1", fromLocationId: I.l1, toLocationId: I.l1, batchNumber: "C-1" })).rejects.toThrow(/derselbe/);
    await expect(transferStock(c.fin!, { itemId: I.b, quantity: "11", fromLocationId: I.l1, toLocationId: I.l2, batchNumber: "C-1" })).rejects.toThrow(/Nicht genug Bestand/);
    await transferStock(c.mgr!, { itemId: I.b, quantity: "4", fromLocationId: I.l1, toLocationId: I.l2, batchNumber: "C-1" });
    const item = await getItem(c.fin!, I.b!);
    expect(item.onHand.toString()).toBe("10"); // insgesamt unverändert
    expect(Object.fromEntries(item.balances.byPlace.map((p) => [p.location, p.quantity.toString()]))).toEqual({ "L1 Hauptlager": "6", "L2 Regal A": "4" });
    expect(item.balances.byPlace[0]!.batch).toBe("C-1");
    const outs = item.movements.filter((m) => m.kind.startsWith("TRANSFER"));
    expect(outs).toHaveLength(2);
    expect(outs[0]!.transferId).toBe(outs[1]!.transferId);
    await expect(reverseMovement(c.fin!, outs[0]!.id, "zurück")).rejects.toThrow(/Gegenumbuchung/);

    await expect(setLocationActive(c.fin!, I.l2!, false)).rejects.toThrow(/Bestand/);
    await transferStock(c.fin!, { itemId: I.b, quantity: "4", fromLocationId: I.l2, toLocationId: I.l1, batchNumber: "C-1" });
    await setLocationActive(c.fin!, I.l2!, false);
    await expect(transferStock(c.fin!, { itemId: I.b, quantity: "1", fromLocationId: I.l1, toLocationId: I.l2, batchNumber: "C-1" })).rejects.toThrow(/deaktiviert/);
    await setLocationActive(c.fin!, I.l2!, true);
    await adjustStock(c.fin!, { itemId: I.b, counted: "9", reason: "Inventur Hauptlager", locationId: I.l1, batchNumber: "C-1" });
    expect(await onHand(I.b!)).toBe("9");
    await expect(updateItem(c.fin!, I.b!, { name: "Farbe", reorderLevel: "", active: "on", tracking: "NONE" })).rejects.toThrow(/keine Bewegungen/);
  });

  it("Seriennummern: Anzahl = Menge, eindeutig, nur vorhandene Nummern, Gegenbuchung stellt wieder her", async () => {
    I.s = (await createItem(c.fin!, { number: "SN1", name: "Laptop", tracking: "SERIAL" })).id;
    const line = await receive("3", "500");
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.s, locationId: I.l1 })).rejects.toThrow(/Seriennummern angeben/);
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.s, locationId: I.l1, serials: "A1, A2" })).rejects.toThrow(/stimmen nicht überein/);
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.s, locationId: I.l1, serials: "A1\nA1\nA2" })).rejects.toThrow(/eindeutig/);
    await stockReceiptLine(c.fin!, { goodsReceiptLineId: line, itemId: I.s, locationId: I.l1, serials: "A1\nA2\nA3" });
    expect(await onHand(I.s!)).toBe("3");
    const again = await receive("1", "500");
    await expect(stockReceiptLine(c.fin!, { goodsReceiptLineId: again, itemId: I.s, locationId: I.l1, serials: "A2" })).rejects.toThrow(/bereits im Bestand/);
    expect((await getItem(c.fin!, I.s!)).balances.serials.map((s) => s.serial)).toEqual(["A1", "A2", "A3"]);

    await expect(issueStock(c.fin!, { itemId: I.s, locationId: I.l1, serials: "ZZ" })).rejects.toThrow(/nicht im Bestand/);
    await expect(issueStock(c.fin!, { itemId: I.s, locationId: I.l2, serials: "A1" })).rejects.toThrow(/nicht im Bestand/); // falscher Lagerort
    await expect(adjustStock(c.fin!, { itemId: I.s, counted: "1", reason: "Inventur" })).rejects.toThrow(/Seriennummernartikel/);
    const m = await issueStock(c.fin!, { itemId: I.s, locationId: I.l1, serials: "A1", costCenterId: ccId });
    expect(await onHand(I.s!)).toBe("2");
    await transferStock(c.fin!, { itemId: I.s, fromLocationId: I.l1, toLocationId: I.l2, serials: "A2" });
    expect((await getItem(c.fin!, I.s!)).balances.serials).toEqual([{ serial: "A2", location: "L2 Regal A" }, { serial: "A3", location: "L1 Hauptlager" }]);
    await reverseMovement(c.fin!, m.id, "Falsch gebucht");
    expect(await onHand(I.s!)).toBe("3");
    await expect(db.stockMovement.create({ data: { organizationId: orgA, itemId: I.s!, kind: "ISSUE", quantity: "-2", serial: "A9", createdById: "x" } })).rejects.toThrow(); // CHECK: Seriennummer nur ±1
  });

  it("Bewertung: gleitender Durchschnitt und FIFO aus dem Journal; Berechtigung und Mandantentrennung", async () => {
    I.avg = (await createItem(c.fin!, { number: "AV1", name: "Durchschnitt", valuationMethod: "AVG" })).id;
    I.fifo = (await createItem(c.fin!, { number: "FI1", name: "FIFO", valuationMethod: "FIFO" })).id;
    for (const id of [I.avg!, I.fifo!]) {
      await stockReceiptLine(c.fin!, { goodsReceiptLineId: await receive("10", "2"), itemId: id });
      await stockReceiptLine(c.fin!, { goodsReceiptLineId: await receive("10", "4"), itemId: id });
      await issueStock(c.fin!, { itemId: id, quantity: "15" });
    }
    await expect(valuationReport(c.mgr!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(itemValuation(c.emp!, I.avg!)).rejects.toBeInstanceOf(ForbiddenError);
    const rep = await valuationReport(c.fin!);
    const row = (n: string) => rep.rows.find((r) => r.number === n)!;
    expect([row("AV1").quantity.toString(), row("AV1").value.toString(), row("AV1").averageCost.toString()]).toEqual(["5", "15", "3"]);
    expect([row("FI1").quantity.toString(), row("FI1").value.toString()]).toEqual(["5", "20"]);
    const v = await itemValuation(c.fin!, I.fifo!);
    expect([...v.byMovement.values()].map((m) => m.value.toString())).toEqual(["20", "40", "-40"]);
    expect((await valuationReport(c.fin!, "2000-01-01")).rows.find((r) => r.number === "AV1")).toBeUndefined(); // vor allen Bewegungen
    expect((await valuationReport(c.finB!)).rows).toEqual([]);
    await expect(valuationReport(c.fin!, "kein-datum")).rejects.toBeInstanceOf(ConflictError);
  });
});

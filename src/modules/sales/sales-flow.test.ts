import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createAccount, createCustomer, createTaxCode, getCustomerInvoice, listAccounts, setCustomerAccounts } from "@/modules/finance/service";
import { adjustStock, createItem, createLocation, getItem } from "@/modules/inventory/service";
import { billOrder, cancelDelivery, cancelOrder, confirmOrder, createDelivery, createOrder, discardDelivery, getDeliveryNote, getOrder, listOrders, shipDelivery, updateOrder } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Vertrieb: Aufträge, Lieferung, Versand, Abrechnung", () => {
  let tenantId = "", orgA = "", orgB = "";
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
  const stock = async (id: string) => (await getItem(c.fin!, id)).onHand.toString();
  const orderBody = (lines: unknown[]) => ({ customerId: I.cust, reference: "Bestellung 4711", orderDate: today, lines });
  const goods = (qty: string) => ({ itemId: I.item, description: "Ware", quantity: qty, unitPrice: "10", taxCodeId: I.ust });
  const service = (qty: string) => ({ description: "Montage", quantity: qty, unitPrice: "50", taxCodeId: I.ust });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Sales" } })).id;
    orgA = await makeOrg("TEST-SL-A");
    orgB = await makeOrg("TEST-SL-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    await createAccount(c.fin!, { number: "4000", name: "Erlöse", type: "GL" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    I.ust = (await createTaxCode(c.fin!, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    I.cust = (await createCustomer(c.fin!, { number: "K1", name: "Kunde GmbH" })).id;
    await setCustomerAccounts(c.fin!, I.cust, { uid: "", accountId: acc["20001"], lineAccountId: acc["4000"] });
    I.custB = (await createCustomer(c.finB!, { number: "KB", name: "Kunde B" })).id;
    I.item = (await createItem(c.fin!, { number: "S1", name: "Schaltschrank" })).id;
    I.loc = (await createLocation(c.fin!, { code: "V1", name: "Versandlager" })).id;
    await adjustStock(c.fin!, { itemId: I.item, counted: "10", reason: "Anfangsbestand", locationId: I.loc });
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.deliveryLine.deleteMany({ where: { delivery: { organizationId: { in: orgs } } } });
      await tx.delivery.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.salesOrderLine.deleteMany({ where: { order: { organizationId: { in: orgs } } } });
      await tx.salesOrder.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "item", "stockLocation", "customerInvoice", "customer", "taxCode", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Auftrag: Berechtigung, Prüfungen, Entwurf bearbeiten, Bestätigen vergibt lückenlose Nummer, danach gesperrt", async () => {
    await expect(createOrder(c.emp!, orderBody([goods("1")]))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createOrder(c.mgr!, orderBody([goods("1")]))).rejects.toBeInstanceOf(ForbiddenError); // Führungskraft darf liefern, nicht anlegen
    await expect(createOrder(c.fin!, orderBody([]))).rejects.toThrow(/Position/);
    await expect(createOrder(c.fin!, { ...orderBody([goods("1")]), customerId: I.custB })).rejects.toBeInstanceOf(NotFoundError); // fremder Kunde
    await expect(createOrder(c.fin!, orderBody([{ ...goods("1"), taxCodeId: "fremd" }]))).rejects.toBeInstanceOf(NotFoundError);
    await expect(createOrder(c.fin!, orderBody([{ ...goods("1"), itemId: "fremd" }]))).rejects.toBeInstanceOf(NotFoundError);
    await expect(createOrder(c.fin!, orderBody([goods("0")]))).rejects.toThrow();
    const o = await createOrder(c.fin!, orderBody([goods("2")]));
    I.order = o.id;
    await updateOrder(c.fin!, o.id, orderBody([goods("6"), service("2")]));
    const confirmed = await confirmOrder(c.fin!, o.id);
    expect(confirmed.number).toMatch(/^SO-\d{4}-0001$/);
    await expect(confirmOrder(c.fin!, o.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(updateOrder(c.fin!, o.id, orderBody([goods("1")]))).rejects.toThrow(/Entwürfe/);
    await expect(db.salesOrderLine.updateMany({ where: { orderId: o.id }, data: { quantity: "999" } })).rejects.toThrow(/unveränderlich/);
    expect((await listOrders(c.mgr!)).map((x) => x.id)).toContain(o.id);
    expect(await listOrders(c.finB!)).toEqual([]);
    await expect(getOrder(c.finB!, o.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Lieferung: keine Übermengen (auch nicht über Entwürfe), Versand bucht das Lager und vergibt die Lieferscheinnummer", async () => {
    const order = await getOrder(c.fin!, I.order!);
    const [l1, l2] = order.lines;
    const draftOrder = await createOrder(c.fin!, orderBody([goods("1")]));
    await expect(createDelivery(c.fin!, { orderId: draftOrder.id, lines: [{ orderLineId: "x", quantity: "1" }] })).rejects.toThrow(/bestätigte/);
    await expect(createDelivery(c.emp!, { orderId: I.order, lines: [{ orderLineId: l1!.id, quantity: "1" }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: l1!.id, quantity: "7" }] })).rejects.toThrow(/nur noch 6 offen/);
    await expect(createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: l2!.id, quantity: "1", locationId: I.loc }] })).rejects.toThrow(/Leistungspositionen/);
    const d1 = await createDelivery(c.mgr!, { orderId: I.order, carrier: "Post", lines: [{ orderLineId: l1!.id, quantity: "4", locationId: I.loc }, { orderLineId: l2!.id, quantity: "2" }] });
    I.d1 = d1.id;
    await expect(createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: l1!.id, quantity: "3" }] })).rejects.toThrow(/nur noch 2 offen/); // 4 sind eingeplant
    expect(await stock(I.item!)).toBe("10"); // Entwurf bucht nichts

    await expect(shipDelivery(c.emp!, d1.id, { shippedOn: today })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(shipDelivery(c.finB!, d1.id, { shippedOn: today })).rejects.toBeInstanceOf(NotFoundError);
    const shipped = await shipDelivery(c.mgr!, d1.id, { shippedOn: today, trackingNumber: "TRK-1" });
    expect(shipped.number).toMatch(/^LS-\d{4}-0001$/);
    expect(await stock(I.item!)).toBe("6");
    const item = await getItem(c.fin!, I.item!);
    expect(item.balances.byPlace.map((b) => [b.location, b.quantity.toString()])).toEqual([["V1 Versandlager", "6"]]);
    await expect(shipDelivery(c.mgr!, d1.id, { shippedOn: today })).rejects.toBeInstanceOf(ConflictError);
    await expect(discardDelivery(c.mgr!, d1.id)).rejects.toBeInstanceOf(ConflictError);
    const after = await getOrder(c.fin!, I.order!);
    expect(after.lines.map((l) => [l.shipped.toString(), l.open.toString()])).toEqual([["4", "2"], ["2", "0"]]);
    const note = await getDeliveryNote(c.mgr!, d1.id);
    expect(note.trackingNumber).toBe("TRK-1");
    expect(note.rows.map((r) => [r.description, r.quantity.toString()])).toEqual([["Ware", "4"], ["Montage", "2"]]);
    // versandte Lieferungen sind auch auf Datenbankebene gesperrt
    await expect(db.deliveryLine.updateMany({ where: { deliveryId: d1.id }, data: { quantity: "1" } })).rejects.toThrow(/unveränderlich/);
    await expect(db.delivery.delete({ where: { id: d1.id } })).rejects.toThrow(/nicht gelöscht/);
  });

  it("Versand ohne Bestand schlägt als Ganzes fehl (keine Nummer verbraucht, nichts gebucht); Entwurf verwerfen", async () => {
    const order = await getOrder(c.fin!, I.order!);
    const l1 = order.lines[0]!;
    await adjustStock(c.fin!, { itemId: I.item, counted: "1", reason: "Schwund", locationId: I.loc });
    const d2 = await createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: l1.id, quantity: "2", locationId: I.loc }] });
    await expect(shipDelivery(c.fin!, d2.id, { shippedOn: today })).rejects.toThrow(/Nicht genug Bestand/);
    expect((await db.delivery.findUniqueOrThrow({ where: { id: d2.id } })).status).toBe("DRAFT");
    expect(await stock(I.item!)).toBe("1");
    await adjustStock(c.fin!, { itemId: I.item, counted: "6", reason: "Nachzählung", locationId: I.loc });
    await discardDelivery(c.fin!, d2.id);
    expect(await db.delivery.count({ where: { id: d2.id } })).toBe(0);
  });

  it("Abrechnung: Rechnungsentwurf aus gelieferten Mengen, jede Lieferzeile nur einmal; Storno nur vor der Abrechnung", async () => {
    await expect(billOrder(c.mgr!, I.order!)).rejects.toBeInstanceOf(ForbiddenError);
    const order = await getOrder(c.fin!, I.order!);
    const l1 = order.lines[0]!;
    // zweite Lieferung (2 Stück) versenden und wieder stornieren
    const d3 = await createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: l1.id, quantity: "2", locationId: I.loc }] });
    await shipDelivery(c.fin!, d3.id, { shippedOn: today });
    expect(await stock(I.item!)).toBe("4");
    await expect(cancelDelivery(c.fin!, d3.id, "x")).rejects.toThrow(/Begründung/);
    await cancelDelivery(c.fin!, d3.id, "Falsch kommissioniert");
    expect(await stock(I.item!)).toBe("6"); // Gegenbuchung stellt den Bestand wieder her
    await expect(cancelDelivery(c.fin!, d3.id, "nochmal")).rejects.toBeInstanceOf(ConflictError);
    expect((await getOrder(c.fin!, I.order!)).lines[0]!.open.toString()).toBe("2"); // wieder offen

    const bill = await billOrder(c.fin!, I.order!);
    const inv = await getCustomerInvoice(c.fin!, bill.invoiceId);
    expect(inv.status).toBe("DRAFT");
    expect(inv.lines.map((l) => [l.description, l.quantity.toString(), l.unitPrice.toString()])).toEqual([["Ware", "4", "10"], ["Montage", "2", "50"]]);
    expect(inv.netTotal.toString()).toBe("140");
    await expect(billOrder(c.fin!, I.order!)).rejects.toThrow(/keine gelieferten/);
    const d1 = (await db.delivery.findFirstOrThrow({ where: { orderId: I.order, status: "SHIPPED" } }));
    await expect(cancelDelivery(c.fin!, d1.id, "zu spät")).rejects.toThrow(/abgerechnet/);
    expect((await getOrder(c.fin!, I.order!)).status).toBe("CONFIRMED"); // Rest offen
    await expect(cancelOrder(c.fin!, I.order!)).rejects.toThrow(/Lieferungen/);
  });

  it("Rest liefern und abrechnen schließt den Auftrag; Storno nur ohne Lieferung; Mandantentrennung", async () => {
    const order = await getOrder(c.fin!, I.order!);
    const d4 = await createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: order.lines[0]!.id, quantity: "2", locationId: I.loc }] });
    await shipDelivery(c.fin!, d4.id, { shippedOn: today });
    await billOrder(c.fin!, I.order!);
    expect((await getOrder(c.fin!, I.order!)).status).toBe("CLOSED");
    await expect(createDelivery(c.fin!, { orderId: I.order, lines: [{ orderLineId: order.lines[0]!.id, quantity: "1" }] })).rejects.toThrow(/bestätigte/);
    expect(await stock(I.item!)).toBe("4");

    const spare = await createOrder(c.fin!, orderBody([goods("1")]));
    await cancelOrder(c.fin!, spare.id);
    await expect(confirmOrder(c.fin!, spare.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(cancelOrder(c.finB!, spare.id)).rejects.toBeInstanceOf(NotFoundError);
    const bAuditCount = await db.auditLog.count({ where: { organizationId: orgB, action: { startsWith: "sales_order" } } });
    expect(bAuditCount).toBe(0);
  });
});

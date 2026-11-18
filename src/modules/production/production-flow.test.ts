import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createAccount, createCustomer, createTaxCode, setCustomerAccounts, listAccounts } from "@/modules/finance/service";
import { createCostCenter } from "@/modules/masterdata/service";
import { createOrder as createPurchaseOrder, createRequest, createSupplier, decideRequest, recordReceipt } from "@/modules/procurement/service";
import { createItem, getItem, issueStock, stockReceiptLine, valuationReport } from "@/modules/inventory/service";
import { confirmOrder, createOrder as createSalesOrder } from "@/modules/sales/service";
import { activateBom, cancelProductionOrder, completeProductionOrder, confirmProduction, createBom, createProductionOrder, deleteBomDraft, getBom, getProductionOrder, listBoms, listProductionOrders, releaseProductionOrder, reverseConfirmation, runMrp, updateBom } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Fertigung: Stücklisten, Fertigungsaufträge, Bedarfsplanung", () => {
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
  /** Einkauf und Einbuchung von `qty` Stück zum Preis `price` */
  async function purchase(itemId: string, qty: string, price: string) {
    const req = await createRequest(c.emp!, { title: "Material", costCenterId: ccId, lines: [{ description: "Material", quantity: qty, unitPrice: price }] });
    await decideRequest(c.mgr!, { requestId: req.id, decision: "APPROVE" });
    const supplier = await createSupplier(c.fin!, { number: `L-${Math.random().toString(36).slice(2, 8)}`, name: "Lieferant" });
    const orderId = (await createPurchaseOrder(c.fin!, { requestId: req.id, supplierId: supplier.id, costCenterId: ccId })).order.id;
    const line = await db.purchaseRequestLine.findFirstOrThrow({ where: { requestId: req.id } });
    await recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.id, quantity: qty }] });
    const lineId = (await db.goodsReceipt.findFirstOrThrow({ where: { orderId }, include: { lines: true } })).lines[0]!.id;
    await stockReceiptLine(c.fin!, { goodsReceiptLineId: lineId, itemId });
  }
  const stock = async (id: string) => (await getItem(c.fin!, id)).onHand.toString();
  const bomBody = (itemId: string, lines: unknown[], outputQuantity = "1") => ({ itemId, outputQuantity, lines });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Production" } })).id;
    orgA = await makeOrg("TEST-PR-A");
    orgB = await makeOrg("TEST-PR-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    ccId = (await createCostCenter(c.fin!, { code: "FT1", name: "Fertigung" })).id;
    I.r1 = (await createItem(c.fin!, { number: "R1", name: "Blech" })).id;
    I.r2 = (await createItem(c.fin!, { number: "R2", name: "Schraube" })).id;
    I.fg = (await createItem(c.fin!, { number: "FG", name: "Gehäuse" })).id;
    I.sub = (await createItem(c.fin!, { number: "SUB", name: "Baugruppe" })).id;
    I.itemB = (await createItem(c.finB!, { number: "XB", name: "Fremd" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.productionConfirmation.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.productionOrder.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.bomLine.deleteMany({ where: { bom: { organizationId: { in: orgs } } } });
      await tx.bom.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.deliveryLine.deleteMany({ where: { delivery: { organizationId: { in: orgs } } } });
      await tx.delivery.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.salesOrderLine.deleteMany({ where: { order: { organizationId: { in: orgs } } } });
      await tx.salesOrder.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.goodsReceiptLine.deleteMany({ where: { receipt: { organizationId: { in: orgs } } } });
      await tx.goodsReceipt.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "item", "purchaseOrder", "purchaseRequest", "supplier", "costCenter", "customerInvoice", "customer", "taxCode", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Stückliste: Berechtigung, Prüfungen, Zyklen, Versionen, Aktivierung sperrt", async () => {
    const lines = [{ componentItemId: I.r1, quantity: "2" }, { componentItemId: I.r2, quantity: "1", scrapPercent: "10" }];
    await expect(createBom(c.emp!, bomBody(I.fg!, lines))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createBom(c.mgr!, bomBody(I.fg!, lines))).rejects.toBeInstanceOf(ForbiddenError); // Führungskraft darf rückmelden, nicht pflegen
    await expect(createBom(c.fin!, bomBody(I.fg!, []))).rejects.toThrow(/Komponente/);
    await expect(createBom(c.fin!, bomBody(I.fg!, [{ componentItemId: I.fg, quantity: "1" }]))).rejects.toThrow(/eigenen Stückliste/);
    await expect(createBom(c.fin!, bomBody(I.fg!, [{ componentItemId: I.r1, quantity: "1" }, { componentItemId: I.r1, quantity: "2" }]))).rejects.toThrow(/nur einmal/);
    await expect(createBom(c.fin!, bomBody(I.fg!, [{ componentItemId: I.itemB, quantity: "1" }]))).rejects.toBeInstanceOf(NotFoundError); // fremder Artikel
    await expect(createBom(c.fin!, bomBody(I.fg!, [{ componentItemId: I.r1, quantity: "1", scrapPercent: "100" }]))).rejects.toThrow(/Ausschuss/);

    const v1 = await createBom(c.fin!, bomBody(I.fg!, [{ componentItemId: I.r1, quantity: "1" }]));
    expect(v1.version).toBe(1);
    await updateBom(c.fin!, v1.id, bomBody(I.fg!, lines));
    await activateBom(c.fin!, v1.id);
    I.bomV1 = v1.id;
    await expect(activateBom(c.fin!, v1.id)).rejects.toThrow(/Entwürfe/);
    await expect(updateBom(c.fin!, v1.id, bomBody(I.fg!, lines))).rejects.toThrow(/Entwürfe/);
    await expect(db.bomLine.updateMany({ where: { bomId: v1.id }, data: { quantity: "99" } })).rejects.toThrow(/unveränderlich/);

    // Zyklus: SUB braucht FG, FG braucht SUB
    const fgWithSub = await createBom(c.fin!, bomBody(I.fg!, [...lines, { componentItemId: I.sub, quantity: "1" }]));
    expect(fgWithSub.version).toBe(2);
    await activateBom(c.fin!, fgWithSub.id);
    expect((await db.bom.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("ARCHIVED"); // alte Version archiviert
    await expect(createBom(c.fin!, bomBody(I.sub!, [{ componentItemId: I.fg, quantity: "1" }]))).rejects.toThrow(/Zyklus/);
    // zurück zur Version 3 ohne SUB
    const v3 = await createBom(c.fin!, bomBody(I.fg!, lines));
    await activateBom(c.fin!, v3.id);
    I.bom = v3.id;
    const spare = await createBom(c.fin!, bomBody(I.sub!, [{ componentItemId: I.r1, quantity: "1" }]));
    await deleteBomDraft(c.fin!, spare.id);
    await expect(deleteBomDraft(c.fin!, v3.id)).rejects.toBeInstanceOf(ConflictError);

    expect((await listBoms(c.mgr!)).filter((b) => b.itemId === I.fg).map((b) => `${b.version}:${b.status}`).sort()).toEqual(["1:ARCHIVED", "2:ARCHIVED", "3:ACTIVE"]);
    expect(await listBoms(c.finB!)).toEqual([]);
    await expect(getBom(c.finB!, v3.id)).rejects.toBeInstanceOf(NotFoundError);
    const shown = await getBom(c.fin!, v3.id, "10");
    expect(shown.exploded.map((e) => [e.item.number, e.quantity.toString(), e.leaf])).toEqual([["R1", "20", true], ["R2", "11", true]]); // 10 % Ausschuss auf Schrauben
  });

  it("Fertigungsauftrag: Voraussetzungen, Freigabe mit Nummer, Materialbedarf und Verfügbarkeit", async () => {
    await expect(createProductionOrder(c.fin!, { itemId: I.r1, quantity: "1" })).rejects.toThrow(/keine aktive Stückliste/);
    await expect(createProductionOrder(c.mgr!, { itemId: I.fg, quantity: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    const o = await createProductionOrder(c.fin!, { itemId: I.fg, quantity: "10", plannedDate: today });
    I.po = o.id;
    expect(o.bomId).toBe(I.bom);
    await expect(confirmProduction(c.mgr!, { orderId: o.id, quantity: "1" })).rejects.toThrow(/freigegebene/);
    expect((await releaseProductionOrder(c.fin!, o.id)).number).toMatch(/^FA-\d{4}-0001$/);
    await expect(releaseProductionOrder(c.fin!, o.id)).rejects.toBeInstanceOf(ConflictError);
    const view = await getProductionOrder(c.mgr!, o.id);
    expect(view.requirements.map((r) => [r.item.number, r.needed.toString(), r.short.toString()])).toEqual([["R1", "20", "20"], ["R2", "11", "11"]]); // noch kein Bestand
    await expect(getProductionOrder(c.finB!, o.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listProductionOrders(c.mgr!)).map((x) => x.id)).toContain(o.id);
  });

  it("Rückmeldung: ohne Material alles oder nichts; mit Material Verbrauch, Zugang und Einstandspreis", async () => {
    await expect(confirmProduction(c.emp!, { orderId: I.po, quantity: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(confirmProduction(c.mgr!, { orderId: I.po, quantity: "4" })).rejects.toThrow(/Nicht genug Bestand/);
    expect(await stock(I.fg!)).toBe("0");
    await purchase(I.r1!, "100", "2");
    await expect(confirmProduction(c.mgr!, { orderId: I.po, quantity: "4" })).rejects.toThrow(/Nicht genug Bestand/); // R2 fehlt – R1 wird nicht verbraucht
    expect(await stock(I.r1!)).toBe("100");
    await purchase(I.r2!, "50", "1");

    await expect(confirmProduction(c.mgr!, { orderId: I.po, quantity: "11" })).rejects.toThrow(/nur noch 10 offen/);
    const r = await confirmProduction(c.mgr!, { orderId: I.po, quantity: "4" });
    I.conf1 = r.confirmationId;
    expect(r.unitCost.toString()).toBe("5.1"); // (4 × 2 × 2,00 + 4 × 1,1 × 1,00) / 4 = (16 + 4,4) / 4
    expect([await stock(I.r1!), await stock(I.r2!), await stock(I.fg!)]).toEqual(["92", "45.6", "4"]);
    const rep = await valuationReport(c.fin!);
    expect(String(rep.rows.find((x) => x.number === "FG")!.value)).toBe("20.4");
    const kinds = (await getItem(c.fin!, I.fg!)).movements.map((m) => m.kind);
    expect(kinds).toEqual(["PRODUCTION_RECEIPT"]);

    // Rest zurückmelden → Auftrag fertig
    await confirmProduction(c.mgr!, { orderId: I.po, quantity: "6" });
    const done = await getProductionOrder(c.fin!, I.po!);
    expect([done.status, done.produced.toString(), done.remaining.toString()]).toEqual(["COMPLETED", "10", "0"]);
    await expect(confirmProduction(c.mgr!, { orderId: I.po, quantity: "1" })).rejects.toThrow(/freigegebene/);
    await expect(cancelProductionOrder(c.fin!, I.po!)).rejects.toBeInstanceOf(ConflictError);
    await expect(db.productionConfirmation.updateMany({ where: { orderId: I.po }, data: { quantity: "99" } })).rejects.toThrow(/unveränderlich/);
  });

  it("Rücknahme: stellt Komponenten wieder her, nicht wenn das Endprodukt schon verbraucht wurde; Abschluss mit Teilmenge", async () => {
    await expect(reverseConfirmation(c.emp!, I.conf1!, "Fehler")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reverseConfirmation(c.mgr!, I.conf1!, "x")).rejects.toThrow(/Begründung/);
    await issueStock(c.fin!, { itemId: I.fg, quantity: "9" }); // von 10 Stück sind nur noch 1 da
    await expect(reverseConfirmation(c.mgr!, I.conf1!, "Falsch gemeldet")).rejects.toThrow(/negativ/); // 4 zurück, aber nur 1 im Lager
    expect(await stock(I.fg!)).toBe("1");
    expect(await stock(I.r1!)).toBe("80"); // nichts halb zurückgenommen (100 − 8 − 12)

    // neuer Auftrag: Teilmenge, Abschluss, Rücknahme
    const o = await createProductionOrder(c.fin!, { itemId: I.fg, quantity: "5" });
    await releaseProductionOrder(c.fin!, o.id);
    await expect(completeProductionOrder(c.fin!, o.id)).rejects.toThrow(/noch nichts/);
    const conf = await confirmProduction(c.mgr!, { orderId: o.id, quantity: "2" });
    await completeProductionOrder(c.fin!, o.id);
    expect((await getProductionOrder(c.fin!, o.id)).status).toBe("COMPLETED");
    expect(await stock(I.fg!)).toBe("3");
    await reverseConfirmation(c.mgr!, conf.confirmationId, "Falsch gemeldet");
    expect(await stock(I.fg!)).toBe("1");
    expect(await stock(I.r1!)).toBe("80");
    await expect(reverseConfirmation(c.mgr!, conf.confirmationId, "nochmal")).rejects.toBeInstanceOf(ConflictError);
    expect((await getProductionOrder(c.fin!, o.id)).status).toBe("RELEASED"); // wieder offen, nichts produziert
    await cancelProductionOrder(c.fin!, o.id);
  });

  it("Bedarfsplanung: Kundenaufträge, Bestand und geplante Zugänge ergeben Vorschläge über alle Stufen", async () => {
    await createAccount(c.fin!, { number: "4000", name: "Erlöse", type: "GL" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    const ust = (await createTaxCode(c.fin!, { key: "ust20", name: "USt 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    const cust = (await createCustomer(c.fin!, { number: "K1", name: "Kunde" })).id;
    await setCustomerAccounts(c.fin!, cust, { uid: "", accountId: acc["20001"], lineAccountId: acc["4000"] });
    const so = await createSalesOrder(c.fin!, { customerId: cust, orderDate: today, lines: [{ itemId: I.fg, description: "Gehäuse", quantity: "20", unitPrice: "30", taxCodeId: ust }] });
    await expect(runMrp(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await runMrp(c.fin!)).suggestions).toEqual([]); // Auftrag noch Entwurf → kein Bedarf
    await confirmOrder(c.fin!, so.id);

    const plan = await runMrp(c.fin!);
    expect(plan.error).toBeNull();
    const by = Object.fromEntries(plan.suggestions.map((s) => [s.number, [s.action, s.quantity.toString()]]));
    expect(by.FG).toEqual(["MAKE", "19"]); // 20 − Bestand 1
    expect(by.R1).toBeUndefined(); // 80 vorhanden ≥ 19 × 2 = 38
    // geplante Fertigung deckt den Bedarf teilweise
    const po = await createProductionOrder(c.fin!, { itemId: I.fg, quantity: "9" });
    await releaseProductionOrder(c.fin!, po.id);
    expect(Object.fromEntries((await runMrp(c.fin!)).suggestions.map((s) => [s.number, s.quantity.toString()])).FG).toBe("10");
    // Entwürfe zählen nicht als geplanter Zugang
    const draft = await createProductionOrder(c.fin!, { itemId: I.fg, quantity: "50" });
    expect(Object.fromEntries((await runMrp(c.fin!)).suggestions.map((s) => [s.number, s.quantity.toString()])).FG).toBe("10");
    await cancelProductionOrder(c.fin!, draft.id);
    expect((await runMrp(c.finB!)).suggestions).toEqual([]); // Mandantentrennung
  });
});

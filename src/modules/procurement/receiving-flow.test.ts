import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createCostCenter } from "@/modules/masterdata/service";
import { budgetOverview } from "@/modules/budget/service";
import { acceptInvoiceVariance, approveSupplierInvoice, createAccount, createSupplierInvoice, createTaxCode, getInvoiceMatch, listAccounts, setSupplierAccounts } from "@/modules/finance/service";
import { createOrder, createRequest, createSupplier, decideRequest, getOrderReceiving, recordReceipt, reverseReceipt } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Wareneingang und Rechnungsabgleich", () => {
  let tenantId = "", orgA = "", orgB = "", ccId = "", supplierId = "", taxId = "", orderId = "";
  const line: Record<string, string> = {};
  const c: Record<string, Ctx> = {};
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
  const invoice = (number: string, net: string, extra: Record<string, unknown> = {}) =>
    createSupplierInvoice(c.fin!, { supplierId, invoiceNumber: number, invoiceDate: today, purchaseOrderId: orderId, lines: [{ description: "Ware", netAmount: net, taxCodeId: taxId }], ...extra });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Receiving" } })).id;
    orgA = await makeOrg("TEST-RC-A");
    orgB = await makeOrg("TEST-RC-B");
    for (const [l, r] of [["fin", "finance"], ["fin2", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");

    ccId = (await createCostCenter(c.fin!, { code: "RC1", name: "Test" })).id;
    supplierId = (await createSupplier(c.fin!, { number: "RC-L1", name: "Lieferant RC" })).id;
    await createAccount(c.fin!, { number: "7000", name: "Aufwand", type: "GL" });
    await createAccount(c.fin!, { number: "33001", name: "Kreditor", type: "VENDOR" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    await setSupplierAccounts(c.fin!, supplierId, { uid: "", accountId: acc["33001"], lineAccountId: acc["7000"] });
    taxId = (await createTaxCode(c.fin!, { key: "vst20", name: "Vorsteuer 20 %", rate: "20", direction: "INPUT", bmdCode: "2", datevKey: "9" })).id;

    // Bestellung: 10 × 100 = 1.000 und 5 × 200 = 1.000 (Gesamt 2.000, Freigabe durch die Führungskraft genügt)
    const req = await createRequest(c.emp!, { title: "Ware", costCenterId: ccId, lines: [{ description: "Teil A", quantity: "10", unitPrice: "100" }, { description: "Teil B", quantity: "5", unitPrice: "200" }] });
    await decideRequest(c.mgr!, { requestId: req.id, decision: "APPROVE" });
    orderId = (await createOrder(c.fin!, { requestId: req.id, supplierId, costCenterId: ccId })).order.id;
    const lines = await db.purchaseRequestLine.findMany({ where: { requestId: req.id }, orderBy: { description: "asc" } });
    line.a = lines[0]!.id; line.b = lines[1]!.id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.goodsReceiptLine.deleteMany({ where: { receipt: { organizationId: { in: orgs } } } });
      await tx.goodsReceipt.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "supplierInvoice", "purchaseOrder", "purchaseRequest", "taxCode", "account", "sequence", "supplier", "costCenter"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("ohne Wareneingang: Status „nichts geliefert“, Rechnung über der Toleranz wird gesperrt", async () => {
    expect((await getOrderReceiving(c.mgr!, orderId)).status).toBe("NOT_RECEIVED");
    const inv = await invoice("RC-1", "1000");
    const m = await getInvoiceMatch(c.fin!, inv.id);
    expect(m.applicable && m.status).toBe("VARIANCE");
    await expect(approveSupplierInvoice(c.fin2!, inv.id)).rejects.toThrow(/Abgleich mit Bestellung/);
    await db.supplierInvoice.update({ where: { id: inv.id }, data: { status: "CANCELLED" } });
  });

  it("Berechtigungen und Eingabeprüfung beim Wareneingang", async () => {
    await expect(recordReceipt(c.emp!, { orderId, receivedOn: today, lines: [{ requestLineId: line.a, quantity: "1" }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOrderReceiving(c.emp!, orderId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordReceipt(c.mgr!, { orderId, receivedOn: "2999-01-01", lines: [{ requestLineId: line.a, quantity: "1" }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.a, quantity: "11" }] })).rejects.toThrow(/nur noch 10 offen/);
    await expect(recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.a, quantity: "-1" }] })).rejects.toThrow();
    await expect(recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: "fremd", quantity: "1" }] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Teillieferung: Rechnung über die gelieferte Ware passt, darüber hinaus nicht", async () => {
    await recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.a, quantity: "10" }] });
    const r = await getOrderReceiving(c.mgr!, orderId);
    expect(r.status).toBe("PARTIAL");
    expect(r.receivedNet.toString()).toBe("1000");

    const ok = await invoice("RC-2", "1000");
    const m = await getInvoiceMatch(c.fin!, ok.id);
    expect(m.applicable && m.status).toBe("OK");
    await approveSupplierInvoice(c.fin2!, ok.id);

    const too = await invoice("RC-3", "1000"); // Teil B ist noch nicht geliefert
    const m2 = await getInvoiceMatch(c.fin!, too.id);
    expect(m2.applicable && m2.alreadyInvoicedNet.toString()).toBe("1000");
    expect(m2.applicable && m2.status).toBe("VARIANCE");
    await expect(approveSupplierInvoice(c.fin2!, too.id)).rejects.toThrow(/Abgleich mit Bestellung/);
  });

  it("Abweichung akzeptieren: eigene Berechtigung, Begründung, nicht die erfassende Person", async () => {
    const inv = await db.supplierInvoice.findFirstOrThrow({ where: { organizationId: orgA, invoiceNumber: "RC-3" } });
    await expect(acceptInvoiceVariance(c.mgr!, inv.id, "zu Unrecht")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acceptInvoiceVariance(c.fin!, inv.id, "ich selbst")).rejects.toThrow(/Vier-Augen/);
    await expect(acceptInvoiceVariance(c.fin2!, inv.id, "x")).rejects.toThrow(/Begründung/);
    await acceptInvoiceVariance(c.fin2!, inv.id, "Vorauszahlung vereinbart");
    await expect(acceptInvoiceVariance(c.fin2!, inv.id, "nochmal")).rejects.toThrow(/bereits akzeptiert/);
    await approveSupplierInvoice(c.fin2!, inv.id);
    const audit = await db.auditLog.findFirst({ where: { organizationId: orgA, action: "supplier_invoice.accept_variance", entityId: inv.id } });
    expect(audit).not.toBeNull();
  });

  it("Akzeptieren ohne Abweichung ist nicht möglich; Rechnung ohne Bestellung wird nicht abgeglichen", async () => {
    const free = await invoice("RC-4", "50", { purchaseOrderId: null });
    expect((await getInvoiceMatch(c.fin!, free.id)).applicable).toBe(false);
    await expect(acceptInvoiceVariance(c.fin2!, free.id, "ohne Grund nötig")).rejects.toThrow(/keine Abweichung/);
    await approveSupplierInvoice(c.fin2!, free.id);
  });

  it("Budget: Ist = freigegebene Rechnungen (Kostenstelle der Bestellung), Gutschriften abgezogen, Entwürfe zählen nicht", async () => {
    const year = new Date().getFullYear();
    const row = async () => (await budgetOverview(c.fin!, year)).find((r) => r.costCenterId === ccId)!;
    expect((await row()).actual.toString()).toBe("2000"); // RC-2 und RC-3 (je 1.000, Bestellung RC1); RC-4 ohne Bestellung zählt nicht zur Kostenstelle
    expect((await row()).committed.toString()).toBe("2000");
    await invoice("RC-5", "700"); // Entwurf zählt nicht
    expect((await row()).actual.toString()).toBe("2000");
    const orig = await db.supplierInvoice.findFirstOrThrow({ where: { organizationId: orgA, invoiceNumber: "RC-2" } });
    const credit = await invoice("RC-2-G", "100", { kind: "CREDIT", creditsId: orig.id, purchaseOrderId: null });
    await approveSupplierInvoice(c.fin2!, credit.id);
    expect((await row()).actual.toString()).toBe("1900");
    await expect(budgetOverview(c.emp!, year)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Korrektur nur als Gegenbuchung, höchstens einmal; Journal ist per Trigger geschützt", async () => {
    const r = await getOrderReceiving(c.mgr!, orderId);
    const original = r.receipts.find((x) => !x.isReversal)!;
    await expect(reverseReceipt(c.mgr!, original.id, "")).rejects.toThrow(/Grund/);
    const rev = await reverseReceipt(c.mgr!, original.id, "Falsche Position gebucht");
    await expect(reverseReceipt(c.mgr!, original.id, "nochmal")).rejects.toThrow(/bereits korrigiert/);
    await expect(reverseReceipt(c.mgr!, rev.id, "Gegenbuchung")).rejects.toThrow(/nicht erneut/);
    const after = await getOrderReceiving(c.mgr!, orderId);
    expect(after.receivedNet.toString()).toBe("0");
    expect(after.status).toBe("NOT_RECEIVED");
    await expect(db.goodsReceipt.update({ where: { id: original.id }, data: { note: "manipuliert" } })).rejects.toThrow(/append-only/);
    await expect(db.goodsReceipt.delete({ where: { id: original.id } })).rejects.toThrow(/append-only/);
  });

  it("Mandantentrennung: fremde Organisation sieht und bucht nichts", async () => {
    await expect(getOrderReceiving(c.finB!, orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordReceipt(c.finB!, { orderId, receivedOn: today, lines: [{ requestLineId: line.b, quantity: "1" }] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("parallele Wareneingänge überschreiten die Bestellmenge nicht", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => recordReceipt(c.mgr!, { orderId, receivedOn: today, lines: [{ requestLineId: line.b, quantity: "2" }] })));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2); // 5 offen → 2 × 2, der Rest bleibt abgelehnt
    expect((await getOrderReceiving(c.mgr!, orderId)).lines.find((l) => l.id === line.b)!.received.toString()).toBe("4");
  });
});

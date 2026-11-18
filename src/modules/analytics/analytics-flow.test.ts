import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createCostCenter } from "@/modules/masterdata/service";
import { createSupplier } from "@/modules/procurement/service";
import { createAccount, createCreditNoteDraft, createCustomer, createCustomerInvoice, createTaxCode, issueCustomerInvoice, listAccounts, setCustomerAccounts } from "@/modules/finance/service";
import { exportReportCsv, listReports, REPORTS, runReport } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const year = new Date().getUTCFullYear();
const iso = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe.skipIf(!hasDb)("Analysen", () => {
  let tenantId = "", orgA = "", orgB = "";
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
  const invoice = async (date: string, price: string, extra: Record<string, unknown> = {}) => {
    const inv = await createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: date, lines: [{ description: "Leistung", quantity: "1", unitPrice: price, taxCodeId: ids.ust20 }], ...extra });
    await issueCustomerInvoice(c.fin!, inv.id);
    return inv.id;
  };
  const row = (res: Awaited<ReturnType<typeof runReport>>, key: string, value: string) => res.rows.find((r) => r[key]?.includes(value));

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-AN" } })).id;
    orgA = await makeOrg("TEST-AN-A");
    orgB = await makeOrg("TEST-AN-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");

    await createAccount(c.fin!, { number: "4000", name: "Erlöse", type: "GL" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    ids.ust20 = (await createTaxCode(c.fin!, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    ids.customer = (await createCustomer(c.fin!, { number: "K1", name: "Kunde" })).id;
    await setCustomerAccounts(c.fin!, ids.customer!, { uid: "", accountId: acc["20001"], lineAccountId: acc["4000"] });
    ids.cc = (await createCostCenter(c.fin!, { code: "AN1", name: "Analyse" })).id;
    ids.s1 = (await createSupplier(c.fin!, { number: "S1", name: "=HYPERLINK(\"http://evil\")" })).id;
    ids.s2 = (await createSupplier(c.fin!, { number: "S2", name: "Normaler Lieferant" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      for (const m of ["outboxEvent", "auditLog", "expenseReport", "quote", "purchaseOrder", "supplier", "costCenter", "customerInvoice", "customer", "taxCode", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Berichtsliste folgt den Rechten: Analysen-Recht plus Recht auf die Daten", async () => {
    await expect(listReports(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    const fin = (await listReports(c.fin!)).map((r) => r.id);
    expect(fin).toEqual(expect.arrayContaining(["revenue", "receivables", "purchasing", "budget", "projects", "expenses", "quotes", "inventory"]));
    const mgr = (await listReports(c.mgr!)).map((r) => r.id);
    expect(mgr).not.toContain("revenue"); // Führungskraft ohne Finanzrecht
    expect(mgr).not.toContain("expenses");
    expect(mgr).toEqual(expect.arrayContaining(["purchasing", "quotes", "projects", "inventory"]));
    await expect(runReport(c.mgr!, "revenue", year)).rejects.toBeInstanceOf(ForbiddenError); // nicht erzwingbar
    await expect(runReport(c.fin!, "gibt-es-nicht", year)).rejects.toBeInstanceOf(NotFoundError);
    await expect(runReport(c.fin!, "revenue", 1999)).rejects.toBeInstanceOf(ConflictError);
    expect(REPORTS.every((r) => r.id && r.title && r.description)).toBe(true);
  });

  it("Umsatz je Monat: Netto, Gutschriften abgezogen, Entwürfe zählen nicht, nur die eigene Organisation", async () => {
    await invoice(iso(3, 10), "100");
    const b = await invoice(iso(3, 20), "50");
    const cn = await createCreditNoteDraft(c.fin!, b);
    await issueCustomerInvoice(c.fin!, cn.id); // Gutschrift mit Datum von heute
    await createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: iso(3, 25), lines: [{ description: "Entwurf", quantity: "1", unitPrice: "999", taxCodeId: ids.ust20 }] });
    const res = await runReport(c.fin!, "revenue", year);
    expect(res.rows).toHaveLength(12);
    const today = new Date();
    const creditMonth = today.getUTCFullYear() === year ? today.getUTCMonth() + 1 : 3;
    const march = Number(res.rows[2]!.net);
    // März: 100 + 50 (+ Gutschrift, falls sie ebenfalls in den März fällt)
    expect(march).toBe(creditMonth === 3 ? 100 : 150);
    expect(res.rows.reduce((a, r) => a + Number(r.net), 0)).toBe(100); // Summe über das Jahr: 150 − 50
    expect(res.chart).toEqual({ labelKey: "month", valueKey: "net", unit: "€" });
    expect(Number((await runReport(c.finB!, "revenue", year)).rows.reduce((a, r) => a + Number(r.net), 0))).toBe(0);
  });

  it("Offene Posten, Einkauf, Angebote, Spesen aus echten Daten", async () => {
    const overdueDue = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const due = new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10);
    await invoice(due, "200", { dueDate: overdueDue });
    const ar = await runReport(c.fin!, "receivables", year);
    expect(Number(row(ar, "bucket", "31–60")!.open)).toBe(240); // 200 netto + 20 % USt
    expect(Number(row(ar, "bucket", "nicht fällig")!.open)).toBe(0);

    for (const [s, amount, n] of [["s1", "1000", "PO-A"], ["s1", "500", "PO-B"], ["s2", "300", "PO-C"]] as const)
      await db.purchaseOrder.create({ data: { organizationId: orgA, number: n, supplierId: ids[s]!, costCenterId: ids.cc!, totalAmount: amount } });
    await db.purchaseOrder.create({ data: { organizationId: orgA, number: "PO-X", supplierId: ids.s2!, costCenterId: ids.cc!, totalAmount: "9999", status: "CANCELLED" } });
    const pu = await runReport(c.mgr!, "purchasing", year);
    expect(pu.rows.map((r) => r.total)).toEqual(["1500.00", "300.00"]); // absteigend, Storno nicht gezählt
    expect(pu.rows[0]!.orders).toBe("2");

    for (const [st, n] of [["ACCEPTED", 1], ["ACCEPTED", 2], ["DECLINED", 3], ["SENT", 4], ["DRAFT", 5]] as const)
      await db.quote.create({ data: { organizationId: orgA, customerId: ids.customer!, title: `Q${n}`, validUntil: new Date(), status: st, netTotal: "100", taxTotal: "20", grossTotal: "120", createdById: c.fin!.userId } });
    const q = await runReport(c.mgr!, "quotes", year);
    expect(row(q, "status", "angenommen")!.count).toBe("2");
    expect(q.note).toBe("Annahmequote: 50.0 % (2 von 4 versendeten).");

    await db.expenseReport.create({ data: { organizationId: orgA, employeeId: "e1", title: "R", status: "APPROVED", totalAmount: "80", submittedAt: new Date(Date.UTC(year, 4, 10)) } });
    await db.expenseReport.create({ data: { organizationId: orgA, employeeId: "e1", title: "R2", status: "DRAFT", totalAmount: "500", submittedAt: new Date(Date.UTC(year, 4, 11)) } });
    const ex = await runReport(c.fin!, "expenses", year);
    expect(ex.rows[4]).toMatchObject({ count: "1", total: "80.00" });
  });

  it("CSV-Export: Formelinjektion in Namen wird entschärft, Export steht im Audit-Log, Rechte gelten auch hier", async () => {
    const { filename, csv } = await exportReportCsv(c.mgr!, "purchasing", year);
    expect(filename).toBe(`purchasing-${year}.csv`);
    expect(csv.startsWith("﻿Lieferant;Bestellungen;Volumen (€)\r\n")).toBe(true);
    expect(csv).toContain("\"S1 =HYPERLINK(\"\"http://evil\"\")\"");
    expect(csv).not.toMatch(/(^|;|\n)=HYPERLINK/);
    expect(csv).toContain(";1500,00\r\n");
    expect(await db.auditLog.count({ where: { organizationId: orgA, action: "analytics.export", entityId: "purchasing" } })).toBe(1);
    await expect(exportReportCsv(c.emp!, "purchasing", year)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportReportCsv(c.mgr!, "revenue", year)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

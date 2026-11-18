import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

/**
 * Ist-Kosten je Kostenstelle: Netto der freigegebenen Eingangsrechnungen im Zeitraum (Rechnungsdatum), Gutschriften abgezogen.
 * Kostenstelle der Position, sonst die der Bestellung; ohne beides unter dem Schlüssel "none". Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst.
 */
export async function invoicedNetByCostCenter(tx: Prisma.TransactionClient, organizationId: string, range: { from: Date; to: Date }): Promise<Map<string, Decimal>> {
  const invoices = await tx.supplierInvoice.findMany({
    where: { organizationId, status: "APPROVED", invoiceDate: { gte: range.from, lt: range.to } },
    select: { kind: true, creditsId: true, purchaseOrderId: true, lines: { select: { netAmount: true, costCenterId: true } } },
  });
  // Gutschriften erben den Bestellbezug der ursprünglichen Rechnung
  const origIds = [...new Set(invoices.map((i) => i.creditsId).filter((x): x is string => !!x))];
  const origs = origIds.length ? await tx.supplierInvoice.findMany({ where: { organizationId, id: { in: origIds } }, select: { id: true, purchaseOrderId: true } }) : [];
  const origPo = new Map(origs.map((o) => [o.id, o.purchaseOrderId]));
  const poOf = (i: (typeof invoices)[number]) => i.purchaseOrderId ?? (i.creditsId ? origPo.get(i.creditsId) ?? null : null);
  const poIds = [...new Set(invoices.map(poOf).filter((x): x is string => !!x))];
  const orders = poIds.length ? await tx.purchaseOrder.findMany({ where: { organizationId, id: { in: poIds } }, select: { id: true, costCenterId: true } }) : [];
  const poCc = new Map(orders.map((o) => [o.id, o.costCenterId]));
  const out = new Map<string, Decimal>();
  for (const inv of invoices) {
    const sign = inv.kind === "CREDIT" ? -1 : 1;
    for (const l of inv.lines) {
      const po = poOf(inv);
      const key = l.costCenterId ?? (po ? poCc.get(po) : undefined) ?? "none";
      out.set(key, (out.get(key) ?? new Decimal(0)).plus(new Decimal(l.netAmount.toString()).mul(sign)));
    }
  }
  return out;
}

/** Kunden für das CRM (nur Stammdaten, keine Konten). */
export async function crmCustomers(tx: Prisma.TransactionClient, organizationId: string) {
  return tx.customer.findMany({ where: { organizationId, active: true }, orderBy: { name: "asc" }, select: { id: true, number: true, name: true, street: true, zip: true, city: true, country: true, uid: true, paymentTermsDays: true } });
}

export async function crmCustomer(tx: Prisma.TransactionClient, organizationId: string, id: string) {
  return tx.customer.findFirst({ where: { id, organizationId }, select: { id: true, number: true, name: true, street: true, zip: true, city: true, country: true, uid: true, paymentTermsDays: true, active: true } });
}

/** Letzte Ausgangsrechnungen eines Kunden (Nummer, Datum, Betrag, Status) für die Kundenakte. */
export async function customerInvoiceSummary(tx: Prisma.TransactionClient, organizationId: string, customerId: string) {
  return tx.customerInvoice.findMany({ where: { organizationId, customerId }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, number: true, kind: true, status: true, invoiceDate: true, grossTotal: true, currency: true, paidOn: true } });
}

/** Steuersätze (in Prozent, als Text) je Steuerkennzeichen. */
export async function taxRatesById(tx: Prisma.TransactionClient, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const codes = await tx.taxCode.findMany({ where: { organizationId, id: { in: [...new Set(ids)] } }, select: { id: true, rate: true } });
  return new Map(codes.map((c) => [c.id, c.rate.toString()]));
}

/** Umsatz (netto) ausgestellter Ausgangsrechnungen je Monat eines Kalenderjahres (Rechnungsdatum), Gutschriften abgezogen. Monate 1–12. */
export async function revenueByMonth(tx: Prisma.TransactionClient, organizationId: string, year: number): Promise<Decimal[]> {
  const rows = await tx.$queryRaw<{ m: number; total: Prisma.Decimal }[]>`
    SELECT EXTRACT(MONTH FROM "invoiceDate")::int AS m,
           SUM(CASE WHEN "kind" = 'CREDIT' THEN -"netTotal" ELSE "netTotal" END) AS total
    FROM "CustomerInvoice"
    WHERE "organizationId" = ${organizationId} AND "status" = 'ISSUED'
      AND "invoiceDate" >= ${new Date(Date.UTC(year, 0, 1))} AND "invoiceDate" < ${new Date(Date.UTC(year + 1, 0, 1))}
    GROUP BY 1`;
  const out = Array.from({ length: 12 }, () => new Decimal(0));
  for (const r of rows) out[r.m - 1] = new Decimal(r.total.toString());
  return out;
}

// ───────────────────────── Für das Hauptbuch (Buchungen aus Belegen) ─────────────────────────

export interface PostingDoc {
  id: string;
  type: "CUSTOMER" | "SUPPLIER";
  /** Rechnungsnummer (Ausgang: AR-…, Eingang: Belegnummer ER-… bzw. Nummer des Lieferanten) */
  number: string;
  partyName: string;
  date: string;
  credit: boolean;
  /** Debitoren- bzw. Kreditorenkonto der Gegenseite; fehlt es, kann nicht gebucht werden */
  partyAccountId: string | null;
  lines: { accountId: string; taxCodeId: string; net: Decimal; costCenterId: string | null }[];
  gross: Decimal;
  paidOn: string | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Beleg mit den Angaben für die Buchung. Nur ausgestellte (Ausgang) bzw. freigegebene (Eingang) Belege; sonst null. */
export async function postingDoc(tx: Prisma.TransactionClient, organizationId: string, type: "CUSTOMER" | "SUPPLIER", id: string): Promise<PostingDoc | null> {
  if (type === "CUSTOMER") {
    const i = await tx.customerInvoice.findFirst({ where: { id, organizationId, status: "ISSUED" }, include: { customer: true, lines: true } });
    if (!i || !i.number) return null;
    return {
      id, type, number: i.number, partyName: i.customer.name, date: iso(i.invoiceDate), credit: i.kind === "CREDIT", partyAccountId: i.customer.receivableAccountId,
      lines: i.lines.map((l) => ({ accountId: l.revenueAccountId, taxCodeId: l.taxCodeId, net: new Decimal(l.netAmount.toString()), costCenterId: l.costCenterId })), gross: new Decimal(i.grossTotal.toString()), paidOn: i.paidOn ? iso(i.paidOn) : null,
    };
  }
  const i = await tx.supplierInvoice.findFirst({ where: { id, organizationId, status: "APPROVED" }, include: { supplier: true, lines: true } });
  if (!i) return null;
  return {
    id, type, number: i.voucherNumber ?? i.invoiceNumber, partyName: i.supplier.name, date: iso(i.invoiceDate), credit: i.kind === "CREDIT", partyAccountId: i.supplier.payableAccountId,
    lines: i.lines.map((l) => ({ accountId: l.expenseAccountId ?? "", taxCodeId: l.taxCodeId, net: new Decimal(l.netAmount.toString()), costCenterId: l.costCenterId })), gross: new Decimal(i.grossTotal.toString()), paidOn: i.paidOn ? iso(i.paidOn) : null,
  };
}

/** Steuerkennzeichen mit Steuerkonto und Satz, je Kennung. */
export async function taxInfoMap(tx: Prisma.TransactionClient, organizationId: string) {
  const codes = await tx.taxCode.findMany({ where: { organizationId } });
  return new Map(codes.map((t) => [t.id, { rate: new Decimal(t.rate.toString()), vatAccountId: t.vatAccountId, key: t.key }]));
}

/** Zu zahlender Betrag eines Belegs: Brutto abzüglich bezogener Gutschriften (wie der Bankabgleich). */
export async function payableAmount(tx: Prisma.TransactionClient, organizationId: string, type: "CUSTOMER" | "SUPPLIER", id: string): Promise<Decimal | null> {
  if (type === "CUSTOMER") {
    const inv = await tx.customerInvoice.findFirst({ where: { id, organizationId }, select: { grossTotal: true } });
    if (!inv) return null;
    const credits = await tx.customerInvoice.findMany({ where: { organizationId, status: "ISSUED", kind: "CREDIT", creditsId: id }, select: { grossTotal: true } });
    return credits.reduce((a, c) => a.minus(c.grossTotal.toString()), new Decimal(inv.grossTotal.toString()));
  }
  const inv = await tx.supplierInvoice.findFirst({ where: { id, organizationId }, select: { grossTotal: true } });
  if (!inv) return null;
  const credits = await tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", kind: "CREDIT", creditsId: id }, select: { grossTotal: true } });
  return credits.reduce((a, c) => a.minus(c.grossTotal.toString()), new Decimal(inv.grossTotal.toString()));
}

/** Belege ab einem Datum, die gebucht sein müssten (für das Nachbuchen): Kennungen mit Datum und Zahlungsdatum. */
export async function documentsSince(tx: Prisma.TransactionClient, organizationId: string, from: string) {
  const since = new Date(`${from}T00:00:00Z`);
  const [cust, sup] = await Promise.all([
    tx.customerInvoice.findMany({ where: { organizationId, status: "ISSUED", invoiceDate: { gte: since } }, select: { id: true, paidOn: true, kind: true }, orderBy: { invoiceDate: "asc" } }),
    tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", invoiceDate: { gte: since } }, select: { id: true, paidOn: true, kind: true }, orderBy: { invoiceDate: "asc" } }),
  ]);
  const map = (rows: typeof cust, type: "CUSTOMER" | "SUPPLIER") => rows.map((r) => ({ id: r.id, type, kind: r.kind, paidOn: r.paidOn ? iso(r.paidOn) : null }));
  return [...map(cust, "CUSTOMER"), ...map(sup, "SUPPLIER")];
}

export async function fiscalYearStartMonth(tx: Prisma.TransactionClient, organizationId: string) {
  return (await tx.accountingProfile.findUnique({ where: { organizationId }, select: { fiscalYearStartMonth: true } }))?.fiscalYearStartMonth ?? 1;
}
export { allocateTax } from "./tax";

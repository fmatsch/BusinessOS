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

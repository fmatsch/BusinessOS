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

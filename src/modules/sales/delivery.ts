import { Decimal } from "@/lib/money";

/** Reine Regeln für Lieferung und Abrechnung von Kundenaufträgen (ohne Datenbank). */

export interface OrderLineQty { id: string; quantity: Decimal }
export interface OpenQty { id: string; ordered: Decimal; committed: Decimal; open: Decimal }

/** Je Position: bestellt, bereits geliefert bzw. in Entwürfen eingeplant (`committed`) und noch offen. */
export function openQuantities(lines: OrderLineQty[], committedByLine: Map<string, Decimal>): OpenQty[] {
  return lines.map((l) => {
    const committed = committedByLine.get(l.id) ?? new Decimal(0);
    return { id: l.id, ordered: l.quantity, committed, open: Decimal.max(0, l.quantity.minus(committed)) };
  });
}

/** Meldet die erste Lieferposition, die mehr liefert als offen ist (keine Übermengen). */
export function overDelivery(open: OpenQty[], requested: { orderLineId: string; quantity: Decimal }[]): string | null {
  const sums = new Map<string, Decimal>();
  for (const r of requested) sums.set(r.orderLineId, (sums.get(r.orderLineId) ?? new Decimal(0)).plus(r.quantity));
  for (const [id, q] of sums) {
    const o = open.find((x) => x.id === id);
    if (!o) return "Position gehört nicht zum Auftrag";
    if (q.gt(o.open)) return `Es sind nur noch ${o.open.toString()} offen (gewünscht ${q.toString()})`;
  }
  return null;
}

export interface BillOrderLine { id: string; description: string; unitPrice: Decimal; taxCodeId: string; revenueAccountId: string | null }
export interface BillingLine { orderLineId: string; description: string; quantity: Decimal; unitPrice: Decimal; taxCodeId: string; revenueAccountId: string | null }

/** Rechnungspositionen aus gelieferten, noch nicht abgerechneten Mengen – je Auftragsposition zusammengefasst, in Auftragsreihenfolge. */
export function billingLines(orderLines: BillOrderLine[], unbilled: { orderLineId: string; quantity: Decimal }[]): BillingLine[] {
  const sums = new Map<string, Decimal>();
  for (const u of unbilled) sums.set(u.orderLineId, (sums.get(u.orderLineId) ?? new Decimal(0)).plus(u.quantity));
  return orderLines.filter((l) => (sums.get(l.id) ?? new Decimal(0)).gt(0)).map((l) => ({ orderLineId: l.id, description: l.description, quantity: sums.get(l.id)!, unitPrice: l.unitPrice, taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId }));
}

/** Auftrag ist erledigt, wenn alles geliefert (nicht nur eingeplant) und alles abgerechnet ist. */
export function isOrderDone(lines: OrderLineQty[], shipped: Map<string, Decimal>, billed: Map<string, Decimal>): boolean {
  return lines.length > 0 && lines.every((l) => (shipped.get(l.id) ?? new Decimal(0)).gte(l.quantity) && (billed.get(l.id) ?? new Decimal(0)).gte(l.quantity));
}

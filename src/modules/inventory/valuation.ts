import { Decimal } from "@/lib/money";

/**
 * Lagerbewertung aus dem Bewegungsjournal (rein, ohne Datenbank).
 * Gleitender Durchschnitt (AVG) oder FIFO. Bewertet wird je Artikel; Umbuchungen zwischen Lagerorten ändern den Wert nicht.
 * Die Bewertung wird bei Bedarf aus dem Journal berechnet und nirgends gespeichert – sie kann deshalb nicht von den Bewegungen abweichen.
 */

export type ValuationMethod = "AVG" | "FIFO";
export interface ValuationInput {
  id: string;
  kind: string;
  quantity: Decimal;
  /** Einstandspreis je Einheit (Wareneingang) */
  unitCost: Decimal | null;
  reversesId: string | null;
}
export interface ValuedMovement { id: string; unitCost: Decimal; /** mit Vorzeichen wie die Menge */ value: Decimal }
export interface ValuationResult { movements: ValuedMovement[]; quantity: Decimal; value: Decimal; averageCost: Decimal }

const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const r6 = (d: Decimal) => d.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

export function valueMovements(method: ValuationMethod, movements: ValuationInput[]): ValuationResult {
  const out: ValuedMovement[] = [];
  const costOf = new Map<string, Decimal>();
  let qty = new Decimal(0), val = new Decimal(0);
  const layers: { qty: Decimal; cost: Decimal }[] = [];
  const avg = () => (qty.gt(0) ? val.div(qty) : new Decimal(0));

  for (const m of movements) {
    if (m.kind === "TRANSFER_OUT" || m.kind === "TRANSFER_IN") continue;
    if (m.quantity.gt(0)) {
      const cost = m.unitCost ?? (m.reversesId ? costOf.get(m.reversesId) : undefined) ?? (method === "FIFO" && layers.length ? layers[layers.length - 1]!.cost : r6(avg()));
      const value = r2(m.quantity.times(cost));
      qty = qty.plus(m.quantity); val = val.plus(value);
      if (method === "FIFO") layers.push({ qty: m.quantity, cost });
      costOf.set(m.id, cost);
      out.push({ id: m.id, unitCost: cost, value });
    } else if (m.quantity.lt(0)) {
      const n = m.quantity.negated();
      const take = Decimal.min(n, qty);
      let value = new Decimal(0);
      if (method === "AVG") {
        value = take.eq(qty) ? val : r2(take.times(avg()));
      } else {
        let left = take;
        while (left.gt(0) && layers.length) {
          const l = layers[0]!;
          const used = Decimal.min(left, l.qty);
          value = value.plus(r2(used.times(l.cost)));
          l.qty = l.qty.minus(used); left = left.minus(used);
          if (l.qty.lte(0)) layers.shift();
        }
        if (take.eq(qty)) value = val; // Restwert vollständig abbauen (Rundung)
      }
      val = val.minus(value); qty = qty.minus(take);
      const cost = n.gt(0) ? r6(value.div(n)) : new Decimal(0);
      costOf.set(m.id, cost);
      out.push({ id: m.id, unitCost: cost, value: value.negated() });
    }
  }
  return { movements: out, quantity: qty, value: val, averageCost: r6(avg()) };
}

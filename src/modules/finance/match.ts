import Decimal from "decimal.js";

/** Voreinstellung der Toleranz: die größere von 2 % der Rechnungssumme oder 5 € (je Organisation später konfigurierbar). */
export const DEFAULT_TOLERANCE = { percent: "2", amount: "5" } as const;

export type MatchInput = {
  /** Bestellwert netto (Menge × Preis aller Bestellpositionen) */
  orderedNet: Decimal.Value;
  /** Wert der gelieferten Ware netto (gelieferte Menge × Bestellpreis, Gegenbuchungen abgezogen) */
  receivedNet: Decimal.Value;
  /** Netto bereits freigegebener Rechnungen zu dieser Bestellung (Gutschriften abgezogen) */
  alreadyInvoicedNet: Decimal.Value;
  /** Netto der zu prüfenden Rechnung */
  invoiceNet: Decimal.Value;
};

export type Variance = { code: "EXCEEDS_RECEIVED" | "EXCEEDS_ORDER"; excess: Decimal; message: string };
export type MatchResult = { status: "OK" | "VARIANCE"; variances: Variance[]; allowed: Decimal; billableReceived: Decimal; billableOrder: Decimal };

const eur = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2).replace(".", ",") + " €";

/** Reiner Drei-Wege-Abgleich (Bestellung – Wareneingang – Rechnung). Keine Datenbank, keine Seiteneffekte. */
export function matchInvoice(input: MatchInput, tolerance: { percent: Decimal.Value; amount: Decimal.Value } = DEFAULT_TOLERANCE): MatchResult {
  const ordered = new Decimal(input.orderedNet), received = new Decimal(input.receivedNet);
  const already = new Decimal(input.alreadyInvoicedNet), inv = new Decimal(input.invoiceNet);
  const allowed = Decimal.max(new Decimal(tolerance.amount), inv.abs().mul(tolerance.percent).div(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const billableReceived = Decimal.max(received.minus(already), 0);
  const billableOrder = Decimal.max(ordered.minus(already), 0);
  const variances: Variance[] = [];
  const overReceived = inv.minus(billableReceived);
  if (overReceived.gt(allowed))
    variances.push({ code: "EXCEEDS_RECEIVED", excess: overReceived, message: `Die Rechnung (${eur(inv)} netto) übersteigt den Wert der gelieferten, noch nicht abgerechneten Ware (${eur(billableReceived)}) um ${eur(overReceived)}.` });
  const overOrder = inv.minus(billableOrder);
  if (overOrder.gt(allowed))
    variances.push({ code: "EXCEEDS_ORDER", excess: overOrder, message: `Die Rechnung übersteigt den noch offenen Bestellwert (${eur(billableOrder)}) um ${eur(overOrder)}.` });
  return { status: variances.length ? "VARIANCE" : "OK", variances, allowed, billableReceived, billableOrder };
}

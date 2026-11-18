import { Decimal } from "@/lib/money";

export interface TaxLineInput {
  net: Decimal.Value;
  /** Steuersatz in Prozent, z. B. 20 */
  rate: Decimal.Value;
  /** Zeilen mit gleichem Schlüssel (Steuerkennzeichen) werden gemeinsam gerundet */
  group: string;
}

export interface TaxResult {
  /** Steuer je Eingabezeile, Summe je Gruppe = Gruppensteuer */
  tax: Decimal[];
  netTotal: Decimal;
  taxTotal: Decimal;
  grossTotal: Decimal;
}

const toCents = (d: Decimal) => d.times(100);

/**
 * Berechnet die Steuer je Steuersatz auf die Summe der Nettobeträge (kaufmännisch auf Cent gerundet, wie auf der Rechnung ausgewiesen)
 * und verteilt sie nach dem Verfahren der größten Reste auf die Zeilen, damit Summe der Zeilen = Steuer der Gruppe = Betrag auf dem Beleg.
 * Dadurch weichen Brutto- und Nettosummen nie um Cent-Differenzen vom Beleg ab.
 */
export function allocateTax(lines: TaxLineInput[]): TaxResult {
  const tax: Decimal[] = lines.map(() => new Decimal(0));
  const groups = new Map<string, number[]>();
  lines.forEach((l, i) => groups.set(l.group, [...(groups.get(l.group) ?? []), i]));

  for (const idxs of groups.values()) {
    const rate = new Decimal(lines[idxs[0]!]!.rate);
    const groupNet = idxs.reduce((s, i) => s.plus(lines[i]!.net), new Decimal(0));
    const groupCents = groupNet.times(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP); // Steuer der Gruppe in Cent (net × rate/100 × 100)
    const exact = idxs.map((i) => new Decimal(lines[i]!.net).times(rate)); // Zeilensteuer in Cent, mit Nachkommastellen
    const floors = exact.map((e) => e.floor());
    let remainder = groupCents.minus(floors.reduce((s, f) => s.plus(f), new Decimal(0))).toNumber();
    const order = exact.map((e, k) => ({ k, frac: e.minus(floors[k]!) })).sort((a, b) => b.frac.comparedTo(a.frac) || a.k - b.k);
    const cents = floors.map((f) => f);
    for (let n = 0; n < order.length && remainder > 0; n++, remainder--) cents[order[n]!.k] = cents[order[n]!.k]!.plus(1);
    // Bei negativem Rest (Rundung nach unten bei Summe) Cent von den kleinsten Resten wegnehmen
    for (let n = order.length - 1; n >= 0 && remainder < 0; n--, remainder++) cents[order[n]!.k] = cents[order[n]!.k]!.minus(1);
    idxs.forEach((i, k) => (tax[i] = cents[k]!.dividedBy(100)));
  }
  const netTotal = lines.reduce((s, l) => s.plus(l.net), new Decimal(0));
  const taxTotal = tax.reduce((s, t) => s.plus(t), new Decimal(0));
  return { tax, netTotal, taxTotal, grossTotal: netTotal.plus(taxTotal) };
}

export { toCents };

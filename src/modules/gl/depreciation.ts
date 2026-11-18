/** Lineare Abschreibung (AfA) monatsgenau – rein, ohne Datenbank. Keine Halbjahresregel: Abschreibung ab dem Anschaffungsmonat, je Monat gleich, Rundungsrest im letzten Monat. */
import { Decimal } from "@/lib/money";

export interface AssetTerms { cost: Decimal.Value; residual: Decimal.Value; lifeMonths: number; acquiredOn: string /* JJJJ-MM-TT */ }

const ym = (iso: string) => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) });
const index = (y: number, m: number) => y * 12 + (m - 1);

/** Abschreibungsbetrag für den Monat (0 vor Beginn und nach Ende der Nutzungsdauer). */
export function monthlyDepreciation(t: AssetTerms, year: number, month: number): Decimal {
  const start = ym(t.acquiredOn), k = index(year, month) - index(start.y, start.m); // 0 = Anschaffungsmonat
  if (k < 0 || k >= t.lifeMonths) return new Decimal(0);
  const base = new Decimal(t.cost).minus(t.residual);
  if (base.lte(0)) return new Decimal(0);
  const regular = base.div(t.lifeMonths).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (k < t.lifeMonths - 1) return regular;
  return base.minus(regular.times(t.lifeMonths - 1)); // letzter Monat: Rest, damit die Summe genau der Abschreibungsbasis entspricht
}

/** Gesamte bisherige Abschreibung bis einschließlich Monat (rechnerisch). */
export function accumulatedDepreciation(t: AssetTerms, year: number, month: number): Decimal {
  const start = ym(t.acquiredOn);
  const last = Math.min(index(year, month), index(start.y, start.m) + t.lifeMonths - 1);
  let sum = new Decimal(0);
  for (let i = index(start.y, start.m); i <= last; i++) sum = sum.plus(monthlyDepreciation(t, Math.floor(i / 12), (i % 12) + 1));
  return sum;
}

export const bookValue = (t: AssetTerms, year: number, month: number) => new Decimal(t.cost).minus(accumulatedDepreciation(t, year, month));

export function assetTermsProblem(t: { cost: Decimal; residual: Decimal; lifeMonths: number }): string | null {
  if (t.cost.lte(0)) return "Die Anschaffungskosten müssen größer als 0 sein";
  if (t.residual.isNeg() || t.residual.gte(t.cost)) return "Der Restwert muss zwischen 0 und den Anschaffungskosten liegen";
  if (!Number.isInteger(t.lifeMonths) || t.lifeMonths < 1 || t.lifeMonths > 600) return "Die Nutzungsdauer muss 1 bis 600 Monate betragen";
  return null;
}

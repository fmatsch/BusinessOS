import Decimal from "decimal.js";

export { Decimal };

/** Parst Dezimalzahlen mit Punkt oder Komma. Wirft bei ungültiger Eingabe. */
export function parseDecimal(input: string | number | Decimal): Decimal {
  if (input instanceof Decimal) return input;
  const s = String(input).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error("Ungültige Zahl");
  return new Decimal(s);
}

export function formatMoney(amount: Decimal.Value, currency = "EUR", locale = "de-AT"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(new Decimal(amount).toDecimalPlaces(2).toNumber());
}

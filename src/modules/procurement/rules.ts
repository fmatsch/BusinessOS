import { Decimal } from "@/lib/money";

export function computeTotal(lines: { quantity: Decimal.Value; unitPrice: Decimal.Value }[]): Decimal {
  return lines.reduce((sum, l) => sum.plus(new Decimal(l.quantity).times(l.unitPrice)), new Decimal(0));
}

/** Regeln der Spesenabrechnung – rein, ohne Datenbank. */
import { Decimal } from "@/lib/money";

export type ExpenseStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "PAID" | "CANCELLED";

export const STATUS_LABEL: Record<ExpenseStatus, string> = {
  DRAFT: "Entwurf", SUBMITTED: "wartet auf Freigabe", APPROVED: "freigegeben", REJECTED: "abgelehnt", PAID: "ausbezahlt", CANCELLED: "zurückgezogen",
};

const NEXT: Record<ExpenseStatus, ExpenseStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["PAID"],
  REJECTED: [], PAID: [], CANCELLED: [],
};
export const canTransition = (from: ExpenseStatus, to: ExpenseStatus) => NEXT[from].includes(to);

/** Kilometergeld = km × Satz, kaufmännisch auf 2 Nachkommastellen. */
export function mileageAmount(km: Decimal.Value, rate: Decimal.Value) {
  return new Decimal(km).times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sumAmounts(amounts: Decimal.Value[]) {
  return amounts.reduce<Decimal>((a, x) => a.plus(x), new Decimal(0));
}

/** Belege müssen im Zeitraum liegen: nicht in der Zukunft, bei angegebener Reise innerhalb von Beginn bis Ende. */
export function lineDateProblem(date: string, today: string, tripFrom?: string | null, tripTo?: string | null) {
  if (date > today) return "Ausgaben in der Zukunft können nicht abgerechnet werden";
  if (tripFrom && date < tripFrom) return `Die Ausgabe liegt vor dem Reisebeginn (${tripFrom})`;
  if (tripTo && date > tripTo) return `Die Ausgabe liegt nach dem Reiseende (${tripTo})`;
  return null;
}

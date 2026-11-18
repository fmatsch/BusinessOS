/** Regeln für Projektstunden – rein, ohne Datenbank. */
import { Decimal } from "@/lib/money";

export const MAX_MINUTES_PER_DAY = 24 * 60;

/** Stunden (Dezimal, höchstens 2 Nachkommastellen) → ganze Minuten. */
export function hoursToMinutes(hours: Decimal.Value) {
  return new Decimal(hours).times(60).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** Minuten → Stunden, kaufmännisch auf 2 Nachkommastellen (so steht die Menge auf der Rechnung). */
export function minutesToHours(minutes: number) {
  return new Decimal(minutes).div(60).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Nettobetrag einer Abrechnung: gerundete Stunden × Stundensatz (wie auf der Rechnung ausgewiesen). */
export function billingNet(minutes: number, hourlyRate: Decimal.Value) {
  return minutesToHours(minutes).times(hourlyRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Verbrauch des Stundenbudgets in Prozent (ohne Budget: null). */
export function budgetUsedPercent(bookedMinutes: number, budgetHours: Decimal.Value | null | undefined) {
  if (budgetHours == null || new Decimal(budgetHours).lte(0)) return null;
  return new Decimal(bookedMinutes).div(60).div(budgetHours).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** Gebucht werden darf nur an Tagen im Projektzeitraum und nicht in der Zukunft. */
export function bookingDateProblem(workDate: string, today: string, startsOn?: string | null, endsOn?: string | null) {
  if (workDate > today) return "Zeiten können nicht in der Zukunft gebucht werden";
  if (startsOn && workDate < startsOn) return `Das Projekt beginnt erst am ${startsOn}`;
  if (endsOn && workDate > endsOn) return `Das Projekt endete am ${endsOn}`;
  return null;
}

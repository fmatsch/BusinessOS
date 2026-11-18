/** Regeln für wiederkehrende Rechnungen – rein, ohne Datenbank. Datumsangaben als JJJJ-MM-TT. */
export const INTERVALS = ["MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_MONTHS: Record<Interval, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
export const INTERVAL_LABEL: Record<Interval, string> = { MONTHLY: "monatlich", QUARTERLY: "vierteljährlich", YEARLY: "jährlich" };
/** Höchstens so viele Läufe werden bei einem Aufruf nachgeholt (Schutz vor Entwurfsflut nach langer Pause). */
export const MAX_CATCH_UP = 12;

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1–12

/** Verschiebt ein Datum um Monate und hält den Ankertag (31. → 28./30. und wieder 31.). */
export function addMonthsClamped(iso: string, months: number, anchorDay: number) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(ny, nm));
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function nextRun(runDate: string, interval: Interval, anchorDay: number) {
  return addMonthsClamped(runDate, INTERVAL_MONTHS[interval], anchorDay);
}

/** Alle bis heute fälligen Rechnungsdaten (höchstens `max`), unter Beachtung des Enddatums. */
export function dueRuns(input: { nextRunOn: string; interval: Interval; anchorDay: number; endsOn?: string | null; today: string; max?: number }) {
  const out: string[] = [];
  let d = input.nextRunOn;
  while (d <= input.today && (!input.endsOn || d <= input.endsOn) && out.length < (input.max ?? MAX_CATCH_UP)) {
    out.push(d);
    d = nextRun(d, input.interval, input.anchorDay);
  }
  return out;
}

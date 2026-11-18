/**
 * Regeln für Offene Posten und Mahnungen – rein, ohne Datenbank. Datumsangaben als JJJJ-MM-TT.
 * Verzugszinsen und Mahnspesen werden nicht berechnet; eine Gebühr kann manuell eingetragen werden.
 */
export const MAX_LEVEL = 3;
/** Frühestens so viele Tage nach Fälligkeit darf die erste Mahnstufe erstellt werden. */
export const MIN_DAYS_OVERDUE = 1;
/** Mindestabstand zwischen zwei Mahnungen zur selben Rechnung. */
export const MIN_DAYS_BETWEEN = 14;
/** Zahlungsfrist, die in der Mahnung gesetzt wird. */
export const PAYMENT_DAYS = 7;

export const LEVEL_TITLE: Record<number, string> = { 1: "Zahlungserinnerung", 2: "1. Mahnung", 3: "Letzte Mahnung" };

const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Ganze Tage von a bis b (b später → positiv). */
export function daysBetween(a: string, b: string) {
  return Math.round((utc(b) - utc(a)) / DAY);
}

export function addDaysIso(iso: string, days: number) {
  return new Date(utc(iso) + days * DAY).toISOString().slice(0, 10);
}

export type AgeBucket = "NOT_DUE" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";
export const BUCKET_LABEL: Record<AgeBucket, string> = { NOT_DUE: "nicht fällig", D1_30: "1–30 Tage", D31_60: "31–60 Tage", D61_90: "61–90 Tage", D90_PLUS: "über 90 Tage" };

export function bucketOf(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return "NOT_DUE";
  if (daysOverdue <= 30) return "D1_30";
  if (daysOverdue <= 60) return "D31_60";
  if (daysOverdue <= 90) return "D61_90";
  return "D90_PLUS";
}

export type NextDunning = { allowed: true; level: number } | { allowed: false; reason: string };

/** Welche Mahnstufe ist als Nächstes möglich? */
export function nextDunning(input: { dueDate: string; today: string; lastLevel: number; lastNoticeOn?: string | null }): NextDunning {
  const overdue = daysBetween(input.dueDate, input.today);
  if (overdue < MIN_DAYS_OVERDUE) return { allowed: false, reason: "Die Rechnung ist noch nicht fällig" };
  if (input.lastLevel >= MAX_LEVEL) return { allowed: false, reason: "Die höchste Mahnstufe ist bereits erreicht" };
  if (input.lastNoticeOn && daysBetween(input.lastNoticeOn, input.today) < MIN_DAYS_BETWEEN)
    return { allowed: false, reason: `Seit der letzten Mahnung sind weniger als ${MIN_DAYS_BETWEEN} Tage vergangen` };
  return { allowed: true, level: input.lastLevel + 1 };
}

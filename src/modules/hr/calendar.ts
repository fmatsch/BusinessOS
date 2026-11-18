/**
 * Kalenderfunktionen für Abwesenheiten. Datumswerte sind ISO-Strings (YYYY-MM-DD) ohne Zeitzone,
 * damit Sommerzeit und Serverzeitzone keine Rolle spielen.
 * Annahmen (siehe MODULES.md): 5-Tage-Woche Mo–Fr, gesetzliche Feiertage Österreichs.
 * Länderspezifische Kalender und Teilzeit-Arbeitstage folgen mit der Zeiterfassung (M9).
 */

const pad = (n: number) => String(n).padStart(2, "0");
export const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fromUtc = (d: Date) => isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

export function addDays(iso: string, n: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** Ostersonntag (gregorianisch, anonymer Algorithmus). */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoOf(year, month, day);
}

const holidayCache = new Map<number, Map<string, string>>();

/** Gesetzliche Feiertage Österreichs (ohne regionale/branchenspezifische Feiertage). */
export function austrianHolidays(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const list: [string, string][] = [
    [isoOf(year, 1, 1), "Neujahr"],
    [isoOf(year, 1, 6), "Heilige Drei Könige"],
    [addDays(easter, 1), "Ostermontag"],
    [isoOf(year, 5, 1), "Staatsfeiertag"],
    [addDays(easter, 39), "Christi Himmelfahrt"],
    [addDays(easter, 50), "Pfingstmontag"],
    [addDays(easter, 60), "Fronleichnam"],
    [isoOf(year, 8, 15), "Mariä Himmelfahrt"],
    [isoOf(year, 10, 26), "Nationalfeiertag"],
    [isoOf(year, 11, 1), "Allerheiligen"],
    [isoOf(year, 12, 8), "Mariä Empfängnis"],
    [isoOf(year, 12, 25), "Christtag"],
    [isoOf(year, 12, 26), "Stefanitag"],
  ];
  const map = new Map(list);
  holidayCache.set(year, map);
  return map;
}

export function isWorkingDay(iso: string): boolean {
  const dow = toUtc(iso).getUTCDay(); // 0 = Sonntag
  if (dow === 0 || dow === 6) return false;
  return !austrianHolidays(Number(iso.slice(0, 4))).has(iso);
}

/** Arbeitstage je Kalenderjahr im Zeitraum (inklusive Grenzen). */
export function workingDaysByYear(from: string, to: string): Map<number, number> {
  const result = new Map<number, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    const y = Number(d.slice(0, 4));
    result.set(y, (result.get(y) ?? 0) + 1);
  }
  return result;
}

export function countWorkingDays(from: string, to: string): number {
  let n = 0;
  for (const v of workingDaysByYear(from, to).values()) n += v;
  return n;
}

export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string | null): boolean {
  return aFrom <= (bTo ?? "9999-12-31") && bFrom <= aTo;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000) + 1;
}

export const isoFromDate = fromUtc;
export const dateFromIso = toUtc;

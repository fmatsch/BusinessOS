import { addDaysIso, austrianHolidays, isWorkingDay, offsetMinutes, zonedToUtc } from "./deps";

/** Kalendermonat in Ortszeit als UTC-Zeitraum [from, to). */
export function monthBounds(year: number, month: number, tz: string) {
  const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const nextYear = month === 12 ? year + 1 : year, nextMonth = month === 12 ? 1 : month + 1;
  const nextFirst = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  return { firstDay: first, lastDay: addDaysIso(nextFirst, -1), nextFirstDay: nextFirst, from: zonedToUtc(first, "00:00", tz), to: zonedToUtc(nextFirst, "00:00", tz) };
}

export function daysOfMonth(year: number, month: number): string[] {
  const b = monthBounds(year, month, "UTC");
  const out: string[] = [];
  for (let d = b.firstDay; d <= b.lastDay; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

export interface CategoryMinutes {
  /** Bruttominuten des Intervalls (ohne Pausenabzug) */
  gross: number;
  /** davon Nachtzeit (22:00–06:00 Ortszeit) */
  night: number;
  /** davon an Sonntagen */
  sunday: number;
  /** davon an gesetzlichen Feiertagen (Österreich) */
  holiday: number;
}

export const NIGHT_START = 22 * 60;
export const NIGHT_END = 6 * 60;

/**
 * Teilt ein Intervall minutengenau in Zuschlagskategorien (nach Ortszeit). Kategorien überschneiden sich (Sonntagnacht zählt in beiden).
 * Pausen werden nicht abgezogen, weil ihre Lage unbekannt ist; der Aufrufer rechnet anteilig (siehe `scaleToNet`).
 */
export function categoryMinutes(start: Date, end: Date, tz: string): CategoryMinutes {
  const res: CategoryMinutes = { gross: 0, night: 0, sunday: 0, holiday: 0 };
  let offset = 0;
  let offsetHour = -1;
  const holidayYears = new Map<number, Map<string, string>>();
  for (let t = Math.floor(start.getTime() / 60_000); t < Math.floor(end.getTime() / 60_000); t++) {
    const hour = Math.floor(t / 60);
    if (hour !== offsetHour) { offset = offsetMinutes(new Date(hour * 3_600_000), tz); offsetHour = hour; }
    const local = new Date((t + offset) * 60_000); // „UTC-Felder" zeigen die Ortszeit
    const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
    res.gross++;
    if (minuteOfDay >= NIGHT_START || minuteOfDay < NIGHT_END) res.night++;
    if (local.getUTCDay() === 0) res.sunday++;
    const y = local.getUTCFullYear();
    let hol = holidayYears.get(y);
    if (!hol) holidayYears.set(y, (hol = austrianHolidays(y)));
    if (hol.has(local.toISOString().slice(0, 10))) res.holiday++;
  }
  return res;
}

/** Rechnet Brutto-Kategorieminuten anteilig auf Nettoarbeitszeit (Pausenabzug) um. */
export function scaleToNet(c: CategoryMinutes, netMinutes: number): CategoryMinutes {
  if (c.gross <= 0) return { gross: 0, night: 0, sunday: 0, holiday: 0 };
  const f = netMinutes / c.gross;
  return { gross: netMinutes, night: Math.round(c.night * f), sunday: Math.round(c.sunday * f), holiday: Math.round(c.holiday * f) };
}

export const dailyTargetMinutes = (weeklyHours: number | string) => Math.round((Number(weeklyHours) * 60) / 5);

export interface EmploymentSlice { from: string; to: string | null; weeklyHours: string }

/**
 * Sollzeit des Monats: je Arbeitstag (Mo–Fr ohne Feiertag) mit gültigem Beschäftigungsverhältnis Wochenstunden/5.
 * Tage mit genehmigter Abwesenheit zählen als erfüllt (Soll 0). Annahme: 5-Tage-Woche (siehe MODULES.md).
 */
export function monthTarget(year: number, month: number, employments: EmploymentSlice[], absenceDays: Set<string>) {
  let targetMinutes = 0;
  let coveredDays = 0;
  const perDay = new Map<string, number>();
  for (const day of daysOfMonth(year, month)) {
    if (!isWorkingDay(day)) continue;
    const e = employments.find((x) => x.from <= day && (x.to === null || x.to >= day));
    if (!e) continue;
    coveredDays++;
    if (absenceDays.has(day)) continue;
    const m = dailyTargetMinutes(e.weeklyHours);
    perDay.set(day, m);
    targetMinutes += m;
  }
  return { targetMinutes, coveredDays, perDay };
}

export function absenceDaySet(ranges: { from: string; to: string }[], year: number, month: number): Set<string> {
  const set = new Set<string>();
  const days = new Set(daysOfMonth(year, month));
  for (const r of ranges) for (let d = r.from; d <= r.to; d = addDaysIso(d, 1)) if (days.has(d)) set.add(d);
  return set;
}

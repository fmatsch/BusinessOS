import { addDaysIso, localDateOf, mondayOf, zonedToUtc } from "./timezone";

/**
 * Regelprüfung für Dienstpläne – reine Funktionen. Voreinstellung orientiert sich am österreichischen Arbeitszeitgesetz
 * (11 h Tagesruhe, 12 h/Tag, 60 h/Woche, 30 min Pause ab 6 h, 36 h Wochenruhe), ist aber je Organisation überschreibbar
 * (Kollektivvertrag, Betriebsvereinbarung). Keine Rechtsberatung.
 *
 * Vereinfachungen: Arbeitszeit wird dem Tag/der Woche des Schichtbeginns zugerechnet; die Wochenruhe wird als längste
 * Pause im Wochenfenster geprüft (Warnung, keine Sperre).
 */

export interface RuleParams {
  restDailyMinutes: number;
  maxDailyMinutes: number;
  maxWeeklyMinutes: number;
  breakAfterMinutes: number;
  minBreakMinutes: number;
  weeklyRestMinutes: number;
}

export const DEFAULT_RULES: RuleParams = {
  restDailyMinutes: 660,
  maxDailyMinutes: 720,
  maxWeeklyMinutes: 3600,
  breakAfterMinutes: 360,
  minBreakMinutes: 30,
  weeklyRestMinutes: 2160,
};

export interface Span {
  shiftId: string;
  start: Date;
  end: Date;
  breakMinutes: number;
}

export type ViolationCode =
  | "INVALID_SHIFT" | "BREAK" | "MAX_DAILY" | "MAX_WEEKLY" | "REST_DAILY" | "WEEKLY_REST" | "DOUBLE_BOOKING"
  | "ABSENCE" | "QUALIFICATION" | "NOT_EMPLOYED" | "UNDERSTAFFED" | "OVERSTAFFED";

export interface Violation {
  code: ViolationCode;
  /** ERROR blockiert Zuweisung/Veröffentlichung, WARNING weist nur hin */
  severity: "ERROR" | "WARNING";
  message: string;
  shiftIds: string[];
  employeeId?: string;
}

const MIN = 60_000;
export const durationMinutes = (s: Pick<Span, "start" | "end">) => Math.round((s.end.getTime() - s.start.getTime()) / MIN);
export const workMinutes = (s: Span) => durationMinutes(s) - s.breakMinutes;
const hours = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;

/** Prüfungen, die nur die Schicht selbst betreffen. */
export function checkShiftDefinition(s: Span, rules: RuleParams): Violation[] {
  const v: Violation[] = [];
  const dur = durationMinutes(s);
  if (dur <= 0) return [{ code: "INVALID_SHIFT", severity: "ERROR", message: "Das Ende muss nach dem Beginn liegen", shiftIds: [s.shiftId] }];
  if (s.breakMinutes < 0 || s.breakMinutes >= dur) v.push({ code: "INVALID_SHIFT", severity: "ERROR", message: "Die Pause muss kürzer als die Schicht sein", shiftIds: [s.shiftId] });
  if (dur > rules.breakAfterMinutes && s.breakMinutes < rules.minBreakMinutes)
    v.push({ code: "BREAK", severity: "ERROR", message: `Bei mehr als ${hours(rules.breakAfterMinutes)} Schichtlänge sind mindestens ${rules.minBreakMinutes} min Pause nötig`, shiftIds: [s.shiftId] });
  if (workMinutes(s) > rules.maxDailyMinutes)
    v.push({ code: "MAX_DAILY", severity: "ERROR", message: `Die Schicht überschreitet die Höchstarbeitszeit von ${hours(rules.maxDailyMinutes)}`, shiftIds: [s.shiftId] });
  return v;
}

export function checkStaffing(shiftId: string, required: number, assigned: number): Violation[] {
  if (assigned < required) return [{ code: "UNDERSTAFFED", severity: "WARNING", message: `Unterbesetzt: ${assigned} von ${required} Personen`, shiftIds: [shiftId] }];
  if (assigned > required) return [{ code: "OVERSTAFFED", severity: "WARNING", message: `Überbesetzt: ${assigned} statt ${required} Personen`, shiftIds: [shiftId] }];
  return [];
}

/** Alle Schichten einer Person (auch aus anderen Plänen) gemeinsam prüfen. `tz` = Zeitzone für Tages-/Wochengrenzen. */
export function checkPerson(spans: Span[], rules: RuleParams, tz: string, employeeId?: string): Violation[] {
  const v: Violation[] = [];
  const add = (x: Omit<Violation, "employeeId">) => v.push({ ...x, employeeId });
  const sorted = [...spans].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    // Überschneidung mit irgendeiner früheren Schicht (nicht nur der direkt vorhergehenden)
    const overlapping = sorted.slice(0, i + 1).filter((p) => p.end.getTime() > b.start.getTime());
    if (overlapping.length > 0) {
      add({ code: "DOUBLE_BOOKING", severity: "ERROR", message: "Überschneidende Schichten", shiftIds: [...overlapping.map((o) => o.shiftId), b.shiftId] });
      continue;
    }
    const gap = Math.round((b.start.getTime() - a.end.getTime()) / MIN);
    if (gap < rules.restDailyMinutes)
      add({ code: "REST_DAILY", severity: "ERROR", message: `Nur ${hours(gap)} Ruhezeit zwischen zwei Schichten (nötig: ${hours(rules.restDailyMinutes)})`, shiftIds: [a.shiftId, b.shiftId] });
  }

  const byDay = new Map<string, Span[]>();
  const byWeek = new Map<string, Span[]>();
  for (const s of sorted) {
    const day = localDateOf(s.start, tz);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(s);
    const wk = mondayOf(day);
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(s);
  }
  for (const [day, list] of byDay) {
    const total = list.reduce((n, s) => n + workMinutes(s), 0);
    if (list.length > 1 && total > rules.maxDailyMinutes)
      add({ code: "MAX_DAILY", severity: "ERROR", message: `${day}: ${hours(total)} Arbeitszeit am Tag (Höchstens ${hours(rules.maxDailyMinutes)})`, shiftIds: list.map((s) => s.shiftId) });
  }
  for (const [wk, list] of byWeek) {
    const total = list.reduce((n, s) => n + workMinutes(s), 0);
    if (total > rules.maxWeeklyMinutes)
      add({ code: "MAX_WEEKLY", severity: "ERROR", message: `Woche ab ${wk}: ${hours(total)} Arbeitszeit (Höchstens ${hours(rules.maxWeeklyMinutes)})`, shiftIds: list.map((s) => s.shiftId) });

    // Wochenruhe: längste Pause, die in das Wochenfenster hineinreicht
    const winStart = zonedToUtc(wk, "00:00", tz).getTime();
    const winEnd = zonedToUtc(addDaysIso(wk, 7), "00:00", tz).getTime();
    let best = 0;
    let prevEnd = -Infinity;
    for (const s of sorted) {
      const gapStart = Math.max(prevEnd, winStart), gapEnd = Math.min(s.start.getTime(), winEnd);
      if (gapEnd > gapStart) best = Math.max(best, gapEnd - gapStart);
      prevEnd = Math.max(prevEnd, s.end.getTime());
    }
    const tail = winEnd - Math.max(prevEnd, winStart);
    if (tail > 0) best = Math.max(best, tail);
    if (Math.round(best / MIN) < rules.weeklyRestMinutes)
      add({ code: "WEEKLY_REST", severity: "WARNING", message: `Woche ab ${wk}: keine zusammenhängende Ruhezeit von ${hours(rules.weeklyRestMinutes)}`, shiftIds: list.map((s) => s.shiftId) });
  }
  return v;
}

export const hasErrors = (v: Violation[]) => v.some((x) => x.severity === "ERROR");

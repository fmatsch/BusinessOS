/**
 * Zeitzonenrechnung ohne Fremdbibliothek (Intl). Schichtzeiten sind Ortszeit des Standorts und werden als UTC-Zeitpunkte
 * gespeichert; Dauern werden immer aus den UTC-Zeitpunkten berechnet (23-/25-Stunden-Tage bei Zeitumstellung stimmen dadurch).
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try { fmt(tz); return true; } catch { return false; }
}

/** Ortszeit-Bestandteile eines UTC-Zeitpunkts. */
export function localParts(utc: Date, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(utc).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  const date = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return { date, hour: p.hour!, minute: p.minute!, minutes: p.hour! * 60 + p.minute! };
}

/** Versatz der Zeitzone zu UTC in Minuten zum gegebenen Zeitpunkt. */
export function offsetMinutes(utc: Date, tz: string): number {
  const p = Object.fromEntries(fmt(tz).formatToParts(utc).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(utc.getTime() / 1000) * 1000) / 60000);
}

export class NonexistentLocalTimeError extends Error {
  constructor(date: string, time: string, tz: string) {
    super(`Die Uhrzeit ${time} am ${date} existiert in ${tz} wegen der Zeitumstellung nicht`);
    this.name = "NonexistentLocalTimeError";
  }
}

/**
 * Ortszeit → UTC. Nicht existierende Zeiten (Umstellung auf Sommerzeit) werden abgelehnt;
 * doppelt vorkommende Zeiten (Umstellung auf Winterzeit) ergeben den früheren Zeitpunkt.
 */
export function zonedToUtc(dateIso: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = dateIso.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const offs = new Set([offsetMinutes(new Date(naive - 12 * 3_600_000), tz), offsetMinutes(new Date(naive + 12 * 3_600_000), tz)]);
  const valid = [...offs]
    .map((o) => new Date(naive - o * 60_000))
    .filter((c) => { const l = localParts(c, tz); return l.date === dateIso && l.hour === h && l.minute === mi; })
    .sort((a, b) => a.getTime() - b.getTime());
  if (valid.length === 0) throw new NonexistentLocalTimeError(dateIso, hhmm, tz);
  return valid[0]!;
}

export const localDateOf = (utc: Date, tz: string) => localParts(utc, tz).date;

/** Montag der Woche eines Datums (Kalenderarithmetik, zeitzonenfrei). */
export function mondayOf(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Montag = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Schicht aus Ortszeiten: Ende vor oder gleich Beginn bedeutet „am Folgetag". */
export function shiftInstants(dateIso: string, startTime: string, endTime: string, tz: string) {
  const startAt = zonedToUtc(dateIso, startTime, tz);
  const endDate = endTime <= startTime ? addDaysIso(dateIso, 1) : dateIso;
  const endAt = zonedToUtc(endDate, endTime, tz);
  return { startAt, endAt };
}

/** Fälligkeit von Wartungsplänen (rein): Tage oder Monate, Monatsende wird eingehalten. */

export type IntervalUnit = "DAYS" | "MONTHS";
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Nächste Fälligkeit nach `fromIso` (ISO-Datum) im Abstand `value` Tage bzw. Monate. 31.01. + 1 Monat = 28./29.02. */
export function nextDue(fromIso: string, unit: IntervalUnit, value: number): string {
  if (!Number.isInteger(value) || value < 1) throw new Error("Ungültiges Intervall");
  const [y, m, d] = fromIso.split("-").map(Number) as [number, number, number];
  if (unit === "DAYS") return new Date(Date.UTC(y, m - 1, d + value)).toISOString().slice(0, 10);
  const total = y * 12 + (m - 1) + value;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return iso(ny, nm, Math.min(d, last));
}

/** Tage bis zur Fälligkeit (negativ = überfällig). */
export function daysUntil(dueIso: string, todayIso: string): number {
  return Math.round((Date.parse(`${dueIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
}

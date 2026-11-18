import { createHash } from "node:crypto";
import { WAGE_LABEL, unitOf, type WageType } from "./lines";

export interface CsvProfile {
  delimiter: string;
  decimalSeparator: string;
  includeHeader: boolean;
  encoding: "utf8" | "utf8-bom" | "latin1";
  unit: "HOURS" | "MINUTES";
  includeSurcharge: boolean;
  codes: Partial<Record<WageType, string>>;
}

export interface CsvRow {
  employeeNumber: string;
  wageType: WageType;
  /** Minuten bzw. Tage; in Nachträgen vorzeichenbehaftet */
  quantity: number;
  percent: number | null;
}

/** Textfeld für CSV: Trennzeichen/Anführungszeichen/Zeilenumbrüche maskieren; Formelzeichen am Anfang entschärfen (CSV-Injection). */
export function csvField(value: string, delimiter: string, guardFormulas = true): string {
  let v = value;
  // Zahlenfelder (guardFormulas = false) dürfen mit „-" beginnen (Nachträge mit negativen Mengen)
  if (guardFormulas && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.includes(delimiter) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Menge formatieren: Dezimalstunden (2 Stellen, kaufmännisch gerundet), Minuten oder Tage. Berechnung exakt in Ganzzahlen. */
export function formatQuantity(quantity: number, wageType: WageType, unit: "HOURS" | "MINUTES", decimalSeparator: string): { text: string; unitLabel: string } {
  if (unitOf(wageType) === "DAYS") return { text: String(quantity), unitLabel: "Tage" };
  if (unit === "MINUTES") return { text: String(quantity), unitLabel: "Min" };
  const sign = quantity < 0 ? "-" : "";
  const cents = Math.round((Math.abs(quantity) * 100) / 60); // Minuten → Hundertstel Stunden
  const text = `${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  return { text: text.replace(".", decimalSeparator), unitLabel: "Std" };
}

export function fileNameFor(year: number, month: number, version: number) {
  return `lohnexport-${year}-${String(month).padStart(2, "0")}-${version === 1 ? "erstexport" : `nachtrag${version - 1}`}.csv`;
}

export function buildCsv(rows: CsvRow[], profile: CsvProfile, meta: { year: number; month: number; version: number }): string {
  const d = profile.delimiter;
  const period = `${meta.year}-${String(meta.month).padStart(2, "0")}`;
  const header = ["Personalnummer", "Zeitraum", "Lohnart", "Bezeichnung", "Menge", "Einheit", ...(profile.includeSurcharge ? ["Zuschlag %"] : []), "Lauf"];
  const lines: string[] = profile.includeHeader ? [header.join(d)] : [];
  for (const r of rows) {
    const q = formatQuantity(r.quantity, r.wageType, profile.unit, profile.decimalSeparator);
    const pct = r.percent === null ? "" : String(r.percent).replace(".", profile.decimalSeparator);
    lines.push([
      csvField(r.employeeNumber, d), period, csvField(profile.codes[r.wageType] ?? "", d), csvField(WAGE_LABEL[r.wageType], d),
      csvField(q.text, d, false), q.unitLabel, ...(profile.includeSurcharge ? [csvField(pct, d, false)] : []), String(meta.version),
    ].join(d));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Ausgabebytes gemäß Zeichensatz des Profils (utf8-bom für Excel/Lohnprogramme; latin1 ersetzt nicht darstellbare Zeichen durch ?). */
export function encodeCsv(content: string, encoding: CsvProfile["encoding"]): Buffer {
  if (encoding === "latin1") return Buffer.from(content, "latin1");
  const body = Buffer.from(content, "utf8");
  return encoding === "utf8-bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

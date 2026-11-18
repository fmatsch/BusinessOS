/** CSV für Berichte – rein. Textzellen werden gegen Formelinjektion in Tabellenkalkulationen geschützt, Zahlen bleiben Zahlen. */
export interface CsvColumn { key: string; label: string; numeric?: boolean }

/** Textzelle: Formelanfänge (= + - @ Tab Return) erhalten ein Hochkomma; Anführungszeichen werden verdoppelt. */
export function textCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Zahlenzelle: deutsches Dezimalkomma; ungültige Werte werden leer (kein Textschlupfloch über die Zahlenspalte). */
export function numberCell(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v) ? v.replace(".", ",") : "";
}

export function toCsv(columns: CsvColumn[], rows: Record<string, string>[]): string {
  const head = columns.map((c) => textCell(c.label)).join(";");
  const body = rows.map((r) => columns.map((c) => (c.numeric ? numberCell(r[c.key] ?? "") : textCell(r[c.key] ?? ""))).join(";"));
  return "﻿" + [head, ...body].join("\r\n") + "\r\n"; // BOM: Excel erkennt UTF-8
}

import { amountDe, dateParts, encodeCp1252, pad2 } from "./encoding";
import { sides, type ExportVoucher, type FormatResult } from "./types";

/**
 * DATEV-Format „Buchungsstapel" (EXTF, Version 700, Formatversion 13) – Spaltenliste und Feldlängen nach der öffentlichen DATEV-Formatbeschreibung
 * (hier aus der frei verfügbaren Spezifikation des Projekts pydatev übernommen). Das Format wurde NICHT gegen einen echten DATEV-Import geprüft;
 * vor dem Produktivbetrieb ist ein Testimport mit der Steuerberatung nötig. Der BU-Schlüssel kommt aus der Zuordnung der Steuerkennzeichen.
 */
export const DATEV_COLUMNS = [
  "Umsatz (ohne Soll/Haben-Kz)", "Soll/Haben-Kennzeichen", "WKZ Umsatz", "Kurs", "Basis-Umsatz", "WKZ Basis-Umsatz", "Konto", "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel", "Belegdatum", "Belegfeld 1", "Belegfeld 2", "Skonto", "Buchungstext", "Postensperre", "Diverse Adressnummer", "Geschäftspartnerbank", "Sachverhalt",
  "Zinssperre", "Beleglink",
  ...Array.from({ length: 8 }, (_, i) => [`Beleginfo - Art ${i + 1}`, `Beleginfo - Inhalt ${i + 1}`]).flat(),
  "Kost 1 - Kostenstelle", "Kost 2 - Kostenstelle", "Kost-Menge", "EU-Land u. UStID (Bestimmung)", "EU-Steuersatz (Bestimmung)", "Abw. Versteuerungsart",
  "Sachverhalt L+L", "Funktionsergänzung L+L", "BU 49 Hauptfunktionstyp", "BU 49 Hauptfunktionsnummer", "BU 49 Funktionsergänzung",
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation - Art ${i + 1}`, `Zusatzinformation- Inhalt ${i + 1}`]).flat(),
  "Stück", "Gewicht", "Zahlweise", "Forderungsart", "Veranlagungsjahr", "Zugeordnete Fälligkeit", "Skontotyp", "Auftragsnummer", "Buchungstyp (Anzahlungen)",
  "USt-Schlüssel (Anzahlungen)", "EU-Land (Anzahlungen)", "Sachverhalt L+L (Anzahlungen)", "EU-Steuersatz (Anzahlungen)", "Erlöskonto (Anzahlungen)", "Herkunft-Kz",
  "Buchungs GUID", "Kost-Datum", "SEPA-Mandatsreferenz", "Skontosperre", "Gesellschaftername", "Beteiligtennummer", "Identifikationsnummer", "Zeichnernummer",
  "Postensperre bis", "Bezeichnung SoBil-Sachverhalt", "Kennzeichen SoBil-Buchung", "Festschreibung", "Leistungsdatum", "Datum Zuord. Steuerperiode", "Fälligkeit",
  "Generalumkehr (GU)", "Steuersatz", "Land", "Abrechnungsreferenz", "BVV-Position", "EU-Land u. UStID (Ursprung)", "EU-Steuersatz (Ursprung)", "Abw. Skontokonto",
];

/** Spalten mit Text (werden in Anführungszeichen geschrieben); alle anderen sind Zahlen/Beträge/Daten. */
const COL = Object.fromEntries(DATEV_COLUMNS.map((c, i) => [c, i])) as Record<string, number>;
const TEXT_COLS = new Set(DATEV_COLUMNS.filter((c) => !["Umsatz (ohne Soll/Haben-Kz)", "Kurs", "Basis-Umsatz", "Konto", "Gegenkonto (ohne BU-Schlüssel)", "Belegdatum", "Skonto", "Fälligkeit", "Festschreibung", "Steuersatz"].includes(c)));

export interface DatevProfile {
  advisorNumber: string;
  clientNumber: string;
  accountLength: number;
  /** Beginn des Wirtschaftsjahres als ISO-Datum (JJJJ-MM-TT) */
  fiscalYearStart: string;
  dictationCode: string;
  currency: string;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** Belegfeld 1 erlaubt nur bestimmte Zeichen; alles andere wird zu „_" (max. 36 Stellen). */
export const datevBelegfeld = (s: string, max = 36) => s.replace(/[^A-Za-z0-9$&%*+\-/_.]/g, "_").slice(0, max);
const text = (s: string, max: number) => s.replace(/[\r\n]+/g, " ").slice(0, max);

export function datevHeader(p: DatevProfile, now: Date, from: string, to: string, label: string): string {
  const ts = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
  const d = (iso: string) => iso.replace(/-/g, "");
  return [
    q("EXTF"), 700, 21, q("Buchungsstapel"), 13, ts, "", q("BO"), q(""), q(""), p.advisorNumber, p.clientNumber, d(p.fiscalYearStart), p.accountLength, d(from), d(to),
    q(label.slice(0, 30)), q(p.dictationCode.slice(0, 2)), 1, 0, 0, q(p.currency), "", q(""), "", "", q(""), "", "", q(""), q(""),
  ].join(";");
}

export function buildDatev(vouchers: ExportVoucher[], p: DatevProfile, meta: { version: number; now: Date; label: string }): FormatResult {
  const dates = vouchers.map((v) => v.date).sort();
  const from = dates[0] ?? p.fiscalYearStart, to = dates.at(-1) ?? p.fiscalYearStart;
  const lines: string[] = [datevHeader(p, meta.now, from, to, meta.label), DATEV_COLUMNS.map(q).join(";")];
  let count = 0;
  for (const v of vouchers) {
    for (const l of v.lines) {
      const { debit, credit } = sides(v, l.account, v.personAccount);
      const row: string[] = Array(DATEV_COLUMNS.length).fill("");
      const set = (col: string, value: string) => { row[COL[col]!] = TEXT_COLS.has(col) && value !== "" ? q(value) : value; };
      const { d, m } = dateParts(v.date);
      set("Umsatz (ohne Soll/Haben-Kz)", amountDe(l.gross));
      set("Soll/Haben-Kennzeichen", "S");
      set("WKZ Umsatz", p.currency);
      set("Konto", debit);
      set("Gegenkonto (ohne BU-Schlüssel)", credit);
      set("BU-Schlüssel", l.datevKey ?? "");
      set("Belegdatum", `${d}${m}`);
      set("Belegfeld 1", datevBelegfeld(v.documentNumber));
      set("Belegfeld 2", datevBelegfeld(v.voucherNumber, 12));
      set("Buchungstext", text(`${v.partnerName} ${v.documentNumber}`, 60));
      if (l.costCenter) set("Kost 1 - Kostenstelle", text(l.costCenter, 36));
      if (v.fileName) { set("Beleginfo - Art 1", "Belegdatei"); set("Beleginfo - Inhalt 1", text(v.fileName, 210)); }
      if (v.dueDate) { const f = dateParts(v.dueDate); set("Fälligkeit", `${f.d}${f.m}${f.y}`); }
      set("Herkunft-Kz", "BO");
      lines.push(row.join(";"));
      count++;
    }
  }
  const content = lines.join("\r\n") + "\r\n";
  return { fileName: `EXTF_Buchungsstapel_${String(meta.version).padStart(4, "0")}.csv`, content, bytes: encodeCp1252(content), lineCount: count };
}

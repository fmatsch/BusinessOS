import { amountDe, dateParts, encodeCp1252 } from "./encoding";
import { sides, type ExportVoucher, type FormatResult } from "./types";

/**
 * BMD-Format „BuErf variabel" (Standardformat der BMD für Drittanbieter) nach dem veröffentlichten Handbuch von dvo (Stand 05.10.2021):
 * Semikolon als Trennzeichen, Kopfzeile mit Spaltenbezeichnungen, Satzart 0, Pflichtfelder konto, belegdatum, gkonto, belegnr, steuercode, prozent, betrag, text, buchsymbol.
 * Führt ein Personenkonto die Buchung (konto), gilt der Betrag als Brutto. Mehrere Steuersätze eines Belegs werden als Splittbuchung (gegenbuchkz = O) geschrieben.
 * NICHT gegen ein echtes BMD-System geprüft: Buchcode (1 = Personenkonto im Soll, 2 = im Haben) und Steuercodes müssen mit der Steuerberatung per Testimport bestätigt werden.
 */
export const BMD_COLUMNS = [
  "satzart", "konto", "gkonto", "belegnr", "belegdatum", "buchdat", "betrag", "steuer", "steuercode", "prozent", "text", "buchcode", "buchsymbol",
  "extbelegnr", "zziel", "uidnr", "kost", "gegenbuchkz", "document",
] as const;

export interface BmdProfile {
  symbolIn: string;
  symbolOut: string;
}

/** Text: kein Semikolon, keine Zeilenumbrüche, höchstens 40 Zeichen (längere Texte werden von BMD abgeschnitten). */
export const bmdText = (s: string, max = 40) => s.replace(/[;\r\n]+/g, " ").trim().slice(0, max);

/** Numerischer Teil der internen Belegnummer als BMD-Belegnummer (ER-2027-0001 → 20270001, höchstens 9 Stellen). */
export const bmdBelegnr = (voucherNumber: string) => voucherNumber.replace(/\D/g, "").slice(-9);

export function buildBmd(vouchers: ExportVoucher[], p: BmdProfile, meta: { version: number }): FormatResult {
  const lines: string[] = [BMD_COLUMNS.join(";")];
  let count = 0;
  for (const v of vouchers) {
    const split = v.lines.length > 1;
    const date = dateParts(v.date);
    const dateText = `${date.d}.${date.m}.${date.y}`;
    for (const l of v.lines) {
      const s = sides(v, l.account, v.personAccount);
      const row: Record<(typeof BMD_COLUMNS)[number], string> = {
        satzart: "0", konto: v.personAccount, gkonto: l.account, belegnr: bmdBelegnr(v.voucherNumber), belegdatum: dateText, buchdat: dateText,
        betrag: amountDe(l.gross), steuer: "", steuercode: l.bmdCode ?? "", prozent: l.bmdCode ? String(l.rate.toDecimalPlaces(0)) : "",
        text: bmdText(`${v.partnerName} ${v.documentNumber}`), buchcode: s.personIs === "debit" ? "1" : "2",
        buchsymbol: v.type === "SUPPLIER" ? p.symbolIn : p.symbolOut, extbelegnr: bmdText(v.documentNumber, 35),
        zziel: v.paymentTermsDays !== null ? String(v.paymentTermsDays) : "", uidnr: v.uid ? bmdText(v.uid, 20) : "",
        kost: l.costCenter && /^\d+$/.test(l.costCenter) ? l.costCenter : "", gegenbuchkz: split ? "O" : "E", document: v.fileName ?? "",
      };
      lines.push(BMD_COLUMNS.map((c) => row[c]).join(";"));
      count++;
    }
  }
  const content = lines.join("\r\n") + "\r\n";
  return { fileName: `buerf_${String(meta.version).padStart(4, "0")}.csv`, content, bytes: encodeCp1252(content), lineCount: count };
}

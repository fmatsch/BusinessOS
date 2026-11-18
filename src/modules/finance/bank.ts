/**
 * Kontoauszüge lesen (CAMT.053-XML und CSV) und Zahlungen Belegen zuordnen – rein, ohne Datenbank.
 * Beträge mit Vorzeichen: Eingang positiv, Ausgang negativ. Datumsangaben als JJJJ-MM-TT.
 */
import { createHash } from "node:crypto";
import { Decimal } from "@/lib/money";

export class BankParseError extends Error {}

export const MAX_BANK_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BANK_LINES = 5000;

export interface ParsedLine {
  bookingDate: string;
  amount: string; // mit Vorzeichen, 2 Nachkommastellen
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  reference: string;
  endToEndId: string | null;
}

// ───────────────────────── XML (klein, ohne DTD) ─────────────────────────

interface XNode { name: string; children: XNode[]; text: string; attrs: Record<string, string> }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
  if (e[0] === "#") { const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** Minimaler XML-Leser. DOCTYPE und Entitätsdefinitionen werden abgelehnt (keine Entity-Expansion). */
export function parseXml(xml: string): XNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BankParseError("XML mit DOCTYPE/ENTITY wird nicht gelesen");
  const root: XNode = { name: "#root", children: [], text: "", attrs: {} };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      const name = m[2].replace(/^.*:/, "");
      if (stack.length < 2 || top.name !== name) throw new BankParseError("Ungültiges XML (Schließ-Tag passt nicht)");
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!.replace(/^.*:/, "")] = decode(a[2] ?? a[3] ?? "");
      const node: XNode = { name: m[3].replace(/^.*:/, ""), children: [], text: "", attrs };
      top.children.push(node);
      if (m[5] !== "/") { stack.push(node); if (stack.length > 40) throw new BankParseError("XML ist zu tief verschachtelt"); }
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new BankParseError("Ungültiges XML (nicht geschlossen)");
  return root;
}

const kids = (n: XNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];
const kid = (n: XNode | undefined, ...path: string[]): XNode | undefined => path.reduce<XNode | undefined>((cur, p) => cur?.children.find((c) => c.name === p), n);
const txt = (n: XNode | undefined) => (n ? n.text.trim() : "");
function* walk(n: XNode): Generator<XNode> { yield n; for (const c of n.children) yield* walk(c); }

export function parseCamt(xml: string): ParsedLine[] {
  const root = parseXml(xml);
  const doc = root.children.find((c) => c.name === "Document");
  if (!doc) throw new BankParseError("Kein CAMT-Dokument (Element Document fehlt)");
  const lines: ParsedLine[] = [];
  for (const n of walk(doc)) {
    if (n.name !== "Ntry") continue;
    const amt = kid(n, "Amt");
    const raw = txt(amt);
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new BankParseError("Ungültiger Betrag im Kontoauszug");
    const credit = txt(kid(n, "CdtDbtInd")) === "CRDT";
    const reversed = txt(kid(n, "RvslInd")).toLowerCase() === "true";
    let value = new Decimal(raw);
    if (credit === reversed) value = value.negated(); // Eingang (nicht storniert) positiv; Storno kehrt um
    const date = (txt(kid(n, "BookgDt", "Dt")) || txt(kid(n, "BookgDt", "DtTm")) || txt(kid(n, "ValDt", "Dt")) || txt(kid(n, "ValDt", "DtTm"))).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BankParseError("Buchungsdatum fehlt im Kontoauszug");
    const tx = kid(n, "NtryDtls", "TxDtls");
    const party = credit !== reversed ? "Dbtr" : "Cdtr"; // Gegenseite: bei Eingang der Zahler
    const partyNode = kid(tx, "RltdPties", party);
    const name = txt(kid(partyNode, "Nm")) || txt(kid(partyNode, "Pty", "Nm")) || txt(kid(tx, "RltdPties", party)) || null;
    const iban = txt(kid(tx, "RltdPties", `${party}Acct`, "Id", "IBAN")) || null;
    const ustrd = kids(kid(tx, "RmtInf"), "Ustrd").map(txt).filter(Boolean).join(" ");
    const e2e = txt(kid(tx, "Refs", "EndToEndId"));
    lines.push({
      bookingDate: date, amount: value.toFixed(2), currency: amt?.attrs.Ccy ?? "EUR",
      counterpartyName: name && name !== "" ? name.slice(0, 140) : null, counterpartyIban: iban ? iban.replace(/\s+/g, "").toUpperCase() : null,
      reference: (ustrd || txt(kid(n, "AddtlNtryInf"))).slice(0, 500), endToEndId: e2e && e2e !== "NOTPROVIDED" ? e2e.slice(0, 35) : null,
    });
    if (lines.length > MAX_BANK_LINES) throw new BankParseError(`Zu viele Buchungen (höchstens ${MAX_BANK_LINES} je Datei)`);
  }
  if (lines.length === 0) throw new BankParseError("Der Kontoauszug enthält keine Buchungen");
  return lines;
}

// ───────────────────────── CSV ─────────────────────────

function splitCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const HEADERS = {
  date: ["buchungsdatum", "buchungstag", "buchungsdatum", "datum", "bookingdate", "date", "valuta", "valutadatum"],
  amount: ["betrag", "amount", "umsatz", "betrageur", "betragin"],
  reference: ["verwendungszweck", "buchungstext", "zahlungsreferenz", "reference", "text", "zahlungsdetails", "mitteilung"],
  name: ["auftraggeberempfanger", "auftraggeber", "empfanger", "zahlungsempfanger", "name", "partner", "partnername", "beguenstigter", "begunstigter"],
  iban: ["iban", "kontoiban", "partneriban", "gegenkonto", "empfangeriban", "auftraggeberiban"],
  currency: ["waehrung", "wahrung", "currency", "whg"],
  e2e: ["endtoendid", "endtoend", "e2e", "referenz"],
} as const;

/** Betrag in deutscher oder englischer Schreibweise → Decimal-String mit Vorzeichen. */
export function parseAmount(raw: string): string {
  let s = raw.trim().replace(/\s| |€|EUR/gi, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith("-")) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", "."); // 1.234,56
  else if (lastDot > lastComma && lastComma !== -1) s = s.replace(/,/g, ""); // 1,234.56
  else if (lastComma !== -1) s = s.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new BankParseError(`Ungültiger Betrag: „${raw.trim().slice(0, 30)}“`);
  const d = new Decimal(s);
  return (neg ? d.negated() : d).toFixed(2);
}

export function parseDate(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  throw new BankParseError(`Ungültiges Datum: „${s.slice(0, 20)}“`);
}

export function parseCsv(text: string): ParsedLine[] {
  const clean = text.replace(/^﻿/, "");
  const first = clean.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", "\t", ","].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows = splitCsv(clean, delim);
  if (rows.length < 2) throw new BankParseError("Die CSV-Datei enthält keine Buchungen");
  const head = rows[0]!.map(norm);
  const col = (names: readonly string[]) => head.findIndex((h) => names.includes(h));
  const idx = { date: col(HEADERS.date), amount: col(HEADERS.amount), reference: col(HEADERS.reference), name: col(HEADERS.name), iban: col(HEADERS.iban), currency: col(HEADERS.currency), e2e: col(HEADERS.e2e) };
  if (idx.date < 0 || idx.amount < 0) throw new BankParseError("Spalten für Datum und Betrag nicht gefunden (erwartet z. B. „Buchungsdatum“ und „Betrag“)");
  if (rows.length - 1 > MAX_BANK_LINES) throw new BankParseError(`Zu viele Buchungen (höchstens ${MAX_BANK_LINES} je Datei)`);
  return rows.slice(1).map((r, i) => {
    try {
      const iban = idx.iban >= 0 ? (r[idx.iban] ?? "").replace(/\s+/g, "").toUpperCase() : "";
      return {
        bookingDate: parseDate(r[idx.date] ?? ""), amount: parseAmount(r[idx.amount] ?? ""), currency: (idx.currency >= 0 && (r[idx.currency] ?? "").trim()) || "EUR",
        counterpartyName: idx.name >= 0 && (r[idx.name] ?? "").trim() ? (r[idx.name] ?? "").trim().slice(0, 140) : null, counterpartyIban: iban || null,
        reference: idx.reference >= 0 ? (r[idx.reference] ?? "").trim().slice(0, 500) : "", endToEndId: idx.e2e >= 0 && (r[idx.e2e] ?? "").trim() ? (r[idx.e2e] ?? "").trim().slice(0, 35) : null,
      };
    } catch (e) {
      throw new BankParseError(`Zeile ${i + 2}: ${e instanceof Error ? e.message : "ungültig"}`);
    }
  });
}

/** Format an Inhalt und Endung erkennen und lesen. */
export function parseBankFile(filename: string, content: string): { format: "CAMT" | "CSV"; lines: ParsedLine[] } {
  if (Buffer.byteLength(content) > MAX_BANK_FILE_BYTES) throw new BankParseError("Die Datei ist zu groß (höchstens 2 MB)");
  const body = content.replace(/^﻿/, "").trimStart();
  if (body.startsWith("<")) return { format: "CAMT", lines: parseCamt(body) };
  if (/\.xml$/i.test(filename)) throw new BankParseError("Die XML-Datei ist kein gültiges CAMT-Dokument");
  return { format: "CSV", lines: parseCsv(body) };
}

/** Stabile Schlüssel je Zeile; gleiche Zeilen innerhalb einer Datei werden durchnummeriert, so bleiben echte Dubletten erhalten, Überschneidungen zwischen Dateien aber nicht doppelt. */
export function dedupeKeys(lines: ParsedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [l.bookingDate, l.amount, l.currency, l.counterpartyIban ?? "", l.reference, l.endToEndId ?? ""].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}|${n}`).digest("hex");
  });
}

// ───────────────────────── Zuordnung ─────────────────────────

export type MatchKind = "CUSTOMER_INVOICE" | "SUPPLIER_INVOICE";
export interface Candidate { kind: MatchKind; id: string; numbers: string[]; amount: string; party: string }
export interface Suggestion { candidate: Candidate; strength: "EXACT" | "POSSIBLE" }

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Vorschlag für eine Zahlung: EXACT = Belegnummer steht im Verwendungszweck und der Betrag stimmt;
 * POSSIBLE = Betrag stimmt, genau ein Kandidat, und der Name der Gegenseite kommt vor. Sonst kein Vorschlag.
 */
export function suggestMatch(line: { amount: string; reference: string; counterpartyName: string | null }, candidates: Candidate[]): Suggestion | null {
  const amount = new Decimal(line.amount);
  if (amount.isZero()) return null;
  const kind: MatchKind = amount.gt(0) ? "CUSTOMER_INVOICE" : "SUPPLIER_INVOICE";
  const abs = amount.abs().toFixed(2);
  const pool = candidates.filter((c) => c.kind === kind && new Decimal(c.amount).toFixed(2) === abs);
  const ref = alnum(line.reference);
  const exact = pool.filter((c) => c.numbers.some((n) => alnum(n).length >= 5 && ref.includes(alnum(n))));
  if (exact.length === 1) return { candidate: exact[0]!, strength: "EXACT" };
  if (exact.length > 1 || pool.length !== 1) return null;
  const hay = `${line.counterpartyName ?? ""} ${line.reference}`.toLowerCase();
  const words = pool[0]!.party.toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length >= 4);
  return words.some((w) => hay.includes(w)) ? { candidate: pool[0]!, strength: "POSSIBLE" } : null;
}

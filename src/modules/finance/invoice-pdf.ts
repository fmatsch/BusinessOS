/**
 * Ausgangsrechnung als PDF – reines Modul ohne Abhängigkeiten (Standardschrift Helvetica, A4, WinAnsi).
 * Keine Datenbank, keine Uhrzeit: gleiche Eingabe ergibt gleiche Bytes.
 */
import { Decimal } from "@/lib/money";

export type IssuerDetails = {
  legalName: string; street?: string | null; zip?: string | null; city?: string | null; country?: string | null; uid?: string | null;
  companyRegister?: string | null; iban?: string | null; bic?: string | null; bankName?: string | null; email?: string | null; phone?: string | null;
};

export type InvoicePdfInput = {
  /** Name des Ausstellers; Anschrift und Bankdaten sind optional (ohne Stammdaten steht nur der Name im Kopf). */
  issuer: string;
  issuerDetails?: IssuerDetails | null;
  customer: { name: string; street?: string | null; zip?: string | null; city?: string | null; country?: string | null; uid?: string | null };
  number: string;
  kind: "INVOICE" | "CREDIT";
  creditsNumber?: string | null;
  invoiceDate: string; // YYYY-MM-DD
  dueDate?: string | null;
  currency: string;
  lines: { description: string; quantity: string; unitPrice: string; netAmount: string; taxRate: string }[];
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  note?: string | null;
};

// Helvetica-Zeichenbreiten (1/1000 em) für ASCII 32–126
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const EXTRA: Record<string, number> = { "Ä": 667, "Ö": 778, "Ü": 722, "ß": 611, "€": 556 };
const CP1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };

function charWidth(ch: string) {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return W[c - 32] ?? 556;
  return EXTRA[ch] ?? 556;
}

/** Textbreite in Punkt. Fettschrift wird pauschal etwas breiter angesetzt. */
export function textWidth(text: string, size: number, bold = false) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return (w * size * (bold ? 1.06 : 1)) / 1000;
}

/** Text in einen PDF-String (WinAnsi, Steuerzeichen und Klammern maskiert). Unbekannte Zeichen werden zu „?“. */
export function pdfString(text: string) {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    let b: number;
    const mapped = CP1252[ch];
    if (mapped !== undefined) b = mapped;
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) b = c;
    else b = 63;
    const s = String.fromCharCode(b);
    out += s === "\\" || s === "(" || s === ")" ? "\\" + s : s;
  }
  return `(${out})`;
}

/** Zerlegt Text in Zeilen, die in die Breite passen (an Leerzeichen; überlange Wörter werden hart getrennt). */
export function wrapText(text: string, maxWidth: number, size: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (textWidth(w, size) > maxWidth) {
        let i = w.length - 1;
        while (i > 1 && textWidth(w.slice(0, i), size) > maxWidth) i--;
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(w.slice(0, i));
        w = w.slice(i);
      }
      const next = cur ? `${cur} ${w}` : w;
      if (textWidth(next, size) <= maxWidth) cur = next;
      else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines.length ? lines : [""];
}

/** 1.234,56 – deutsche Schreibweise ohne Intl (stabil, keine geschützten Leerzeichen). */
export function fmtAmount(v: string | Decimal, decimals = 2) {
  const s = new Decimal(v).toFixed(decimals, Decimal.ROUND_HALF_UP);
  const neg = s.startsWith("-");
  const [int = "0", frac] = s.replace("-", "").split(".");
  return (neg ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (frac ? "," + frac : "");
}

const fmtQty = (v: string) => fmtAmount(v, 4).replace(/,?0+$/, "").replace(/,$/, "");
export const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Fußzeile: Bankverbindung, Firmenbuch, Kontakt (nur vorhandene Angaben). */
export function footerLines(inv: { issuerDetails?: IssuerDetails | null }): string[] {
  const i = inv.issuerDetails;
  if (!i) return [];
  const bank = [i.bankName, i.iban ? `IBAN ${i.iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim()}` : "", i.bic ? `BIC ${i.bic}` : ""].filter(Boolean).join(" · ");
  const contact = [i.email, i.phone].filter(Boolean).join(" · ");
  return [bank, i.companyRegister ?? "", contact].filter((x) => x.trim() !== "");
}

export const PAGE_W = 595, PAGE_H = 842, MARGIN = 56, BOTTOM = 100;

export class Page {
  ops: string[] = [];
  text(x: number, y: number, s: string, size = 10, bold = false) { this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`); }
  right(xRight: number, y: number, s: string, size = 10, bold = false) { this.text(xRight - textWidth(s, size, bold), y, s, size, bold); }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5) { this.ops.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`); }
}

export function renderInvoicePdf(inv: InvoicePdfInput): Uint8Array {
  const pages: Page[] = [];
  const cur = () => pages[pages.length - 1]!;
  const newPage = () => {
    pages.push(new Page());
    return PAGE_H - MARGIN;
  };

  const isCredit = inv.kind === "CREDIT";
  const title = isCredit ? "Gutschrift" : "Rechnung";
  const right = PAGE_W - MARGIN;

  let y = newPage();
  cur().text(MARGIN, y, inv.issuer, 11, true);
  cur().right(right, y, title, 22, true);
  const iss = inv.issuerDetails;
  const issuerLines = iss ? [iss.street, [iss.zip, iss.city].filter(Boolean).join(" "), iss.country, iss.uid ? `UID: ${iss.uid}` : ""].filter((x): x is string => !!x && x.trim() !== "") : [];
  let iy = y - 13;
  for (const l of issuerLines) { cur().text(MARGIN, iy, l, 8); iy -= 11; }
  y = Math.min(y - 50, iy - 24);

  // Empfänger
  const addr = [inv.customer.name, inv.customer.street, [inv.customer.zip, inv.customer.city].filter(Boolean).join(" "), inv.customer.country].filter((x): x is string => !!x && x.trim() !== "");
  for (const a of addr) { cur().text(MARGIN, y, a, 10, a === inv.customer.name); y -= 14; }
  if (inv.customer.uid) { cur().text(MARGIN, y, `UID: ${inv.customer.uid}`, 9); y -= 14; }

  // Kopfdaten rechts
  let ry = PAGE_H - MARGIN - 50;
  const meta: [string, string][] = [[`${title}snummer`, inv.number], ["Datum", fmtDate(inv.invoiceDate)]];
  if (inv.dueDate && !isCredit) meta.push(["Fällig am", fmtDate(inv.dueDate)]);
  if (isCredit && inv.creditsNumber) meta.push(["Bezug", inv.creditsNumber]);
  for (const [k, v] of meta) { cur().text(330, ry, k, 9); cur().right(right, ry, v, 10, true); ry -= 14; }

  y = Math.min(y, ry) - 30;
  cur().text(MARGIN, y, `${title} ${inv.number}`, 14, true);
  y -= 30;

  // Tabelle
  const colQty = 330, colPrice = 405, colTax = 440, colNet = right, descW = colQty - MARGIN - 70;
  const header = (pg: Page, yy: number) => {
    pg.text(MARGIN, yy, "Beschreibung", 9, true);
    pg.right(colQty, yy, "Menge", 9, true);
    pg.right(colPrice + 25, yy, "Einzelpreis", 9, true);
    pg.right(colTax + 35, yy, "USt", 9, true);
    pg.right(colNet, yy, "Netto", 9, true);
    pg.line(MARGIN, yy - 5, right, yy - 5, 0.8);
    return yy - 20;
  };
  y = header(cur(), y);

  for (const l of inv.lines) {
    const desc = wrapText(l.description, descW, 10);
    const need = desc.length * 13 + 8;
    if (y - need < BOTTOM) { y = header((pages.push(new Page()), cur()), PAGE_H - MARGIN); }
    const pg = cur();
    desc.forEach((d, i) => pg.text(MARGIN, y - i * 13, d, 10));
    pg.right(colQty, y, fmtQty(l.quantity), 10);
    pg.right(colPrice + 25, y, fmtAmount(l.unitPrice), 10);
    pg.right(colTax + 35, y, `${fmtAmount(l.taxRate, 0)} %`, 10);
    pg.right(colNet, y, fmtAmount(l.netAmount), 10);
    y -= need;
  }

  // Summen (zusammenhängend auf einer Seite)
  if (y - 90 < BOTTOM) { pages.push(new Page()); y = PAGE_H - MARGIN; }
  const pg = cur();
  pg.line(330, y + 6, right, y + 6, 0.5);
  y -= 8;
  const sums: [string, string, boolean][] = [["Netto", fmtAmount(inv.netTotal), false], ["Umsatzsteuer", fmtAmount(inv.taxTotal), false], [`${isCredit ? "Gutschriftsbetrag" : "Gesamtbetrag"} (${inv.currency})`, fmtAmount(inv.grossTotal), true]];
  for (const [k, v, bold] of sums) { pg.text(330, y, k, bold ? 11 : 10, bold); pg.right(right, y, v, bold ? 11 : 10, bold); y -= 16; }

  y -= 14;
  const notes: string[] = [];
  if (isCredit) notes.push("Dieser Betrag wird Ihnen gutgeschrieben.");
  else if (inv.dueDate) notes.push(`Bitte überweisen Sie den Betrag bis ${fmtDate(inv.dueDate)} unter Angabe der Rechnungsnummer ${inv.number}.`);
  if (inv.note) notes.push(inv.note);
  for (const n of notes) for (const ln of wrapText(n, right - MARGIN, 9)) {
    if (y < BOTTOM - 20) { pages.push(new Page()); y = PAGE_H - MARGIN; }
    cur().text(MARGIN, y, ln, 9);
    y -= 12;
  }

  // Fußzeile mit Seitenzahl
  const footer = footerLines(inv);
  pages.forEach((p) => footer.forEach((f, k) => p.text(MARGIN, 64 - k * 10, f, 7.5)));
  pages.forEach((p) => p.text(MARGIN, 30, `${inv.issuer} · ${inv.number}`, 8));
  pages.forEach((p, i) => p.right(right, 40, `Seite ${i + 1} von ${pages.length}`, 8));

  return assemble(pages);
}

/** Baut die PDF-Struktur (Katalog, Seiten, zwei Schriften, Inhaltsströme, Kreuzverweistabelle). */
export function assemble(pages: Page[]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // Seitenbaum, unten gefüllt
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const content = p.ops.join("\n");
    const cid = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add("<< /Producer (BusinessOS) /Title (Rechnung) >>");

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

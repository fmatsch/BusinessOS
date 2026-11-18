/** Zahlungserinnerung/Mahnung als PDF (Helvetica, A4) – baut auf den Bausteinen von `invoice-pdf.ts` auf. */
import { Decimal } from "@/lib/money";
import { LEVEL_TITLE } from "./dunning";
import { assemble, fmtAmount, fmtDate, footerLines, Page, PAGE_H, PAGE_W, MARGIN, wrapText, type IssuerDetails } from "./invoice-pdf";

export type DunningPdfInput = {
  issuer: string;
  issuerDetails?: IssuerDetails | null;
  customer: { name: string; street?: string | null; zip?: string | null; city?: string | null; country?: string | null };
  level: number;
  issuedOn: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  openAmount: string;
  feeAmount: string;
  payByDate: string;
  note?: string | null;
};

export function renderDunningPdf(n: DunningPdfInput): Uint8Array {
  const pg = new Page();
  const right = PAGE_W - MARGIN;
  const title = LEVEL_TITLE[n.level] ?? "Mahnung";
  let y = PAGE_H - MARGIN;
  pg.text(MARGIN, y, n.issuer, 11, true);
  pg.right(right, y, title, 20, true);
  const iss = n.issuerDetails;
  const head = iss ? [iss.street, [iss.zip, iss.city].filter(Boolean).join(" "), iss.country, iss.uid ? `UID: ${iss.uid}` : ""].filter((x): x is string => !!x && x.trim() !== "") : [];
  let iy = y - 13;
  for (const l of head) { pg.text(MARGIN, iy, l, 8); iy -= 11; }
  y = Math.min(y - 50, iy - 24);

  const addr = [n.customer.name, n.customer.street, [n.customer.zip, n.customer.city].filter(Boolean).join(" "), n.customer.country].filter((x): x is string => !!x && x.trim() !== "");
  for (const a of addr) { pg.text(MARGIN, y, a, 10, a === n.customer.name); y -= 14; }
  pg.right(right, PAGE_H - MARGIN - 50, `Datum ${fmtDate(n.issuedOn)}`, 10);

  y -= 26;
  pg.text(MARGIN, y, `${title} zu Rechnung ${n.invoiceNumber}`, 14, true);
  y -= 28;

  const intro = n.level === 1
    ? `bei der Durchsicht unserer Buchhaltung haben wir festgestellt, dass die Rechnung ${n.invoiceNumber} vom ${fmtDate(n.invoiceDate)} noch nicht beglichen ist. Sie war am ${fmtDate(n.dueDate)} fällig. Sollten Sie bereits gezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.`
    : `trotz unserer früheren Schreiben ist die Rechnung ${n.invoiceNumber} vom ${fmtDate(n.invoiceDate)}, fällig am ${fmtDate(n.dueDate)}, noch offen. Wir bitten Sie, den Betrag umgehend zu überweisen.`;
  for (const para of ["Sehr geehrte Damen und Herren,", intro]) {
    for (const ln of wrapText(para, right - MARGIN, 10)) { pg.text(MARGIN, y, ln, 10); y -= 14; }
    y -= 6;
  }

  y -= 8;
  const total = new Decimal(n.openAmount).plus(n.feeAmount);
  const rows: [string, string, boolean][] = [[`Offener Betrag (${n.currency})`, fmtAmount(n.openAmount), false]];
  if (new Decimal(n.feeAmount).gt(0)) rows.push(["Mahngebühr", fmtAmount(n.feeAmount), false]);
  rows.push([`Zu zahlen bis ${fmtDate(n.payByDate)}`, fmtAmount(total), true]);
  pg.line(MARGIN, y + 6, right, y + 6, 0.5);
  for (const [k, v, bold] of rows) { pg.text(MARGIN, y - 8, k, bold ? 11 : 10, bold); pg.right(right, y - 8, v, bold ? 11 : 10, bold); y -= 18; }
  y -= 14;

  const close = [n.level >= 3 ? "Bei weiterem Zahlungsverzug behalten wir uns weitere Schritte vor." : "", `Bitte geben Sie bei der Überweisung die Rechnungsnummer ${n.invoiceNumber} an.`, n.note ?? ""].filter(Boolean);
  for (const para of close) for (const ln of wrapText(para, right - MARGIN, 10)) { pg.text(MARGIN, y, ln, 10); y -= 14; }

  footerLines(n).forEach((f, k) => pg.text(MARGIN, 64 - k * 10, f, 7.5));
  pg.text(MARGIN, 30, `${n.issuer} · ${title} · ${n.invoiceNumber}`, 8);
  return assemble([pg]);
}

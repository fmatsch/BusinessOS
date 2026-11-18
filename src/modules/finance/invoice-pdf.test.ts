import { describe, expect, it } from "vitest";
import { fmtAmount, pdfString, renderInvoicePdf, textWidth, wrapText, type InvoicePdfInput } from "./invoice-pdf";

const base: InvoicePdfInput = {
  issuer: "Muster GmbH",
  customer: { name: "Müller & Söhne (Wien)", street: "Hauptstraße 1", zip: "1010", city: "Wien", country: "AT", uid: "ATU12345678" },
  number: "AR-2027-0001",
  kind: "INVOICE",
  invoiceDate: "2027-03-05",
  dueDate: "2027-03-19",
  currency: "EUR",
  lines: [{ description: "Beratung März", quantity: "10", unitPrice: "120.5", netAmount: "1205", taxRate: "20" }],
  netTotal: "1205", taxTotal: "241", grossTotal: "1446",
  note: "Danke für Ihren Auftrag",
};
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("Rechnungs-PDF", () => {
  it("erzeugt ein gültig aufgebautes PDF mit korrekter Kreuzverweistabelle", () => {
    const s = text(renderInvoicePdf(base));
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe("xref");
    const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // Stream-Längen stimmen
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(m[2]!.length).toBe(Number(m[1]));
  });

  it("enthält Nummer, Beträge und Umlaute (WinAnsi) und ist deterministisch", () => {
    const a = renderInvoicePdf(base);
    const s = text(a);
    expect(s).toContain("(AR-2027-0001)");
    expect(s).toContain("(1.446,00)");
    expect(s).toContain("(05.03.2027)");
    expect(s).toContain("(M\xfcller & S\xf6hne \\(Wien\\))"); // ü=0xFC, ö=0xF6, Klammern maskiert
    expect(Buffer.from(a).equals(Buffer.from(renderInvoicePdf(base)))).toBe(true);
  });

  it("Gutschrift trägt Bezug und keine Fälligkeit", () => {
    const s = text(renderInvoicePdf({ ...base, kind: "CREDIT", creditsNumber: "AR-2027-0001", number: "AR-2027-0002", note: null }));
    expect(s).toContain("(Gutschrift)");
    expect(s).toContain("(Bezug)");
    expect(s).not.toContain("(F\xe4llig am)");
  });

  it("bricht viele Positionen auf mehrere Seiten um, Summen bleiben zusammen", () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ description: `Position ${i + 1} mit etwas längerem Text zur Prüfung des Umbruchs`, quantity: "1", unitPrice: "10", netAmount: "10", taxRate: "20" }));
    const s = text(renderInvoicePdf({ ...base, lines, netTotal: "800", taxTotal: "160", grossTotal: "960" }));
    const pages = (s.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(s).toContain(`(Seite ${pages} von ${pages})`);
    expect(s.match(/\(960,00\)/g)).toHaveLength(1);
  });

  it("maskiert Sonderzeichen und ersetzt nicht darstellbare durch ?", () => {
    expect(pdfString("a\\b(c)")).toBe("(a\\\\b\\(c\\))");
    expect(pdfString("日本")).toBe("(??)");
    expect(pdfString("€")).toBe("(\x80)");
  });

  it("formatiert Beträge deutsch und rechnet exakt", () => {
    expect(fmtAmount("1234567.891")).toBe("1.234.567,89");
    expect(fmtAmount("-5")).toBe("-5,00");
    expect(fmtAmount("20", 0)).toBe("20");
    expect(fmtAmount("0.005")).toBe("0,01");
  });

  it("misst und bricht Text", () => {
    expect(textWidth("i", 10)).toBeLessThan(textWidth("W", 10));
    const l = wrapText("eins zwei drei vier fünf sechs sieben", 60, 10);
    expect(l.length).toBeGreaterThan(1);
    l.forEach((x) => expect(textWidth(x, 10)).toBeLessThanOrEqual(60));
    const hard = wrapText("Donaudampfschifffahrtsgesellschaftskapitän", 80, 10);
    hard.forEach((x) => expect(textWidth(x, 10)).toBeLessThanOrEqual(80));
    expect(hard.join("")).toBe("Donaudampfschifffahrtsgesellschaftskapitän");
  });
});

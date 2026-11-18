import { describe, expect, it } from "vitest";
import { eInvoiceProblems, renderUbl, taxGroups, type EInvoiceInput } from "./einvoice";

const base: EInvoiceInput = {
  number: "AR-2027-0001", kind: "INVOICE", invoiceDate: "2027-03-01", dueDate: "2027-03-15", currency: "EUR",
  seller: { legalName: "Muster & Söhne GmbH", street: "Hauptstraße 1", zip: "1010", city: "Wien", country: "AT", uid: "ATU 12345678", iban: "AT61 1904 3002 3457 3201", bic: "BKAUATWW", email: "office@muster.example", phone: "+43 1 000" },
  buyer: { number: "K1", name: "Kunde <Test> GmbH", street: "Ring 5", zip: "4020", city: "Linz", country: "AT", uid: "ATU87654321", endpoint: "einkauf@kunde.example" },
  lines: [
    { description: "Ware A", quantity: "2", unitPrice: "10.5", netAmount: "21.00", taxRate: "20" },
    { description: "Buch", quantity: "1", unitPrice: "10", netAmount: "10.00", taxRate: "10" },
    { description: "Auslage", quantity: "1", unitPrice: "5", netAmount: "5.00", taxRate: "0" },
  ],
  netTotal: "36.00", taxTotal: "5.20", grossTotal: "41.20",
};

describe("E-Rechnung (UBL / Peppol BIS 3.0)", () => {
  it("Steuer je Satz: Summe der Nettobeträge × Satz, nach Satz absteigend", () => {
    const g = taxGroups(base.lines);
    expect(g.map((x) => [x.rate, x.taxable.toString(), x.tax.toString(), x.category])).toEqual([["20", "21", "4.2", "S"], ["10", "10", "1", "S"], ["0", "5", "0", "Z"]]);
  });
  it("ein vollständiger Beleg hat keine Probleme und erzeugt wohlgeformtes XML mit den Pflichtfeldern", () => {
    expect(eInvoiceProblems(base)).toEqual([]);
    const xml = renderUbl(base);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<Invoice xmlns=");
    expect(xml).toContain("<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:ID>AR-2027-0001</cbc:ID>");
    expect(xml).toContain('<cbc:EndpointID schemeID="EM">office@muster.example</cbc:EndpointID>');
    expect(xml).toContain("<cbc:CompanyID>ATU12345678</cbc:CompanyID>");
    expect(xml).toContain("<cbc:ID>AT611904300234573201</cbc:ID>"); // IBAN ohne Leerzeichen
    expect(xml).toContain('<cbc:TaxAmount currencyID="EUR">5.20</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">41.20</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">10.50</cbc:PriceAmount>');
    expect((xml.match(/<cac:InvoiceLine>/g) ?? []).length).toBe(3);
    expect((xml.match(/<cac:TaxSubtotal>/g) ?? []).length).toBe(3);
    expect(xml).toContain("<cbc:DueDate>2027-03-15</cbc:DueDate>");
  });
  it("Sonderzeichen werden maskiert, Steuerzeichen entfernt", () => {
    const xml = renderUbl({ ...base, lines: [{ ...base.lines[0]!, description: "Ware <A> & \"B\"\u0001" }, base.lines[1]!, base.lines[2]!] });
    expect(xml).toContain("Kunde &lt;Test&gt; GmbH");
    expect(xml).toContain("Muster &amp; Söhne GmbH");
    expect(xml).toContain("Ware &lt;A&gt; &amp; &quot;B&quot;");
    expect(xml).not.toContain("\u0001");
  });
  it("Gutschrift: CreditNote mit Typ 381, Bezug auf die Rechnung und CreditedQuantity", () => {
    const xml = renderUbl({ ...base, kind: "CREDIT", number: "AR-2027-0002", creditsNumber: "AR-2027-0001" });
    expect(xml).toContain("<CreditNote xmlns=");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>AR-2027-0001</cbc:ID>");
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain("<cbc:CreditedQuantity");
    expect(xml).not.toContain("<cbc:DueDate>");
  });
  it("fehlende Angaben werden benannt; XML wird dann nicht erzeugt", () => {
    const bad: EInvoiceInput = { ...base, seller: { ...base.seller, uid: "", iban: null, email: "" }, buyer: { ...base.buyer, endpoint: "", country: "Österreich" } };
    const p = eInvoiceProblems(bad);
    expect(p).toEqual(expect.arrayContaining([expect.stringMatching(/UID/), expect.stringMatching(/IBAN/), expect.stringMatching(/E-Mail/), expect.stringMatching(/elektronische Adresse/), expect.stringMatching(/Kunde: Land/)]));
    expect(() => renderUbl(bad)).toThrow(/UID/);
    expect(eInvoiceProblems({ ...base, kind: "CREDIT" })).toEqual(["Gutschrift: Bezug auf die Rechnungsnummer fehlt"]);
    expect(eInvoiceProblems({ ...base, buyer: { ...base.buyer, endpoint: "9915:" } })).toEqual(expect.arrayContaining([expect.stringMatching(/Peppol-ID/)]));
    expect(eInvoiceProblems({ ...base, buyer: { ...base.buyer, endpoint: "9915:b" } })).toEqual([]);
  });
  it("inkonsistente Summen werden erkannt, statt falsche Beträge auszugeben", () => {
    expect(eInvoiceProblems({ ...base, netTotal: "35.99" })).toEqual(expect.arrayContaining([expect.stringMatching(/Nettobetrag/)]));
    expect(eInvoiceProblems({ ...base, taxTotal: "5.19", grossTotal: "41.19" })).toEqual(expect.arrayContaining([expect.stringMatching(/Steuer je Satz/)]));
    expect(eInvoiceProblems({ ...base, grossTotal: "41.21" })).toEqual(expect.arrayContaining([expect.stringMatching(/Brutto/)]));
  });
  it("Peppol-Adresse mit Schema wird als schemeID ausgegeben", () => {
    const xml = renderUbl({ ...base, buyer: { ...base.buyer, endpoint: "9915:b2b-kunde" } });
    expect(xml).toContain('<cbc:EndpointID schemeID="9915">b2b-kunde</cbc:EndpointID>');
  });
});

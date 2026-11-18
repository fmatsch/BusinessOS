import { Decimal } from "@/lib/money";
import type { IssuerDetails } from "./invoice-pdf";

/**
 * E-Rechnung als UBL 2.1 nach EN 16931 / Peppol BIS Billing 3.0 (reine Funktionen).
 * Unterstützt: Rechnung (380) und Gutschrift (381), Steuerkategorien S (Satz > 0) und Z (0 %), SEPA-Überweisung, Kunde mit elektronischer Adresse.
 * Nicht unterstützt: Reverse-Charge/innergemeinschaftliche Lieferung/Steuerbefreiung mit Begründung (Kategorien AE, K, E), Rabatte/Zuschläge, Anhänge, Sammelrechnungen.
 * Das Ergebnis ist NICHT gegen die offiziellen Schematron-Regeln geprüft – vor dem Echtbetrieb mit einem Validator (z. B. KoSIT, Peppol-Validator) prüfen.
 */

export interface EInvoiceInput {
  number: string;
  kind: "INVOICE" | "CREDIT";
  /** Gutschrift: Nummer der gutgeschriebenen Rechnung */
  creditsNumber?: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  currency: string;
  seller: IssuerDetails;
  buyer: { number: string; name: string; street?: string | null; zip?: string | null; city?: string | null; country?: string | null; uid?: string | null; endpoint?: string | null };
  lines: { description: string; quantity: string; unitPrice: string; netAmount: string; taxRate: string }[];
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  note?: string | null;
  paymentTerms?: string | null;
}

const D = (v: Decimal.Value) => new Decimal(v);
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const money = (d: Decimal) => r2(d).toFixed(2);
/** Preise und Mengen ohne überflüssige Nullen, aber mit mindestens zwei Nachkommastellen bei Preisen */
const trimmed = (v: string, min = 0) => { const d = D(v); const s = d.toFixed(Math.max(min, Math.min(4, d.decimalPlaces()))); return s; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// Steuerzeichen, die XML 1.0 verbietet, entfernen
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const tag = (name: string, value: string, attrs = "") => `<${name}${attrs}>${esc(clean(value))}</${name}>`;
const ibanOf = (s: string) => s.replace(/\s+/g, "").toUpperCase();
const COUNTRY = /^[A-Z]{2}$/;

export interface TaxGroup { rate: string; taxable: Decimal; tax: Decimal; category: "S" | "Z" }

/** Steuer je Satz: Summe der Nettobeträge × Satz, kaufmännisch auf Cent (wie auf dem Beleg). */
export function taxGroups(lines: { netAmount: string; taxRate: string }[]): TaxGroup[] {
  const by = new Map<string, Decimal>();
  for (const l of lines) by.set(D(l.taxRate).toString(), (by.get(D(l.taxRate).toString()) ?? D(0)).plus(l.netAmount));
  return [...by.entries()].sort((a, b) => D(b[0]).comparedTo(D(a[0]))).map(([rate, taxable]) => ({ rate, taxable: r2(taxable), tax: r2(taxable.times(rate).div(100)), category: D(rate).gt(0) ? "S" : "Z" }));
}

/** Liste der Probleme, die eine gültige E-Rechnung verhindern (leer = ausgabefähig). */
export function eInvoiceProblems(i: EInvoiceInput): string[] {
  const p: string[] = [];
  const s = i.seller, b = i.buyer;
  if (!s.legalName?.trim()) p.push("Aussteller: Firmenname fehlt (Einstellungen › Aussteller)");
  if (!s.street?.trim() || !s.city?.trim() || !s.zip?.trim()) p.push("Aussteller: Anschrift (Straße, PLZ, Ort) fehlt");
  if (!s.country || !COUNTRY.test(s.country.toUpperCase())) p.push("Aussteller: Land als zweistelliger Code (z. B. AT) fehlt");
  if (!s.uid?.trim()) p.push("Aussteller: UID-Nummer fehlt");
  if (!s.iban?.trim()) p.push("Aussteller: IBAN fehlt");
  if (!s.email?.trim()) p.push("Aussteller: E-Mail-Adresse fehlt (elektronische Adresse des Verkäufers)");
  if (!b.name?.trim()) p.push("Kunde: Name fehlt");
  if (!b.street?.trim() || !b.city?.trim() || !b.zip?.trim()) p.push("Kunde: Anschrift (Straße, PLZ, Ort) fehlt");
  if (!b.country || !COUNTRY.test(b.country.toUpperCase())) p.push("Kunde: Land als zweistelliger Code (z. B. AT) fehlt");
  if (!b.endpoint?.trim()) p.push("Kunde: elektronische Adresse fehlt (E-Mail oder Peppol-ID im Kundenstamm)");
  else if (b.endpoint.includes(":") && !/^\d{4}:\S+$/.test(b.endpoint.trim())) p.push("Kunde: Peppol-ID im Format 9915:Kennung angeben");
  if (i.currency !== "EUR" && !/^[A-Z]{3}$/.test(i.currency)) p.push("Währung ungültig");
  if (i.lines.length === 0) p.push("Der Beleg hat keine Positionen");
  if (i.kind === "CREDIT" && !i.creditsNumber) p.push("Gutschrift: Bezug auf die Rechnungsnummer fehlt");
  if (i.lines.some((l) => !(D(l.quantity).gt(0)))) p.push("Positionen mit Menge 0 oder negativer Menge sind nicht zulässig");
  const net = i.lines.reduce((sum, l) => sum.plus(l.netAmount), D(0));
  if (!r2(net).eq(r2(D(i.netTotal)))) p.push("Die Summe der Positionen weicht vom Nettobetrag des Belegs ab");
  const tax = taxGroups(i.lines).reduce((sum, g) => sum.plus(g.tax), D(0));
  if (!r2(tax).eq(r2(D(i.taxTotal)))) p.push("Die Steuer je Satz weicht vom Steuerbetrag des Belegs ab");
  if (!r2(D(i.netTotal).plus(i.taxTotal)).eq(r2(D(i.grossTotal)))) p.push("Brutto ist nicht Netto plus Steuer");
  return p;
}

function endpoint(v: string): string {
  const t = v.trim();
  const scheme = t.includes("@") ? "EM" : t.split(":")[0]!;
  const id = t.includes("@") ? t : t.split(":").slice(1).join(":");
  return tag("cbc:EndpointID", id, ` schemeID="${scheme}"`);
}

function party(p: { name: string; street?: string | null; zip?: string | null; city?: string | null; country?: string | null; uid?: string | null; endpoint: string; contact?: { email?: string | null; phone?: string | null } }): string {
  return [
    "<cac:Party>",
    endpoint(p.endpoint),
    `<cac:PartyName>${tag("cbc:Name", p.name)}</cac:PartyName>`,
    `<cac:PostalAddress>${tag("cbc:StreetName", p.street ?? "")}${tag("cbc:CityName", p.city ?? "")}${tag("cbc:PostalZone", p.zip ?? "")}<cac:Country>${tag("cbc:IdentificationCode", (p.country ?? "").toUpperCase())}</cac:Country></cac:PostalAddress>`,
    p.uid ? `<cac:PartyTaxScheme>${tag("cbc:CompanyID", p.uid.replace(/\s+/g, "").toUpperCase())}<cac:TaxScheme>${tag("cbc:ID", "VAT")}</cac:TaxScheme></cac:PartyTaxScheme>` : "",
    `<cac:PartyLegalEntity>${tag("cbc:RegistrationName", p.name)}</cac:PartyLegalEntity>`,
    p.contact && (p.contact.email || p.contact.phone) ? `<cac:Contact>${p.contact.phone ? tag("cbc:Telephone", p.contact.phone) : ""}${p.contact.email ? tag("cbc:ElectronicMail", p.contact.email) : ""}</cac:Contact>` : "",
    "</cac:Party>",
  ].join("");
}

/** UBL-XML (Invoice bzw. CreditNote). Wirft, wenn Pflichtangaben fehlen – vorher `eInvoiceProblems` prüfen. */
export function renderUbl(i: EInvoiceInput): string {
  const problems = eInvoiceProblems(i);
  if (problems.length) throw new Error(problems.join("; "));
  const credit = i.kind === "CREDIT";
  const root = credit ? "CreditNote" : "Invoice";
  const ns = credit ? "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" : "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
  const cur = ` currencyID="${esc(i.currency)}"`;
  const groups = taxGroups(i.lines);
  const taxTotal = groups.reduce((s, g) => s.plus(g.tax), D(0));
  const net = i.lines.reduce((s, l) => s.plus(l.netAmount), D(0));
  const gross = net.plus(taxTotal);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`);
  out.push(tag("cbc:CustomizationID", "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0"));
  out.push(tag("cbc:ProfileID", "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0"));
  out.push(tag("cbc:ID", i.number));
  out.push(tag("cbc:IssueDate", i.invoiceDate));
  if (!credit && i.dueDate) out.push(tag("cbc:DueDate", i.dueDate));
  out.push(tag(credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", credit ? "381" : "380"));
  if (i.note?.trim()) out.push(tag("cbc:Note", i.note.trim()));
  out.push(tag("cbc:DocumentCurrencyCode", i.currency));
  out.push(tag("cbc:BuyerReference", i.buyer.number));
  if (credit) out.push(`<cac:BillingReference><cac:InvoiceDocumentReference>${tag("cbc:ID", i.creditsNumber!)}</cac:InvoiceDocumentReference></cac:BillingReference>`);
  out.push(`<cac:AccountingSupplierParty>${party({ name: i.seller.legalName, street: i.seller.street, zip: i.seller.zip, city: i.seller.city, country: i.seller.country, uid: i.seller.uid, endpoint: i.seller.email!, contact: { email: i.seller.email, phone: i.seller.phone } })}</cac:AccountingSupplierParty>`);
  out.push(`<cac:AccountingCustomerParty>${party({ name: i.buyer.name, street: i.buyer.street, zip: i.buyer.zip, city: i.buyer.city, country: i.buyer.country, uid: i.buyer.uid, endpoint: i.buyer.endpoint! })}</cac:AccountingCustomerParty>`);
  out.push(`<cac:PaymentMeans>${tag("cbc:PaymentMeansCode", "58")}<cac:PayeeFinancialAccount>${tag("cbc:ID", ibanOf(i.seller.iban!))}${i.seller.bankName ? tag("cbc:Name", i.seller.bankName) : ""}${i.seller.bic ? `<cac:FinancialInstitutionBranch>${tag("cbc:ID", i.seller.bic.replace(/\s+/g, "").toUpperCase())}</cac:FinancialInstitutionBranch>` : ""}</cac:PayeeFinancialAccount></cac:PaymentMeans>`);
  const terms = i.paymentTerms?.trim() || (i.dueDate && !credit ? `Zahlbar bis ${i.dueDate}` : "");
  if (terms) out.push(`<cac:PaymentTerms>${tag("cbc:Note", terms)}</cac:PaymentTerms>`);
  out.push(`<cac:TaxTotal>${tag("cbc:TaxAmount", money(taxTotal), cur)}${groups.map((g) => `<cac:TaxSubtotal>${tag("cbc:TaxableAmount", money(g.taxable), cur)}${tag("cbc:TaxAmount", money(g.tax), cur)}<cac:TaxCategory>${tag("cbc:ID", g.category)}${tag("cbc:Percent", D(g.rate).toFixed(2))}<cac:TaxScheme>${tag("cbc:ID", "VAT")}</cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join("")}</cac:TaxTotal>`);
  out.push(`<cac:LegalMonetaryTotal>${tag("cbc:LineExtensionAmount", money(net), cur)}${tag("cbc:TaxExclusiveAmount", money(net), cur)}${tag("cbc:TaxInclusiveAmount", money(gross), cur)}${tag("cbc:PayableAmount", money(gross), cur)}</cac:LegalMonetaryTotal>`);
  i.lines.forEach((l, idx) => {
    const g = D(l.taxRate).gt(0) ? "S" : "Z";
    const lineTag = credit ? "cac:CreditNoteLine" : "cac:InvoiceLine";
    const qtyTag = credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity";
    out.push(`<${lineTag}>${tag("cbc:ID", String(idx + 1))}${tag(qtyTag, trimmed(l.quantity), ' unitCode="C62"')}${tag("cbc:LineExtensionAmount", money(D(l.netAmount)), cur)}<cac:Item>${tag("cbc:Name", l.description.slice(0, 200))}<cac:ClassifiedTaxCategory>${tag("cbc:ID", g)}${tag("cbc:Percent", D(l.taxRate).toFixed(2))}<cac:TaxScheme>${tag("cbc:ID", "VAT")}</cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price>${tag("cbc:PriceAmount", trimmed(l.unitPrice, 2), cur)}</cac:Price></${lineTag}>`);
  });
  out.push(`</${root}>`);
  return out.join("\n");
}

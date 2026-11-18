/**
 * Ereignisse, auf die Workflows reagieren können, und die Felder ihrer Nutzlast, die in Bedingungen und Texten verwendbar sind.
 * Ältere Ereignisse tragen nur Kennungen (keine Felder); sie können Benachrichtigungen auslösen, aber nicht gefiltert werden.
 */
export type FieldKind = "number" | "text";
export interface EventSpec { label: string; fields: Record<string, { label: string; kind: FieldKind }> }

const money = { label: "Betrag brutto (€)", kind: "number" } as const;

export const EVENT_CATALOG: Record<string, EventSpec> = {
  "purchase_request.submitted": { label: "Bestellanforderung eingereicht", fields: {} },
  "purchase_request.approved": { label: "Bestellanforderung freigegeben", fields: {} },
  "purchase_request.rejected": { label: "Bestellanforderung abgelehnt", fields: {} },
  "purchase_order.created": { label: "Bestellung ausgelöst", fields: {} },
  "goods_receipt.recorded": { label: "Wareneingang gebucht", fields: {} },
  "absence.requested": { label: "Abwesenheit beantragt", fields: {} },
  "absence.approved": { label: "Abwesenheit genehmigt", fields: {} },
  "absence.rejected": { label: "Abwesenheit abgelehnt", fields: {} },
  "time.period.submitted": { label: "Zeitmonat eingereicht", fields: {} },
  "roster.published": { label: "Dienstplan veröffentlicht", fields: {} },
  "supplier_invoice.approved": { label: "Eingangsrechnung freigegeben", fields: { invoiceNumber: { label: "Rechnungsnummer des Lieferanten", kind: "text" }, gross: money } },
  "customer_invoice.issued": { label: "Ausgangsrechnung ausgestellt", fields: { number: { label: "Rechnungsnummer", kind: "text" }, gross: money } },
  "customer_invoice.paid": { label: "Ausgangsrechnung bezahlt", fields: { paidOn: { label: "Zahlungsdatum", kind: "text" } } },
  "dunning.created": { label: "Mahnung erstellt", fields: { invoiceNumber: { label: "Rechnungsnummer", kind: "text" }, level: { label: "Mahnstufe (1–3)", kind: "number" }, open: { label: "Offener Betrag (€)", kind: "number" } } },
  "quote.sent": { label: "Angebot versendet", fields: { number: { label: "Angebotsnummer", kind: "text" }, gross: money } },
  "quote.accepted": { label: "Angebot angenommen", fields: { number: { label: "Angebotsnummer", kind: "text" }, gross: money } },
  "expense.submitted": { label: "Spesenabrechnung eingereicht", fields: { number: { label: "Nummer", kind: "text" }, total: { label: "Summe (€)", kind: "number" } } },
  "expense.approved": { label: "Spesenabrechnung freigegeben", fields: { number: { label: "Nummer", kind: "text" }, total: { label: "Summe (€)", kind: "number" } } },
  "expense.rejected": { label: "Spesenabrechnung abgelehnt", fields: { number: { label: "Nummer", kind: "text" }, total: { label: "Summe (€)", kind: "number" } } },
  "project.billed": { label: "Projekt abgerechnet", fields: { project: { label: "Projektnummer", kind: "text" }, minutes: { label: "Minuten", kind: "number" }, net: { label: "Netto (€)", kind: "number" } } },
  "stock.below_reorder": { label: "Mindestbestand unterschritten", fields: { item: { label: "Artikelnummer", kind: "text" }, onHand: { label: "Bestand", kind: "number" }, reorderLevel: { label: "Mindestbestand", kind: "number" } } },
};

export const EVENT_TYPES = Object.keys(EVENT_CATALOG);

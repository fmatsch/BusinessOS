/** OpenAPI-Beschreibung der lesenden REST-API (v1). Ein Test stellt sicher, dass jede Route hier beschrieben ist und umgekehrt. */

const page = { type: "object", properties: { limit: { type: "integer" }, offset: { type: "integer" }, total: { type: "integer" } } };
const list = (item: string) => ({ type: "object", properties: { data: { type: "array", items: { $ref: `#/components/schemas/${item}` } }, page } });
const ok = (schema: object) => ({ description: "Erfolg", content: { "application/json": { schema } } });
const errs = {
  "401": { $ref: "#/components/responses/Error" }, "403": { $ref: "#/components/responses/Error" }, "429": { $ref: "#/components/responses/Error" },
};
const pageParams = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
];
const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
const dec = { type: "string", description: "Dezimalzahl als Zeichenkette (nie als Gleitkommazahl)", example: "123.45" };

export const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "BusinessOS API",
    version: "1.0.0",
    description: "Lesende REST-API. Authentifizierung per `Authorization: Bearer bos_…` (Token unter Einstellungen › API-Zugänge). Das Token handelt als der erstellende Benutzer in genau seiner Organisation; die Berechtigungen des Benutzers gelten. Beträge und Mengen sind Zeichenketten. Pro Token sind 120 Anfragen je Minute erlaubt.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearer: [] }],
  paths: {
    "/customers": { get: { summary: "Kunden", description: "Berechtigung `finance.master.read`.", parameters: pageParams, responses: { "200": ok(list("Customer")), ...errs } } },
    "/items": { get: { summary: "Lagerartikel mit Bestand", description: "Berechtigung `inventory.read`.", parameters: pageParams, responses: { "200": ok(list("Item")), ...errs } } },
    "/sales-orders": { get: { summary: "Kundenaufträge", description: "Berechtigung `sales.order.read`.", parameters: [...pageParams, { name: "status", in: "query", schema: { type: "string", enum: ["DRAFT", "CONFIRMED", "CLOSED", "CANCELLED"] } }], responses: { "200": ok(list("SalesOrderSummary")), ...errs } } },
    "/sales-orders/{id}": { get: { summary: "Kundenauftrag mit Positionen und Lieferungen", parameters: [idParam], responses: { "200": ok({ $ref: "#/components/schemas/SalesOrder" }), "404": { $ref: "#/components/responses/Error" }, ...errs } } },
    "/customer-invoices": { get: { summary: "Ausgangsrechnungen", description: "Berechtigung `finance.invoice.read`.", parameters: [...pageParams, { name: "status", in: "query", schema: { type: "string", enum: ["DRAFT", "ISSUED", "CANCELLED"] } }], responses: { "200": ok(list("CustomerInvoiceSummary")), ...errs } } },
    "/customer-invoices/{id}": { get: { summary: "Ausgangsrechnung mit Positionen", parameters: [idParam], responses: { "200": ok({ $ref: "#/components/schemas/CustomerInvoice" }), "404": { $ref: "#/components/responses/Error" }, ...errs } } },
    "/customer-invoices/{id}/einvoice": {
      get: {
        summary: "E-Rechnung (UBL 2.1, EN 16931 / Peppol BIS Billing 3.0)",
        description: "Nur für ausgestellte Belege. Bei fehlenden Stammdaten antwortet die API mit 422 und nennt die fehlenden Angaben. Nicht gegen die offiziellen Schematron-Regeln geprüft.",
        parameters: [idParam],
        responses: { "200": { description: "UBL-XML", content: { "application/xml": { schema: { type: "string" } } } }, "404": { $ref: "#/components/responses/Error" }, "409": { $ref: "#/components/responses/Error" }, "422": { $ref: "#/components/responses/Error" }, ...errs },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API-Token (bos_…)" } },
    responses: { Error: { description: "Fehler", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } } } },
    schemas: {
      Customer: { type: "object", properties: { id: { type: "string" }, number: { type: "string" }, name: { type: "string" }, street: { type: "string", nullable: true }, zip: { type: "string", nullable: true }, city: { type: "string", nullable: true }, country: { type: "string" }, uid: { type: "string", nullable: true }, paymentTermsDays: { type: "integer" }, einvoiceEndpoint: { type: "string", nullable: true }, active: { type: "boolean" } } },
      Item: { type: "object", properties: { id: { type: "string" }, number: { type: "string" }, name: { type: "string" }, unit: { type: "string" }, onHand: dec, reorderLevel: { ...dec, nullable: true }, tracking: { type: "string", enum: ["NONE", "BATCH", "SERIAL"] }, valuationMethod: { type: "string", enum: ["AVG", "FIFO"] }, active: { type: "boolean" } } },
      SalesOrderSummary: { type: "object", properties: { id: { type: "string" }, number: { type: "string", nullable: true }, customerId: { type: "string" }, customerName: { type: "string" }, reference: { type: "string", nullable: true }, status: { type: "string" }, orderDate: { type: "string", format: "date" }, net: dec } },
      SalesOrder: {
        type: "object",
        properties: {
          id: { type: "string" }, number: { type: "string", nullable: true }, customerId: { type: "string" }, customerName: { type: "string" }, reference: { type: "string", nullable: true }, status: { type: "string" }, orderDate: { type: "string", format: "date" }, note: { type: "string", nullable: true }, confirmedAt: { type: "string", format: "date-time", nullable: true },
          lines: { type: "array", items: { type: "object", properties: { position: { type: "integer" }, itemNumber: { type: "string", nullable: true }, description: { type: "string" }, quantity: dec, unitPrice: dec, shipped: dec, billed: dec } } },
          deliveries: { type: "array", items: { type: "object", properties: { id: { type: "string" }, number: { type: "string", nullable: true }, status: { type: "string" }, shippedOn: { type: "string", format: "date", nullable: true }, carrier: { type: "string", nullable: true }, trackingNumber: { type: "string", nullable: true } } } },
        },
      },
      CustomerInvoiceSummary: { type: "object", properties: { id: { type: "string" }, number: { type: "string", nullable: true }, customerNumber: { type: "string" }, customerName: { type: "string" }, kind: { type: "string", enum: ["INVOICE", "CREDIT"] }, status: { type: "string" }, invoiceDate: { type: "string", format: "date" }, dueDate: { type: "string", format: "date", nullable: true }, currency: { type: "string" }, netTotal: dec, taxTotal: dec, grossTotal: dec, paidOn: { type: "string", format: "date", nullable: true } } },
      CustomerInvoice: {
        type: "object",
        properties: {
          id: { type: "string" }, number: { type: "string", nullable: true }, kind: { type: "string" }, status: { type: "string" }, customerNumber: { type: "string" }, customerName: { type: "string" }, invoiceDate: { type: "string", format: "date" }, dueDate: { type: "string", format: "date", nullable: true }, currency: { type: "string" },
          netTotal: dec, taxTotal: dec, grossTotal: dec, paidOn: { type: "string", format: "date", nullable: true }, note: { type: "string", nullable: true },
          lines: { type: "array", items: { type: "object", properties: { description: { type: "string" }, quantity: dec, unitPrice: dec, netAmount: dec, taxRate: { ...dec, nullable: true } } } },
        },
      },
    },
  },
} as const;

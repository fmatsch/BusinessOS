import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const optDate = z.preprocess((v) => (v === "" ? null : v), isoDate.nullish());
const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());

export const accountInput = z.object({
  number: z.string().trim().regex(/^\d{1,9}$/, "Kontonummer: 1–9 Ziffern"),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["GL", "VENDOR", "CUSTOMER"]),
});

export const taxCodeInput = z.object({
  key: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_.-]+$/, "Schlüssel: Buchstaben, Ziffern, . _ -"),
  name: z.string().trim().min(1).max(80),
  rate: decimalString.refine((d) => d.gte(0) && d.lte(100), "Steuersatz 0–100"),
  direction: z.enum(["INPUT", "OUTPUT"]),
  bmdCode: optText(4).refine((v) => v == null || /^\d{1,3}$/.test(v), "BMD-Steuercode: Ziffern"),
  datevKey: optText(4).refine((v) => v == null || /^\d{1,4}$/.test(v), "BU-Schlüssel: Ziffern"),
});

export const customerInput = z.object({
  number: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  street: optText(120), zip: optText(12), city: optText(80),
  country: z.string().trim().length(2).toUpperCase().default("AT"),
  uid: optText(20),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(14),
});

export const partnerAccountsInput = z.object({
  uid: optText(20),
  accountId: optId, // Kreditoren-/Debitorenkonto
  lineAccountId: optId, // Standard-Aufwands-/Erlöskonto
});

export const profileInput = z.object({
  format: z.enum(["DATEV", "BMD"]),
  advisorNumber: optText(7).refine((v) => v == null || /^\d{1,7}$/.test(v), "Beraternummer: Ziffern"),
  clientNumber: optText(5).refine((v) => v == null || /^\d{1,5}$/.test(v), "Mandantennummer: Ziffern"),
  accountLength: z.coerce.number().int().min(4).max(8),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  symbolIn: z.string().trim().regex(/^[A-Z0-9]{1,3}$/, "Buchungssymbol: 1–3 Zeichen A–Z, 0–9"),
  symbolOut: z.string().trim().regex(/^[A-Z0-9]{1,3}$/, "Buchungssymbol: 1–3 Zeichen A–Z, 0–9"),
  dictationCode: z.string().trim().max(2).default(""),
  includeFiles: z.coerce.boolean(),
});

const supplierLine = z.object({
  description: z.string().trim().min(1).max(200),
  netAmount: decimalString.refine((d) => d.gt(0), "Nettobetrag muss größer als 0 sein").refine((d) => d.decimalPlaces() <= 2, "Höchstens 2 Nachkommastellen"),
  taxCodeId: z.string().min(1),
  expenseAccountId: optId,
  costCenterId: optId,
});

export const supplierInvoiceInput = z.object({
  supplierId: z.string().min(1),
  invoiceNumber: z.string().trim().min(1).max(35),
  invoiceDate: isoDate,
  dueDate: optDate,
  kind: z.enum(["INVOICE", "CREDIT"]).default("INVOICE"),
  creditsId: optId,
  purchaseOrderId: optId,
  fileId: optId,
  note: optText(300),
  lines: z.array(supplierLine).min(1).max(50),
});

const customerLine = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: decimalString.refine((d) => d.gt(0), "Menge muss größer als 0 sein"),
  unitPrice: decimalString.refine((d) => d.gte(0), "Preis darf nicht negativ sein"),
  taxCodeId: z.string().min(1),
  revenueAccountId: optId,
  costCenterId: optId,
});

export const customerInvoiceInput = z.object({
  customerId: z.string().min(1),
  invoiceDate: isoDate,
  dueDate: optDate,
  kind: z.enum(["INVOICE", "CREDIT"]).default("INVOICE"),
  creditsId: optId,
  note: optText(300),
  lines: z.array(customerLine).min(1).max(50),
});

export const exportInput = z.object({
  upTo: optDate,
  acceptWarnings: z.coerce.boolean().default(false),
});

export const paidInput = z.object({ id: z.string().min(1), paidOn: isoDate });

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
  matchTolerancePercent: decimalString.refine((d) => d.gte(0) && d.lte(100) && d.decimalPlaces() <= 2, "Toleranz in Prozent: 0–100, höchstens 2 Nachkommastellen").default("2" as never),
  matchToleranceAmount: decimalString.refine((d) => d.gte(0) && d.lte(100000) && d.decimalPlaces() <= 2, "Toleranzbetrag: 0–100.000, höchstens 2 Nachkommastellen").default("5" as never),
});

/** IBAN-Prüfsumme (ISO 13616, Modulo 97). */
export function isValidIban(iban: string) {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

export const issuerInput = z.object({
  legalName: z.string().trim().min(1).max(120),
  street: optText(120), zip: optText(12), city: optText(80),
  country: z.string().trim().length(2).toUpperCase().default("AT"),
  uid: optText(20).refine((v) => v == null || /^[A-Za-z]{2}[A-Za-z0-9]{2,12}$/.test(v.replace(/\s+/g, "")), "UID: Länderkürzel und Ziffern, z. B. ATU12345678"),
  companyRegister: optText(120),
  iban: optText(40).refine((v) => v == null || isValidIban(v), "IBAN ist ungültig (Prüfsumme)"),
  bic: optText(11).refine((v) => v == null || /^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/.test(v), "BIC ist ungültig"),
  bankName: optText(80),
  email: optText(120).refine((v) => v == null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "E-Mail ist ungültig"),
  phone: optText(40),
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

export const dunningInput = z.object({
  invoiceId: z.string().min(1),
  feeAmount: decimalString.refine((d) => d.gte(0) && d.lte(1000) && d.decimalPlaces() <= 2, "Gebühr: 0–1.000, höchstens 2 Nachkommastellen").default("0" as never),
  note: optText(300),
});

export const recurringInput = z.object({
  customerId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  interval: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]),
  firstRunOn: isoDate,
  endsOn: optDate,
  note: optText(300),
  lines: z.array(customerLine).min(1).max(50),
}).refine((v) => !v.endsOn || v.endsOn >= v.firstRunOn, { message: "Das Ende liegt vor dem ersten Lauf", path: ["endsOn"] });

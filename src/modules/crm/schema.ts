import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());

export const contactInput = z.object({
  customerId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  position: optText(80),
  email: optText(120).refine((v) => v == null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "E-Mail ist ungültig"),
  phone: optText(40),
  note: optText(300),
});

export const ACTIVITY_TYPES = ["CALL", "MAIL", "MEETING", "NOTE"] as const;
export const ACTIVITY_LABEL: Record<(typeof ACTIVITY_TYPES)[number], string> = { CALL: "Anruf", MAIL: "E-Mail", MEETING: "Termin", NOTE: "Notiz" };

export const activityInput = z.object({
  customerId: z.string().min(1),
  contactId: optId,
  type: z.enum(ACTIVITY_TYPES),
  occurredOn: isoDate,
  subject: z.string().trim().min(1).max(160),
  body: optText(2000),
});

const quoteLine = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: decimalString.refine((d) => d.gt(0), "Menge muss größer als 0 sein"),
  unitPrice: decimalString.refine((d) => d.gte(0), "Preis darf nicht negativ sein"),
  taxCodeId: z.string().min(1),
  revenueAccountId: optId,
});

export const quoteInput = z.object({
  customerId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  validUntil: isoDate,
  note: optText(300),
  lines: z.array(quoteLine).min(1).max(50),
});

export const quoteDecisionInput = z.object({
  quoteId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: optText(300),
});

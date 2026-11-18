import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const optDate = z.preprocess((v) => (v === "" ? null : v), isoDate.nullish());
const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());

export const CATEGORIES = ["TRAVEL", "ACCOMMODATION", "MEALS", "MILEAGE", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = { TRAVEL: "Fahrt/Ticket", ACCOMMODATION: "Unterkunft", MEALS: "Verpflegung", MILEAGE: "Kilometergeld", OTHER: "Sonstiges" };

export const MAX_LINE_AMOUNT = "10000";

export const reportInput = z.object({
  title: z.string().trim().min(1).max(120),
  tripFrom: optDate,
  tripTo: optDate,
  costCenterId: optId,
  note: optText(300),
}).refine((v) => !v.tripFrom || !v.tripTo || v.tripTo >= v.tripFrom, { message: "Das Reiseende liegt vor dem Beginn", path: ["tripTo"] });

export const lineInput = z.object({
  reportId: z.string().min(1),
  date: isoDate,
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(1).max(200),
  /** Bei Kilometergeld die gefahrenen km (der Betrag wird aus dem Kilometersatz berechnet), sonst der Betrag. */
  amount: decimalString.refine((d) => d.gt(0) && d.lte(MAX_LINE_AMOUNT) && d.decimalPlaces() <= 2, `Betrag: größer 0, höchstens ${MAX_LINE_AMOUNT}, 2 Nachkommastellen`),
});

export const decisionInput = z.object({
  reportId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: optText(300),
});

export const paidInput = z.object({ reportId: z.string().min(1), paidOn: isoDate });

export const mileageRateInput = decimalString.refine((d) => d.gt(0) && d.lte(5) && d.decimalPlaces() <= 4, "Kilometersatz: größer 0, höchstens 5, 4 Nachkommastellen");

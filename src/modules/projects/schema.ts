import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const optDate = z.preprocess((v) => (v === "" ? null : v), isoDate.nullish());
const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const optDecimal = (check: (d: import("decimal.js").Decimal) => boolean, msg: string) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), decimalString.refine(check, msg).nullish());

export const projectInput = z.object({
  name: z.string().trim().min(1).max(120),
  customerId: optId,
  costCenterId: optId,
  hourlyRate: optDecimal((d) => d.gt(0) && d.lte(10000) && d.decimalPlaces() <= 2, "Stundensatz: größer 0, höchstens 2 Nachkommastellen"),
  budgetHours: optDecimal((d) => d.gt(0) && d.lte(100000) && d.decimalPlaces() <= 2, "Stundenbudget: größer 0, höchstens 2 Nachkommastellen"),
  startsOn: optDate,
  endsOn: optDate,
  note: optText(300),
}).refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, { message: "Das Ende liegt vor dem Beginn", path: ["endsOn"] });

export const bookTimeInput = z.object({
  projectId: z.string().min(1),
  workDate: isoDate,
  hours: decimalString.refine((d) => d.gt(0) && d.lte(24) && d.decimalPlaces() <= 2, "Stunden: größer 0, höchstens 24, 2 Nachkommastellen"),
  note: optText(200),
});

export const billInput = z.object({
  projectId: z.string().min(1),
  upTo: isoDate,
  taxCodeId: z.string().min(1),
  revenueAccountId: optId,
});

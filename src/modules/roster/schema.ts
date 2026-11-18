import { z } from "zod";
import { isValidIsoDate } from "@/modules/hr/queries";
import { isValidTimeZone } from "./timezone";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM");
const name = z.string().trim().min(1).max(80);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const optionalId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());

export const siteInput = z.object({
  name,
  timeZone: z.string().refine(isValidTimeZone, "Unbekannte Zeitzone (z. B. Europe/Vienna)"),
});

export const qualificationInput = z.object({ name });

export const templateInput = z.object({
  name,
  startTime: hhmm,
  endTime: hhmm,
  breakMinutes: z.coerce.number().int().min(0).max(600),
  requiredCount: z.coerce.number().int().min(1).max(100),
  qualificationId: optionalId,
});

export const rosterInput = z
  .object({ siteId: z.string().min(1), startDate: isoDate, endDate: isoDate })
  .refine((v) => v.endDate >= v.startDate, { message: "Das Ende darf nicht vor dem Beginn liegen", path: ["endDate"] });

export const shiftInput = z.object({
  rosterId: z.string().min(1),
  date: isoDate,
  startTime: hhmm,
  endTime: hhmm,
  breakMinutes: z.coerce.number().int().min(0).max(600),
  requiredCount: z.coerce.number().int().min(1).max(100),
  qualificationId: optionalId,
  label: optionalText(80),
});

export const assignInput = z.object({ shiftId: z.string().min(1), employeeId: z.string().min(1) });

export const rulesInput = z.object({
  restDailyMinutes: z.coerce.number().int().min(0).max(24 * 60),
  maxDailyMinutes: z.coerce.number().int().min(60).max(24 * 60),
  maxWeeklyMinutes: z.coerce.number().int().min(60).max(7 * 24 * 60),
  breakAfterMinutes: z.coerce.number().int().min(60).max(24 * 60),
  minBreakMinutes: z.coerce.number().int().min(0).max(240),
  weeklyRestMinutes: z.coerce.number().int().min(0).max(7 * 24 * 60),
});

export const swapRequestInput = z.object({ shiftId: z.string().min(1), toEmployeeId: z.string().min(1), note: optionalText(200) });

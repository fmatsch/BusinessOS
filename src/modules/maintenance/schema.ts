import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);

export const objectInput = z.object({ name: z.string().trim().min(1).max(120), location: optText(120), fixedAssetId: optId });

export const planInput = z.object({
  objectId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  instructions: optText(2000),
  intervalUnit: z.enum(["DAYS", "MONTHS"]),
  intervalValue: z.coerce.number().int().min(1).max(3650),
  firstDueOn: isoDate,
});

export const reportInput = z.object({ objectId: z.string().min(1), title: z.string().trim().min(3).max(120), description: optText(2000), priority: priority.default("NORMAL") });

export const completeInput = z.object({
  report: z.string().trim().min(3, "Bitte kurz berichten, was getan wurde").max(2000),
  minutesSpent: z.coerce.number().int().min(0).max(100_000),
  doneOn: isoDate,
  parts: z.array(z.object({
    itemId: z.string().min(1),
    quantity: decimalString.refine((d) => d.gt(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, "Menge: größer 0, höchstens 4 Nachkommastellen"),
    locationId: optId,
  })).max(50).default([]),
});

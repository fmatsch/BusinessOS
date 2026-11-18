import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optAmount = z.preprocess((v) => (v === "" || v === undefined ? null : v), decimalString.refine((d) => d.gte(0) && d.decimalPlaces() <= 2, "Betrag: höchstens 2 Nachkommastellen").nullish());

export const settingsInput = z.object({ startDate: isoDate, bankAccountId: optId });

export const entryLineInput = z.object({ accountId: z.string().min(1), debit: optAmount, credit: optAmount, costCenterId: optId, text: z.string().trim().max(120).nullish() });

export const entryInput = z.object({
  date: isoDate,
  text: z.string().trim().min(1).max(200),
  /** OPENING für Eröffnungsbuchungen, sonst MANUAL */
  opening: z.boolean().default(false),
  lines: z.array(entryLineInput).min(2).max(100),
});

export const periodInput = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });

export const rangeInput = z.object({ from: isoDate.nullish(), to: isoDate });

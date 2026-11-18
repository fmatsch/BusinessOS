import { z } from "zod";
import { isValidIsoDate } from "@/modules/hr/queries";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM");
const optionalId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const reason = z.string().trim().min(3, "Bitte eine Begründung angeben").max(300);

const interval = {
  date: isoDate,
  startTime: hhmm,
  endTime: hhmm,
  breakMinutes: z.coerce.number().int().min(0).max(600).default(0),
  costCenterId: optionalId,
};

export const clockInInput = z.object({ costCenterId: optionalId });

export const entryRequestInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD"), ...interval, reason }),
  z.object({ type: z.literal("CORRECT"), targetEntryId: z.string().min(1), ...interval, reason }),
  z.object({ type: z.literal("DELETE"), targetEntryId: z.string().min(1), reason }),
]);

export const directAddInput = z.object({ employeeId: z.string().min(1), ...interval, reason });
export const directCorrectInput = z.object({ entryId: z.string().min(1), ...interval, reason });
export const directDeleteInput = z.object({ entryId: z.string().min(1), reason });

export const decisionInput = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(500).nullish()),
});

export const periodKey = z.object({ employeeId: z.string().min(1), year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
export const submitInput = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
export const reopenInput = periodKey.extend({ reason });
export const returnInput = periodKey.extend({ comment: z.string().trim().min(3, "Bitte einen Grund angeben").max(300) });

export const adjustmentInput = z.object({
  employeeId: z.string().min(1),
  minutes: z.coerce.number().int().min(-60 * 1000).max(60 * 1000).refine((n) => n !== 0, "Minuten dürfen nicht 0 sein"),
  note: reason,
});

export const payCodeInput = z.object({
  NIGHT: z.coerce.number().min(0).max(500),
  SUNDAY: z.coerce.number().min(0).max(500),
  HOLIDAY: z.coerce.number().min(0).max(500),
  OVERTIME: z.coerce.number().min(0).max(500),
});

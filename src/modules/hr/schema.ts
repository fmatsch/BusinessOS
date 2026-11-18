import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "./calendar";

const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), text(max).nullish());

export const CONTRACT_TYPES = ["FULL_TIME", "PART_TIME", "MARGINAL", "APPRENTICE", "OTHER"] as const;

export const employeeInput = z.object({
  number: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().email().max(200).nullish()),
  jobTitle: optionalText(80),
  departmentId: z.string().min(1).nullish(),
  managerId: z.string().min(1).nullish(),
  userId: z.string().min(1).nullish(),
});
export const employeeUpdateInput = employeeInput.omit({ number: true }).extend({ active: z.boolean().optional() });

export const sensitiveInput = z.object({
  birthDate: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    isoDate.refine((d) => d >= "1900-01-01" && d < new Date().toISOString().slice(0, 10), "Geburtsdatum muss in der Vergangenheit liegen").nullish(),
  ),
  addressLine: optionalText(200),
  phone: optionalText(40),
  emergencyContact: optionalText(200),
});

export const employmentInput = z
  .object({
    employeeId: z.string().min(1),
    validFrom: isoDate,
    validTo: z.preprocess((v) => (v === "" ? null : v), isoDate.nullish()),
    contractType: z.enum(CONTRACT_TYPES),
    weeklyHours: decimalString.refine((d) => d.gt(0) && d.lte(60), "Wochenstunden müssen zwischen 0 und 60 liegen"),
    costCenterId: z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish()),
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, { message: "Ende darf nicht vor dem Beginn liegen", path: ["validTo"] });

export const LEAVE_ENTRY_KINDS = ["ENTITLEMENT", "CARRYOVER", "ADJUSTMENT"] as const;
export const leaveEntryInput = z
  .object({
    employeeId: z.string().min(1),
    year: z.coerce.number().int().min(2000).max(2100),
    kind: z.enum(LEAVE_ENTRY_KINDS),
    days: decimalString.refine((d) => d.abs().lte(366) && !d.isZero(), "Tage zwischen -366 und 366, nicht 0"),
    note: optionalText(200),
  })
  .refine((v) => v.kind === "ADJUSTMENT" || v.days.gt(0), { message: "Anspruch und Übertrag müssen positiv sein", path: ["days"] });

export const absenceInput = z
  .object({
    typeKey: z.string().min(1).max(30),
    startDate: isoDate,
    endDate: isoDate,
    note: optionalText(200),
  })
  .refine((v) => v.endDate >= v.startDate, { message: "Das Ende darf nicht vor dem Beginn liegen", path: ["endDate"] });

export const absenceDecisionInput = z.object({
  absenceId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: optionalText(500),
});

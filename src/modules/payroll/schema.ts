import { z } from "zod";

const code = z.string().trim().max(20).regex(/^[A-Za-z0-9._-]*$/, "Lohnart: nur Buchstaben, Ziffern, . _ -");

export const profileInput = z
  .object({
    delimiter: z.enum([";", ",", "\t", "|"]),
    decimalSeparator: z.enum([",", "."]),
    includeHeader: z.coerce.boolean(),
    encoding: z.enum(["utf8", "utf8-bom", "latin1"]),
    unit: z.enum(["HOURS", "MINUTES"]),
    includeSurcharge: z.coerce.boolean(),
    codes: z.object({
      NORMAL: code.default(""), MEHRZEIT: code.default(""), NIGHT: code.default(""), SUNDAY: code.default(""), HOLIDAY: code.default(""),
      VACATION: code.default(""), SICK: code.default(""), CARE: code.default(""), SPECIAL: code.default(""),
    }),
  })
  .refine((p) => p.delimiter !== p.decimalSeparator, { message: "Trennzeichen und Dezimalzeichen müssen verschieden sein", path: ["decimalSeparator"] });

export const monthInput = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
export const exportInput = monthInput.extend({ acceptIncomplete: z.coerce.boolean().default(false) });

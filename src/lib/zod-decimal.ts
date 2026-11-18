import { z } from "zod";
import { parseDecimal } from "@/lib/money";

export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return parseDecimal(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "Ungültige Zahl" });
      return z.NEVER;
    }
  });

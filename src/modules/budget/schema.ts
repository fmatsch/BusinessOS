import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";

export const budgetInput = z.object({
  costCenterId: z.string().min(1),
  fiscalYear: z.coerce.number().int().min(2000).max(2100),
  amount: decimalString.refine((d) => d.gte(0), "Budget darf nicht negativ sein"),
});

import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";

export const supplierInput = z.object({
  number: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).nullish().or(z.literal("").transform(() => null)),
});

export const requestInput = z.object({
  title: z.string().trim().min(1).max(160),
  costCenterId: z.string().min(1).nullish(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        quantity: decimalString.refine((d) => d.gt(0), "Menge muss > 0 sein"),
        unitPrice: decimalString.refine((d) => d.gte(0), "Preis darf nicht negativ sein"),
      }),
    )
    .min(1)
    .max(100),
});

export const decisionInput = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().trim().max(500).nullish(),
});

export const orderInput = z.object({
  requestId: z.string().min(1),
  supplierId: z.string().min(1),
  costCenterId: z.string().min(1),
});

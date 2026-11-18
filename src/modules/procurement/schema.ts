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

export const receiptInput = z.object({
  orderId: z.string().min(1),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT"),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(200).nullish()),
  lines: z
    .array(z.object({ requestLineId: z.string().min(1), quantity: decimalString.refine((d) => d.gt(0), "Menge muss > 0 sein") }))
    .min(1)
    .max(100),
});

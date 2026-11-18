import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";

const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const optDec = z.preprocess((v) => (v === "" ? null : v), decimalString.refine((d) => d.isFinite() && d.decimalPlaces() <= 6, "Höchstens 6 Nachkommastellen").nullish());
const qty = decimalString.refine((d) => d.gt(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, "Menge: größer 0, höchstens 4 Nachkommastellen");

export const planInput = z.object({
  itemId: z.string().min(1),
  note: optText(500),
  characteristics: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["QUANTITATIVE", "QUALITATIVE"]),
    unit: optText(20),
    minValue: optDec,
    maxValue: optDec,
  })).min(1, "Mindestens ein Prüfmerkmal").max(100),
});

export const inspectionInput = z.object({
  itemId: z.string().min(1),
  quantity: qty,
  batchNumber: optText(40),
  source: z.enum(["MANUAL", "GOODS_RECEIPT", "PRODUCTION"]).default("MANUAL"),
  reference: optText(120),
});

export const resultInput = z.object({
  characteristicId: z.string().min(1),
  value: optDec,
  passed: z.preprocess((v) => (v === "" || v === undefined ? null : v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean().nullish()),
  note: optText(300),
});

export const decisionInput = z.object({
  decision: z.enum(["ACCEPT", "REJECT"]),
  note: optText(500),
  deviation: z.coerce.boolean().default(false),
});

export const ncInput = z.object({
  itemId: z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish()),
  description: z.string().trim().min(5, "Bitte die Abweichung beschreiben").max(1000),
  cause: optText(1000),
  action: optText(1000),
});

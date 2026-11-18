import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";

const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const qty = (label: string) => decimalString.refine((d) => d.gt(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, `${label}: größer 0, höchstens 4 Nachkommastellen`);

export const itemInput = z.object({
  number: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/, "Artikelnummer: Buchstaben, Ziffern, . _ -"),
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(10).default("Stk"),
  reorderLevel: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), qty("Mindestbestand").nullish()),
});

export const itemUpdateInput = z.object({
  name: z.string().trim().min(1).max(120),
  reorderLevel: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), qty("Mindestbestand").nullish()),
  active: z.coerce.boolean(),
});

export const stockReceiptInput = z.object({ goodsReceiptLineId: z.string().min(1), itemId: optId });
export const issueInput = z.object({ itemId: z.string().min(1), quantity: qty("Menge"), costCenterId: optId, note: optText(200) });
export const adjustInput = z.object({
  itemId: z.string().min(1),
  /// gezählter Istbestand; die Differenz zum Buchbestand wird als Korrektur gebucht
  counted: decimalString.refine((d) => d.gte(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, "Bestand: 0 bis 1.000.000, höchstens 4 Nachkommastellen"),
  reason: z.string().trim().min(3).max(200),
});

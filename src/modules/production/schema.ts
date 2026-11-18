import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const qty = decimalString.refine((d) => d.gt(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, "Menge: größer 0, höchstens 4 Nachkommastellen");
const optDate = z.preprocess((v) => (v === "" ? null : v), z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)").nullish());
const serials = z.preprocess((v) => (typeof v === "string" ? v.split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean) : v ?? []), z.array(z.string().trim().min(1).max(60)).max(500));

export const bomInput = z.object({
  itemId: z.string().min(1),
  outputQuantity: qty.default("1" as never),
  note: optText(500),
  lines: z.array(z.object({
    componentItemId: z.string().min(1),
    quantity: qty,
    scrapPercent: decimalString.refine((d) => d.gte(0) && d.lt(100) && d.decimalPlaces() <= 2, "Ausschuss: 0 bis unter 100 %").default("0" as never),
  })).min(1, "Mindestens eine Komponente").max(200),
});

export const productionOrderInput = z.object({ itemId: z.string().min(1), quantity: qty, plannedDate: optDate, note: optText(500) });

export const confirmInput = z.object({
  orderId: z.string().min(1),
  quantity: qty,
  componentLocationId: optId,
  outputLocationId: optId,
  batchNumber: optText(40),
  expiresOn: optDate,
  serials,
});

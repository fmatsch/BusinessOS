import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";

const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const qty = (label: string) => decimalString.refine((d) => d.gt(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, `${label}: größer 0, höchstens 4 Nachkommastellen`);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum JJJJ-MM-TT");
/** Seriennummern: Liste oder Text (eine je Zeile oder durch Komma getrennt). */
const serials = z.preprocess((v) => (typeof v === "string" ? v.split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean) : v ?? []), z.array(z.string().trim().min(1).max(60)).max(500).default([]));
/** Lagerort, Charge, Seriennummern – gemeinsam bei jeder Bewegung. */
const place = { locationId: optId, batchNumber: optText(40), serials };
const tracking = z.enum(["NONE", "BATCH", "SERIAL"]);
const valuationMethod = z.enum(["AVG", "FIFO"]);

export const itemInput = z.object({
  tracking: tracking.default("NONE"),
  valuationMethod: valuationMethod.default("AVG"),
  number: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/, "Artikelnummer: Buchstaben, Ziffern, . _ -"),
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(10).default("Stk"),
  reorderLevel: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), qty("Mindestbestand").nullish()),
});

export const itemUpdateInput = z.object({
  tracking: tracking.optional(),
  valuationMethod: valuationMethod.optional(),
  name: z.string().trim().min(1).max(120),
  reorderLevel: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), qty("Mindestbestand").nullish()),
  active: z.coerce.boolean(),
});

export const stockReceiptInput = z.object({ goodsReceiptLineId: z.string().min(1), itemId: optId, ...place, expiresOn: z.preprocess((v) => (v === "" ? null : v), isoDate.nullish()) });
export const issueInput = z.object({ itemId: z.string().min(1), quantity: qty("Menge").optional(), costCenterId: optId, note: optText(200), ...place });
export const transferInput = z.object({ itemId: z.string().min(1), quantity: qty("Menge").optional(), fromLocationId: optId, toLocationId: optId, batchNumber: optText(40), serials, note: optText(200) });
export const locationInput = z.object({ code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/, "Lagerort-Code: Buchstaben, Ziffern, . _ -"), name: z.string().trim().min(1).max(80) });
export const adjustInput = z.object({
  itemId: z.string().min(1),
  /// gezählter Istbestand; die Differenz zum Buchbestand wird als Korrektur gebucht
  counted: decimalString.refine((d) => d.gte(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, "Bestand: 0 bis 1.000.000, höchstens 4 Nachkommastellen"),
  reason: z.string().trim().min(3).max(200),
  locationId: optId,
  batchNumber: optText(40),
});

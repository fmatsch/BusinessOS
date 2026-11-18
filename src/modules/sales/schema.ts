import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";

const optId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullish());
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullish());
const qty = decimalString.refine((d) => d.gt(0) && d.lte(1_000_000) && d.decimalPlaces() <= 4, "Menge: größer 0, höchstens 4 Nachkommastellen");
const price = decimalString.refine((d) => d.gte(0) && d.lte(100_000_000) && d.decimalPlaces() <= 4, "Preis: 0 oder mehr, höchstens 4 Nachkommastellen");
const isoDate = z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)");

export const orderInput = z.object({
  customerId: z.string().min(1),
  reference: optText(80),
  orderDate: isoDate,
  note: optText(500),
  lines: z.array(z.object({
    itemId: optId,
    description: z.string().trim().min(1).max(200),
    quantity: qty,
    unitPrice: price,
    taxCodeId: z.string().min(1),
    revenueAccountId: optId,
  })).min(1, "Mindestens eine Position").max(100),
});

export const deliveryInput = z.object({
  orderId: z.string().min(1),
  carrier: optText(60),
  trackingNumber: optText(80),
  note: optText(500),
  lines: z.array(z.object({
    orderLineId: z.string().min(1),
    quantity: qty,
    locationId: optId,
    batchNumber: optText(40),
    serials: optText(4000),
  })).min(1, "Mindestens eine Position").max(100),
});

export const shipInput = z.object({
  shippedOn: isoDate,
  carrier: optText(60),
  trackingNumber: optText(80),
});

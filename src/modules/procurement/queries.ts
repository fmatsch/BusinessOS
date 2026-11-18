import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

/** Bestellmengen, Liefermengen und Werte einer Bestellung (netto). Ohne Berechtigungsprüfung – nur für Aufrufer, die selbst autorisieren. */
export async function receivingOf(tx: Prisma.TransactionClient, organizationId: string, orderId: string) {
  const order = await tx.purchaseOrder.findFirst({ where: { id: orderId, organizationId }, include: { request: { include: { lines: true } }, receipts: { include: { lines: true } } } });
  if (!order) return null;
  const received = new Map<string, Decimal>();
  for (const r of order.receipts) for (const l of r.lines) received.set(l.requestLineId, (received.get(l.requestLineId) ?? new Decimal(0)).plus(l.quantity.toString()));
  const lines = (order.request?.lines ?? []).map((l) => {
    const qty = new Decimal(l.quantity.toString()), price = new Decimal(l.unitPrice.toString()), got = received.get(l.id) ?? new Decimal(0);
    return { id: l.id, description: l.description, ordered: qty, received: got, open: Decimal.max(qty.minus(got), 0), unitPrice: price };
  });
  const sum = (f: (l: (typeof lines)[number]) => Decimal) => lines.reduce((a, l) => a.plus(f(l)), new Decimal(0));
  const orderedNet = sum((l) => l.ordered.mul(l.unitPrice)), receivedNet = sum((l) => l.received.mul(l.unitPrice));
  const status = receivedNet.isZero() && sum((l) => l.received).isZero() ? "NOT_RECEIVED" : lines.every((l) => l.received.gte(l.ordered)) ? "COMPLETE" : "PARTIAL";
  return { order, lines, orderedNet, receivedNet, status: status as "NOT_RECEIVED" | "PARTIAL" | "COMPLETE" };
}

/**
 * Wareneingangspositionen für das Lager (neueste zuerst). Gegenbuchungen (negative Mengen) tragen die Position,
 * die sie aufheben (`reversesLineId`). Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst.
 */
export async function receiptLinesForStock(tx: Prisma.TransactionClient, organizationId: string, take = 300, ids?: string[]) {
  const lines = await tx.goodsReceiptLine.findMany({
    where: { receipt: { organizationId }, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { receipt: { createdAt: "desc" } }, take,
    include: { receipt: { select: { id: true, receivedOn: true, reversesId: true, order: { select: { number: true } } } } },
  });
  const lineIds = [...new Set(lines.map((l) => l.requestLineId))];
  const [requestLines, originals] = await Promise.all([
    tx.purchaseRequestLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, description: true } }),
    tx.goodsReceiptLine.findMany({ where: { receiptId: { in: lines.map((l) => l.receipt.reversesId).filter((x): x is string => !!x) }, requestLineId: { in: lineIds } }, select: { id: true, receiptId: true, requestLineId: true } }),
  ]);
  const desc = new Map(requestLines.map((r) => [r.id, r.description]));
  return lines.map((l) => ({
    id: l.id, quantity: new Decimal(l.quantity.toString()), receivedOn: l.receipt.receivedOn, orderNumber: l.receipt.order.number, description: desc.get(l.requestLineId) ?? "–",
    reversesLineId: l.receipt.reversesId ? originals.find((o) => o.receiptId === l.receipt.reversesId && o.requestLineId === l.requestLineId)?.id ?? null : null,
  }));
}

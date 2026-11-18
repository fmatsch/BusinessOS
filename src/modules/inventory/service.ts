import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { receiptLinesForStock } from "@/modules/procurement/queries";
import { adjustInput, issueInput, itemInput, itemUpdateInput, stockReceiptInput } from "./schema";

type Tx = Prisma.TransactionClient;
const d = (v: Decimal.Value) => new Decimal(v);
const lockItem = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

/** Bestand = Summe aller Bewegungen (Journal). */
async function stockOf(tx: Tx | typeof db, organizationId: string, itemIds: string[]) {
  const rows = await tx.stockMovement.groupBy({ by: ["itemId"], where: { organizationId, itemId: { in: itemIds } }, _sum: { quantity: true } });
  return new Map(itemIds.map((id) => [id, d(rows.find((r) => r.itemId === id)?._sum.quantity?.toString() ?? 0)]));
}

async function lockedItem(tx: Tx, ctx: Ctx, id: string) {
  await lockItem(tx, ctx.organizationId, id); // serialisiert Buchungen je Artikel (kein negativer Bestand durch Parallelität)
  const item = await tx.item.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!item) throw new NotFoundError("Artikel");
  return item;
}

// ───────────────────────── Artikel ─────────────────────────

export async function createItem(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.manage");
  const input = itemInput.parse(raw);
  return db.$transaction(async (tx) => {
    const created = await tx.item.create({ data: { organizationId: ctx.organizationId, number: input.number, name: input.name, unit: input.unit, reorderLevel: input.reorderLevel?.toString() ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "item.create", entityType: "Item", entityId: created.id, after: { number: input.number, name: input.name } });
    return created;
  });
}

/** Name, Mindestbestand und Aktiv-Status ändern. Die Einheit bleibt, weil Bewegungen darauf beruhen. */
export async function updateItem(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "inventory.manage");
  const input = itemUpdateInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = await lockedItem(tx, ctx, id);
    if (!input.active && item.active && (await stockOf(tx, ctx.organizationId, [id])).get(id)!.gt(0)) throw new ConflictError("Artikel mit Bestand können nicht deaktiviert werden");
    await tx.item.update({ where: { id }, data: { name: input.name, reorderLevel: input.reorderLevel?.toString() ?? null, active: input.active } });
    await writeAudit(tx, ctx, { action: "item.update", entityType: "Item", entityId: id, after: { name: input.name, active: input.active } });
  });
}

export async function listItems(ctx: Ctx) {
  authorize(ctx, "inventory.read");
  const items = await db.item.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ active: "desc" }, { number: "asc" }], take: 500 });
  const stock = await stockOf(db, ctx.organizationId, items.map((i) => i.id));
  return items.map((i) => {
    const onHand = stock.get(i.id)!;
    return { ...i, onHand, belowReorder: i.reorderLevel !== null && i.active && onHand.lte(i.reorderLevel.toString()) };
  });
}

export async function getItem(ctx: Ctx, id: string) {
  authorize(ctx, "inventory.read");
  const item = await db.item.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!item) throw new NotFoundError("Artikel");
  const [movements, stock] = await Promise.all([
    db.stockMovement.findMany({ where: { organizationId: ctx.organizationId, itemId: id }, orderBy: { createdAt: "desc" }, take: 200, include: { reversedBy: { select: { id: true } } } }),
    stockOf(db, ctx.organizationId, [id]),
  ]);
  return { ...item, onHand: stock.get(id)!, movements: movements.map((m) => ({ ...m, reversed: !!m.reversedBy })) };
}

// ───────────────────────── Wareneingang einbuchen ─────────────────────────

/** Wareneingangspositionen, die noch nicht eingebucht sind (neueste zuerst). */
export async function listStockableReceiptLines(ctx: Ctx) {
  authorize(ctx, "inventory.move");
  const lines = await receiptLinesForStock(db, ctx.organizationId);
  const done = new Set((await db.stockMovement.findMany({ where: { organizationId: ctx.organizationId, goodsReceiptLineId: { in: lines.map((l) => l.id) } }, select: { goodsReceiptLineId: true } })).map((m) => m.goodsReceiptLineId));
  return lines.filter((l) => !done.has(l.id));
}

/**
 * Bucht eine Wareneingangsposition ein. Jede Position höchstens einmal. Eine Gegenbuchung des Wareneingangs (negative Menge)
 * nimmt den Artikel der ursprünglichen Position und verringert den Bestand entsprechend.
 */
export async function stockReceiptLine(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  const input = stockReceiptInput.parse(raw);
  return db.$transaction(async (tx) => {
    const line = (await receiptLinesForStock(tx, ctx.organizationId, 1, [input.goodsReceiptLineId]))[0];
    if (!line) throw new NotFoundError("Wareneingangsposition");
    let itemId = input.itemId ?? null;
    if (line.quantity.lt(0)) {
      const orig = line.reversesLineId ? await tx.stockMovement.findFirst({ where: { organizationId: ctx.organizationId, goodsReceiptLineId: line.reversesLineId } }) : null;
      if (!orig) throw new ConflictError("Der ursprüngliche Wareneingang ist noch nicht eingebucht – die Gegenbuchung hat nichts zu korrigieren");
      itemId = orig.itemId;
    }
    if (!itemId) throw new ConflictError("Bitte einen Artikel wählen");
    const item = await lockedItem(tx, ctx, itemId);
    if (!item.active) throw new ConflictError("Der Artikel ist deaktiviert");
    if (await tx.stockMovement.findFirst({ where: { goodsReceiptLineId: line.id }, select: { id: true } })) throw new ConflictError("Die Position ist bereits eingebucht");
    const onHand = (await stockOf(tx, ctx.organizationId, [itemId])).get(itemId)!;
    if (onHand.plus(line.quantity).lt(0)) throw new ConflictError(`Der Bestand würde negativ (vorhanden ${onHand.toString()} ${item.unit})`);
    const m = await tx.stockMovement.create({ data: { organizationId: ctx.organizationId, itemId, kind: "RECEIPT", quantity: line.quantity.toString(), goodsReceiptLineId: line.id, note: `${line.orderNumber}: ${line.description}`, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "stock.receipt", entityType: "StockMovement", entityId: m.id, after: { item: item.number, quantity: line.quantity.toString(), goodsReceiptLineId: line.id } });
    return m;
  });
}

// ───────────────────────── Entnahme, Inventur, Korrektur ─────────────────────────

export async function issueStock(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  const input = issueInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = await lockedItem(tx, ctx, input.itemId);
    if (input.costCenterId && !(await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    const onHand = (await stockOf(tx, ctx.organizationId, [item.id])).get(item.id)!;
    if (onHand.lt(input.quantity)) throw new ConflictError(`Nicht genug Bestand: vorhanden ${onHand.toString()} ${item.unit}, gewünscht ${input.quantity.toString()}`);
    const m = await tx.stockMovement.create({ data: { organizationId: ctx.organizationId, itemId: item.id, kind: "ISSUE", quantity: input.quantity.negated().toString(), costCenterId: input.costCenterId ?? null, note: input.note ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "stock.issue", entityType: "StockMovement", entityId: m.id, after: { item: item.number, quantity: input.quantity.toString(), costCenterId: input.costCenterId ?? null } });
    return m;
  });
}

/** Inventur: der gezählte Bestand wird als Korrekturbuchung (Differenz) mit Begründung festgehalten. */
export async function adjustStock(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  const input = adjustInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = await lockedItem(tx, ctx, input.itemId);
    const onHand = (await stockOf(tx, ctx.organizationId, [item.id])).get(item.id)!;
    const diff = input.counted.minus(onHand);
    if (diff.isZero()) throw new ConflictError("Der gezählte Bestand entspricht dem Buchbestand – nichts zu korrigieren");
    const m = await tx.stockMovement.create({ data: { organizationId: ctx.organizationId, itemId: item.id, kind: "ADJUST", quantity: diff.toString(), note: input.reason, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "stock.adjust", entityType: "StockMovement", entityId: m.id, after: { item: item.number, from: onHand.toString(), to: input.counted.toString(), reason: input.reason } });
    return m;
  });
}

/** Gegenbuchung zu einer Entnahme oder Korrektur. Einbuchungen aus dem Wareneingang werden in der Beschaffung korrigiert. */
export async function reverseMovement(ctx: Ctx, movementId: string, reason: string) {
  authorize(ctx, "inventory.move");
  const why = reason.trim();
  if (why.length < 3) throw new ConflictError("Bitte eine Begründung angeben");
  return db.$transaction(async (tx) => {
    const m0 = await tx.stockMovement.findFirst({ where: { id: movementId, organizationId: ctx.organizationId } });
    if (!m0) throw new NotFoundError("Bewegung");
    const item = await lockedItem(tx, ctx, m0.itemId);
    const m = await tx.stockMovement.findFirstOrThrow({ where: { id: movementId }, include: { reversedBy: true } });
    if (m.kind === "RECEIPT") throw new ConflictError("Wareneingänge werden in der Beschaffung korrigiert (Gegenbuchung) und danach hier eingebucht");
    if (m.kind === "REVERSAL") throw new ConflictError("Gegenbuchungen können nicht korrigiert werden");
    if (m.reversedBy) throw new ConflictError("Die Bewegung wurde bereits korrigiert");
    const onHand = (await stockOf(tx, ctx.organizationId, [item.id])).get(item.id)!;
    const delta = d(m.quantity.toString()).negated();
    if (onHand.plus(delta).lt(0)) throw new ConflictError(`Der Bestand würde negativ (vorhanden ${onHand.toString()} ${item.unit})`);
    const rev = await tx.stockMovement.create({ data: { organizationId: ctx.organizationId, itemId: item.id, kind: "REVERSAL", quantity: delta.toString(), reversesId: m.id, costCenterId: m.costCenterId, note: why, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "stock.reverse", entityType: "StockMovement", entityId: rev.id, after: { reverses: m.id, reason: why } });
    return rev;
  });
}

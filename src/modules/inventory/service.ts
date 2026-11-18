import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { receiptLinesForStock } from "@/modules/procurement/queries";
import { adjustInput, issueInput, itemInput, itemUpdateInput, locationInput, stockReceiptInput, transferInput } from "./schema";
import { valueMovements, type ValuationMethod } from "./valuation";

type Tx = Prisma.TransactionClient;
const d = (v: Decimal.Value) => new Decimal(v);
const lockItem = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

/** Bestand = Summe aller Bewegungen (Journal), über alle Lagerorte. */
async function stockOf(tx: Tx | typeof db, organizationId: string, itemIds: string[]) {
  const rows = await tx.stockMovement.groupBy({ by: ["itemId"], where: { organizationId, itemId: { in: itemIds } }, _sum: { quantity: true } });
  return new Map(itemIds.map((id) => [id, d(rows.find((r) => r.itemId === id)?._sum.quantity?.toString() ?? 0)]));
}

interface Dim { locationId: string | null; batchId: string | null }
/** Bestand an genau einem Lagerort (leer = „ohne Lagerort“) und in genau einer Charge (leer = ohne Charge). */
async function balanceAt(tx: Tx, organizationId: string, itemId: string, dim: Dim, serial?: string) {
  const r = await tx.stockMovement.aggregate({ where: { organizationId, itemId, locationId: dim.locationId, batchId: dim.batchId, ...(serial !== undefined ? { serial } : {}) }, _sum: { quantity: true } });
  return d(r._sum.quantity?.toString() ?? 0);
}

async function lockedItem(tx: Tx, ctx: Ctx, id: string) {
  await lockItem(tx, ctx.organizationId, id); // serialisiert Buchungen je Artikel (kein negativer Bestand durch Parallelität)
  const item = await tx.item.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!item) throw new NotFoundError("Artikel");
  return item;
}
type ItemRow = Awaited<ReturnType<typeof lockedItem>>;

async function resolveLocation(tx: Tx, ctx: Ctx, id: string | null | undefined, mustBeActive: boolean): Promise<string | null> {
  if (!id) return null;
  const loc = await tx.stockLocation.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!loc) throw new NotFoundError("Lagerort");
  if (mustBeActive && !loc.active) throw new ConflictError(`Der Lagerort ${loc.code} ist deaktiviert`);
  return loc.id;
}

/** Charge zum Artikel: bei Chargenartikeln Pflicht, sonst nicht erlaubt. Beim Wareneingang wird sie bei Bedarf angelegt. */
async function resolveBatch(tx: Tx, ctx: Ctx, item: ItemRow, number: string | null | undefined, create?: { expiresOn?: string | null }): Promise<string | null> {
  if (item.tracking !== "BATCH") {
    if (number) throw new ConflictError("Der Artikel wird nicht chargenweise geführt");
    return null;
  }
  if (!number) throw new ConflictError("Bitte eine Charge angeben");
  const found = await tx.stockBatch.findFirst({ where: { itemId: item.id, number } });
  if (found) return found.id;
  if (!create) throw new NotFoundError("Charge");
  const b = await tx.stockBatch.create({ data: { organizationId: ctx.organizationId, itemId: item.id, number, expiresOn: create.expiresOn ? new Date(`${create.expiresOn}T00:00:00Z`) : null } });
  return b.id;
}

/** Seriennummern prüfen: bei Seriennummernartikeln Pflicht (eindeutig, Anzahl = Menge), sonst nicht erlaubt. */
function checkSerials(item: ItemRow, serials: string[], quantity?: Decimal): string[] {
  if (item.tracking !== "SERIAL") {
    if (serials.length) throw new ConflictError("Der Artikel wird nicht über Seriennummern geführt");
    return [];
  }
  if (serials.length === 0) throw new ConflictError("Bitte Seriennummern angeben");
  if (new Set(serials).size !== serials.length) throw new ConflictError("Seriennummern müssen eindeutig sein");
  if (quantity && !quantity.eq(serials.length)) throw new ConflictError(`Menge (${quantity.toString()}) und Anzahl der Seriennummern (${serials.length}) stimmen nicht überein`);
  return serials;
}

const serialSum = async (tx: Tx, ctx: Ctx, itemId: string, serial: string, locationId?: string | null) =>
  d((await tx.stockMovement.aggregate({ where: { organizationId: ctx.organizationId, itemId, serial, ...(locationId !== undefined ? { locationId } : {}) }, _sum: { quantity: true } }))._sum.quantity?.toString() ?? 0);

/** Meldet „Mindestbestand unterschritten“, wenn eine Bewegung den Bestand erstmals auf oder unter den Mindestbestand bringt. */
async function emitIfBelowReorder(tx: Tx, ctx: Ctx, item: { id: string; number: string; reorderLevel: Prisma.Decimal | null }, before: Decimal, after: Decimal) {
  if (item.reorderLevel === null) return;
  const level = d(item.reorderLevel.toString());
  if (before.gt(level) && after.lte(level)) await emitEvent(tx, ctx, "stock.below_reorder", { itemId: item.id, item: item.number, onHand: after.toString(), reorderLevel: level.toString(), href: `/inventory/${item.id}` });
}

interface Booking { kind: string; quantity: Decimal; dim: Dim; serials: string[]; unitCost?: Decimal | null; costCenterId?: string | null; note?: string | null; goodsReceiptLineId?: string | null; transferId?: string | null; reversesId?: string | null }
/** Schreibt eine Bewegung (bei Seriennummern je Nummer eine Bewegung mit Menge ±1). Gibt alle geschriebenen Bewegungen zurück. */
async function book(tx: Tx, ctx: Ctx, item: ItemRow, b: Booking) {
  const base = { organizationId: ctx.organizationId, itemId: item.id, kind: b.kind, locationId: b.dim.locationId, batchId: b.dim.batchId, unitCost: b.unitCost?.toString() ?? null, costCenterId: b.costCenterId ?? null, note: b.note ?? null, transferId: b.transferId ?? null, createdById: ctx.userId };
  if (b.serials.length === 0) return [await tx.stockMovement.create({ data: { ...base, quantity: b.quantity.toString(), goodsReceiptLineId: b.goodsReceiptLineId ?? null, reversesId: b.reversesId ?? null } })];
  const sign = b.quantity.lt(0) ? -1 : 1;
  const all = [];
  for (const [i, serial] of b.serials.entries()) {
    all.push(await tx.stockMovement.create({ data: { ...base, quantity: String(sign), serial, goodsReceiptLineId: i === 0 ? b.goodsReceiptLineId ?? null : null, reversesId: i === 0 ? b.reversesId ?? null : null } }));
  }
  return all;
}

// ───────────────────────── Lagerorte ─────────────────────────

export async function createLocation(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.manage");
  const input = locationInput.parse(raw);
  return db.$transaction(async (tx) => {
    const created = await tx.stockLocation.create({ data: { organizationId: ctx.organizationId, code: input.code, name: input.name } });
    await writeAudit(tx, ctx, { action: "stock_location.create", entityType: "StockLocation", entityId: created.id, after: { code: input.code } });
    return created;
  });
}

export async function listLocations(ctx: Ctx) {
  authorize(ctx, "inventory.read");
  return db.stockLocation.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ active: "desc" }, { code: "asc" }] });
}

/** Lagerort deaktivieren/aktivieren. Deaktivieren nur ohne Bestand. */
export async function setLocationActive(ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "inventory.manage");
  return db.$transaction(async (tx) => {
    const loc = await tx.stockLocation.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!loc) throw new NotFoundError("Lagerort");
    if (!active) {
      const rows = await tx.stockMovement.groupBy({ by: ["itemId", "batchId"], where: { organizationId: ctx.organizationId, locationId: id }, _sum: { quantity: true } });
      if (rows.some((r) => d(r._sum.quantity?.toString() ?? 0).gt(0))) throw new ConflictError("Der Lagerort hat noch Bestand – zuerst umbuchen");
    }
    await tx.stockLocation.update({ where: { id }, data: { active } });
    await writeAudit(tx, ctx, { action: "stock_location.set_active", entityType: "StockLocation", entityId: id, after: { active } });
  });
}

// ───────────────────────── Artikel ─────────────────────────

export async function createItem(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.manage");
  const input = itemInput.parse(raw);
  return db.$transaction(async (tx) => {
    const created = await tx.item.create({ data: { organizationId: ctx.organizationId, number: input.number, name: input.name, unit: input.unit, reorderLevel: input.reorderLevel?.toString() ?? null, tracking: input.tracking, valuationMethod: input.valuationMethod, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "item.create", entityType: "Item", entityId: created.id, after: { number: input.number, name: input.name, tracking: input.tracking, valuationMethod: input.valuationMethod } });
    return created;
  });
}

/** Name, Mindestbestand und Aktiv-Status ändern. Einheit, Verfolgung und Bewertungsverfahren bleiben fest, sobald es Bewegungen gibt. */
export async function updateItem(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "inventory.manage");
  const input = itemUpdateInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = await lockedItem(tx, ctx, id);
    if (!input.active && item.active && (await stockOf(tx, ctx.organizationId, [id])).get(id)!.gt(0)) throw new ConflictError("Artikel mit Bestand können nicht deaktiviert werden");
    const changesBasis = (input.tracking && input.tracking !== item.tracking) || (input.valuationMethod && input.valuationMethod !== item.valuationMethod);
    if (changesBasis && (await tx.stockMovement.count({ where: { organizationId: ctx.organizationId, itemId: id } })) > 0) throw new ConflictError("Verfolgung und Bewertungsverfahren lassen sich nur ändern, solange es keine Bewegungen gibt");
    await tx.item.update({ where: { id }, data: { name: input.name, reorderLevel: input.reorderLevel?.toString() ?? null, active: input.active, ...(input.tracking ? { tracking: input.tracking } : {}), ...(input.valuationMethod ? { valuationMethod: input.valuationMethod } : {}) } });
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
  const [movements, stock, balances] = await Promise.all([
    db.stockMovement.findMany({ where: { organizationId: ctx.organizationId, itemId: id }, orderBy: { createdAt: "desc" }, take: 200, include: { reversedBy: { select: { id: true } } } }),
    stockOf(db, ctx.organizationId, [id]),
    itemBalances(ctx.organizationId, id),
  ]);
  return { ...item, onHand: stock.get(id)!, balances, movements: movements.map((m) => ({ ...m, reversed: !!m.reversedBy })) };
}

/** Bestand je Lagerort und Charge (nur Positionen ungleich null) sowie – bei Seriennummernartikeln – die vorhandenen Nummern. */
async function itemBalances(organizationId: string, itemId: string) {
  const [rows, locs, batches, serialRows] = await Promise.all([
    db.stockMovement.groupBy({ by: ["locationId", "batchId"], where: { organizationId, itemId }, _sum: { quantity: true } }),
    db.stockLocation.findMany({ where: { organizationId } }),
    db.stockBatch.findMany({ where: { organizationId, itemId } }),
    db.stockMovement.groupBy({ by: ["serial", "locationId"], where: { organizationId, itemId, serial: { not: null } }, _sum: { quantity: true } }),
  ]);
  const lname = new Map(locs.map((l) => [l.id, `${l.code} ${l.name}`]));
  const bnum = new Map(batches.map((b) => [b.id, b]));
  return {
    byPlace: rows.map((r) => ({ locationId: r.locationId, location: r.locationId ? lname.get(r.locationId) ?? "?" : "Ohne Lagerort", batch: r.batchId ? bnum.get(r.batchId)?.number ?? "?" : null, expiresOn: r.batchId ? bnum.get(r.batchId)?.expiresOn ?? null : null, quantity: d(r._sum.quantity?.toString() ?? 0) })).filter((r) => !r.quantity.isZero()),
    serials: serialRows.filter((r) => d(r._sum.quantity?.toString() ?? 0).gt(0)).map((r) => ({ serial: r.serial!, location: r.locationId ? lname.get(r.locationId) ?? "?" : "Ohne Lagerort" })).sort((a, b) => a.serial.localeCompare(b.serial)),
  };
}

// ───────────────────────── Bewertung ─────────────────────────

async function valuedMovements(tx: Tx | typeof db, organizationId: string, item: { id: string; valuationMethod: string }, asOfEnd?: Date) {
  const rows = await tx.stockMovement.findMany({ where: { organizationId, itemId: item.id, ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return valueMovements(item.valuationMethod as ValuationMethod, rows.map((r) => ({ id: r.id, kind: r.kind, quantity: d(r.quantity.toString()), unitCost: r.unitCost ? d(r.unitCost.toString()) : null, reversesId: r.reversesId })));
}

/** Bewertung aller Artikel (zum Stichtag, Standard heute). Werte werden aus dem Journal berechnet. */
export async function valuationReport(ctx: Ctx, asOf?: string) {
  authorize(ctx, "inventory.value.read");
  const end = asOf ? new Date(`${asOf}T23:59:59.999Z`) : undefined;
  if (asOf && Number.isNaN(end!.getTime())) throw new ConflictError("Ungültiges Datum");
  const items = await db.item.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { number: "asc" }, take: 500 });
  const rows = [];
  let total = d(0);
  for (const item of items) {
    const v = await valuedMovements(db, ctx.organizationId, item, end);
    if (v.quantity.isZero() && v.value.isZero()) continue;
    rows.push({ id: item.id, number: item.number, name: item.name, unit: item.unit, method: item.valuationMethod, quantity: v.quantity, value: v.value, averageCost: v.averageCost });
    total = total.plus(v.value);
  }
  return { asOf: asOf ?? new Date().toISOString().slice(0, 10), rows, total };
}

/** Bewertete Bewegungen eines Artikels (für die Artikelseite). */
export async function itemValuation(ctx: Ctx, itemId: string) {
  authorize(ctx, "inventory.value.read");
  const item = await db.item.findFirst({ where: { id: itemId, organizationId: ctx.organizationId } });
  if (!item) throw new NotFoundError("Artikel");
  const v = await valuedMovements(db, ctx.organizationId, item);
  return { byMovement: new Map(v.movements.map((m) => [m.id, m])), quantity: v.quantity, value: v.value, averageCost: v.averageCost };
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
 * Bucht eine Wareneingangsposition ein (Lagerort, Charge bzw. Seriennummern je nach Artikel). Jede Position höchstens einmal.
 * Der Einstandspreis ist der Preis der Bestellposition. Eine Gegenbuchung des Wareneingangs (negative Menge) nimmt Artikel,
 * Lagerort und Charge der ursprünglichen Einbuchung; bei Seriennummernartikeln wird sie über die Entnahme korrigiert.
 */
export async function stockReceiptLine(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  const input = stockReceiptInput.parse(raw);
  return db.$transaction(async (tx) => {
    const line = (await receiptLinesForStock(tx, ctx.organizationId, 1, [input.goodsReceiptLineId]))[0];
    if (!line) throw new NotFoundError("Wareneingangsposition");
    let itemId = input.itemId ?? null;
    let orig: Awaited<ReturnType<typeof tx.stockMovement.findFirst>> = null;
    if (line.quantity.lt(0)) {
      orig = line.reversesLineId ? await tx.stockMovement.findFirst({ where: { organizationId: ctx.organizationId, goodsReceiptLineId: line.reversesLineId } }) : null;
      if (!orig) throw new ConflictError("Der ursprüngliche Wareneingang ist noch nicht eingebucht – die Gegenbuchung hat nichts zu korrigieren");
      itemId = orig.itemId;
    }
    if (!itemId) throw new ConflictError("Bitte einen Artikel wählen");
    const item = await lockedItem(tx, ctx, itemId);
    if (!item.active) throw new ConflictError("Der Artikel ist deaktiviert");
    if (await tx.stockMovement.findFirst({ where: { goodsReceiptLineId: line.id }, select: { id: true } })) throw new ConflictError("Die Position ist bereits eingebucht");

    let dim: Dim, serials: string[] = [];
    if (orig) {
      if (item.tracking === "SERIAL") throw new ConflictError("Seriennummernartikel: den Wareneingang bitte über die Entnahme der betroffenen Seriennummern korrigieren");
      dim = { locationId: orig.locationId, batchId: orig.batchId };
    } else {
      dim = { locationId: await resolveLocation(tx, ctx, input.locationId, true), batchId: await resolveBatch(tx, ctx, item, input.batchNumber, { expiresOn: input.expiresOn }) };
      serials = checkSerials(item, input.serials, line.quantity);
      for (const s of serials) if ((await serialSum(tx, ctx, item.id, s)).gt(0)) throw new ConflictError(`Seriennummer ${s} ist bereits im Bestand`);
    }
    if (item.tracking === "SERIAL" && !line.quantity.isInteger()) throw new ConflictError("Seriennummernartikel: ganze Mengen");
    if (line.quantity.lt(0) && (await balanceAt(tx, ctx.organizationId, item.id, dim)).plus(line.quantity).lt(0)) throw new ConflictError(`Der Bestand würde negativ (vorhanden ${(await balanceAt(tx, ctx.organizationId, item.id, dim)).toString()} ${item.unit})`);
    const m = (await book(tx, ctx, item, { kind: "RECEIPT", quantity: line.quantity, dim, serials, unitCost: line.quantity.gt(0) ? line.unitPrice : null, goodsReceiptLineId: line.id, note: `${line.orderNumber}: ${line.description}` }))[0]!;
    await writeAudit(tx, ctx, { action: "stock.receipt", entityType: "StockMovement", entityId: m.id, after: { item: item.number, quantity: line.quantity.toString(), goodsReceiptLineId: line.id } });
    return m;
  });
}

// ───────────────────────── Entnahme, Umbuchung, Inventur, Korrektur ─────────────────────────

export async function issueStock(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  return db.$transaction(async (tx) => (await issueStockTx(tx, ctx, raw)).movements[0]!);
}

/**
 * Entnahme in der Transaktion des Aufrufers (z. B. Lieferung im Vertrieb). Keine Berechtigungsprüfung – der Aufrufer prüft sein eigenes Recht.
 * Liefert alle geschriebenen Bewegungen (bei Seriennummern eine je Nummer).
 */
export async function issueStockTx(tx: Tx, ctx: Ctx, raw: unknown, opts: { kind?: "ISSUE" | "PRODUCTION_ISSUE" } = {}) {
  const input = issueInput.parse(raw);
  {
    const item = await lockedItem(tx, ctx, input.itemId);
    if (input.costCenterId && !(await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    const serials = checkSerials(item, input.serials, input.quantity);
    const quantity = item.tracking === "SERIAL" ? d(serials.length) : input.quantity;
    if (!quantity) throw new ConflictError("Bitte eine Menge angeben");
    const dim: Dim = { locationId: await resolveLocation(tx, ctx, input.locationId, false), batchId: await resolveBatch(tx, ctx, item, input.batchNumber) };
    if (item.tracking === "SERIAL") {
      for (const s of serials) if (!(await serialSum(tx, ctx, item.id, s, dim.locationId)).eq(1)) throw new ConflictError(`Seriennummer ${s} ist an diesem Lagerort nicht im Bestand`);
    } else {
      const here = await balanceAt(tx, ctx.organizationId, item.id, dim);
      if (here.lt(quantity)) throw new ConflictError(`Nicht genug Bestand: vorhanden ${here.toString()} ${item.unit}, gewünscht ${quantity.toString()}`);
    }
    const onHand = (await stockOf(tx, ctx.organizationId, [item.id])).get(item.id)!;
    const movements = await book(tx, ctx, item, { kind: opts.kind ?? "ISSUE", quantity: quantity.negated(), dim, serials, costCenterId: input.costCenterId, note: input.note });
    await writeAudit(tx, ctx, { action: "stock.issue", entityType: "StockMovement", entityId: movements[0]!.id, after: { item: item.number, quantity: quantity.toString(), costCenterId: input.costCenterId ?? null } });
    await emitIfBelowReorder(tx, ctx, item, onHand, onHand.minus(quantity));
    return { movements };
  }
}

/**
 * Zugang aus der Fertigung in der Transaktion des Aufrufers (Berechtigung prüft der Aufrufer). Einstandspreis = Wert der verbrauchten Komponenten je Stück.
 * Chargen werden bei Bedarf angelegt; bei Seriennummernartikeln sind die Nummern Pflicht (nie doppelt im Bestand).
 */
export async function receiveProductionTx(tx: Tx, ctx: Ctx, raw: { itemId: string; quantity: Decimal; locationId?: string | null; batchNumber?: string | null; expiresOn?: string | null; serials?: string[]; unitCost: Decimal; note?: string }) {
  const item = await lockedItem(tx, ctx, raw.itemId);
  if (!item.active) throw new ConflictError("Der Artikel ist deaktiviert");
  const serials = checkSerials(item, raw.serials ?? [], raw.quantity);
  for (const s of serials) if ((await serialSum(tx, ctx, item.id, s)).gt(0)) throw new ConflictError(`Seriennummer ${s} ist bereits im Bestand`);
  const dim: Dim = { locationId: await resolveLocation(tx, ctx, raw.locationId, true), batchId: await resolveBatch(tx, ctx, item, raw.batchNumber, { expiresOn: raw.expiresOn }) };
  const movements = await book(tx, ctx, item, { kind: "PRODUCTION_RECEIPT", quantity: raw.quantity, dim, serials, unitCost: raw.unitCost, note: raw.note });
  await writeAudit(tx, ctx, { action: "stock.production_receipt", entityType: "StockMovement", entityId: movements[0]!.id, after: { item: item.number, quantity: raw.quantity.toString() } });
  return { movements };
}

/** Wert (Betrag) der genannten Bewegungen eines Artikels nach dem Bewertungsverfahren des Artikels – für die Kalkulation in der Fertigung. */
export async function movementsValueTx(tx: Tx, ctx: Ctx, itemId: string, movementIds: string[]): Promise<Decimal> {
  const item = await tx.item.findFirst({ where: { id: itemId, organizationId: ctx.organizationId } });
  if (!item) throw new NotFoundError("Artikel");
  const v = await valuedMovements(tx, ctx.organizationId, item);
  return v.movements.filter((m) => movementIds.includes(m.id)).reduce((s, m) => s.plus(m.value.abs()), d(0));
}

/** Umbuchung zwischen Lagerorten (Bestand insgesamt und Wert bleiben gleich). Beide Seiten tragen dieselbe Kennung. */
export async function transferStock(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  const input = transferInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = await lockedItem(tx, ctx, input.itemId);
    const from = await resolveLocation(tx, ctx, input.fromLocationId, false);
    const to = await resolveLocation(tx, ctx, input.toLocationId, true);
    if (from === to) throw new ConflictError("Quelle und Ziel sind derselbe Lagerort");
    const serials = checkSerials(item, input.serials, input.quantity);
    const quantity = item.tracking === "SERIAL" ? d(serials.length) : input.quantity;
    if (!quantity) throw new ConflictError("Bitte eine Menge angeben");
    const batchId = await resolveBatch(tx, ctx, item, input.batchNumber);
    if (item.tracking === "SERIAL") {
      for (const s of serials) if (!(await serialSum(tx, ctx, item.id, s, from)).eq(1)) throw new ConflictError(`Seriennummer ${s} ist am Quell-Lagerort nicht im Bestand`);
    } else {
      const here = await balanceAt(tx, ctx.organizationId, item.id, { locationId: from, batchId });
      if (here.lt(quantity)) throw new ConflictError(`Nicht genug Bestand am Quell-Lagerort: vorhanden ${here.toString()} ${item.unit}, gewünscht ${quantity.toString()}`);
    }
    const transferId = randomUUID();
    const out = (await book(tx, ctx, item, { kind: "TRANSFER_OUT", quantity: quantity.negated(), dim: { locationId: from, batchId }, serials, transferId, note: input.note }))[0]!;
    await book(tx, ctx, item, { kind: "TRANSFER_IN", quantity, dim: { locationId: to, batchId }, serials, transferId, note: input.note });
    await writeAudit(tx, ctx, { action: "stock.transfer", entityType: "StockMovement", entityId: out.id, after: { item: item.number, quantity: quantity.toString(), from, to, transferId } });
    return { transferId };
  });
}

/** Inventur: der gezählte Bestand (je Lagerort/Charge) wird als Korrekturbuchung (Differenz) mit Begründung festgehalten. Nicht für Seriennummernartikel. */
export async function adjustStock(ctx: Ctx, raw: unknown) {
  authorize(ctx, "inventory.move");
  const input = adjustInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = await lockedItem(tx, ctx, input.itemId);
    if (item.tracking === "SERIAL") throw new ConflictError("Seriennummernartikel: Inventurdifferenzen über Entnahme bzw. Wareneingang der einzelnen Nummern buchen");
    const dim: Dim = { locationId: await resolveLocation(tx, ctx, input.locationId, false), batchId: await resolveBatch(tx, ctx, item, input.batchNumber) };
    const here = await balanceAt(tx, ctx.organizationId, item.id, dim);
    const diff = input.counted.minus(here);
    if (diff.isZero()) throw new ConflictError("Der gezählte Bestand entspricht dem Buchbestand – nichts zu korrigieren");
    const onHand = (await stockOf(tx, ctx.organizationId, [item.id])).get(item.id)!;
    const m = (await book(tx, ctx, item, { kind: "ADJUST", quantity: diff, dim, serials: [], note: input.reason }))[0]!;
    await writeAudit(tx, ctx, { action: "stock.adjust", entityType: "StockMovement", entityId: m.id, after: { item: item.number, from: here.toString(), to: input.counted.toString(), reason: input.reason } });
    await emitIfBelowReorder(tx, ctx, item, onHand, onHand.plus(diff));
    return m;
  });
}

/** Gegenbuchung zu einer Entnahme oder Korrektur. Einbuchungen aus dem Wareneingang werden in der Beschaffung korrigiert, Umbuchungen durch Gegenumbuchung. */
export async function reverseMovement(ctx: Ctx, movementId: string, reason: string) {
  authorize(ctx, "inventory.move");
  return db.$transaction((tx) => reverseMovementTx(tx, ctx, movementId, reason));
}

/** Gegenbuchung in der Transaktion des Aufrufers (Berechtigung prüft der Aufrufer). */
export async function reverseMovementTx(tx: Tx, ctx: Ctx, movementId: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3) throw new ConflictError("Bitte eine Begründung angeben");
  {
    const m0 = await tx.stockMovement.findFirst({ where: { id: movementId, organizationId: ctx.organizationId } });
    if (!m0) throw new NotFoundError("Bewegung");
    const item = await lockedItem(tx, ctx, m0.itemId);
    const m = await tx.stockMovement.findFirstOrThrow({ where: { id: movementId }, include: { reversedBy: true } });
    if (m.kind === "RECEIPT") throw new ConflictError("Wareneingänge werden in der Beschaffung korrigiert (Gegenbuchung) und danach hier eingebucht");
    if (m.kind === "REVERSAL") throw new ConflictError("Gegenbuchungen können nicht korrigiert werden");
    if (m.kind === "TRANSFER_OUT" || m.kind === "TRANSFER_IN") throw new ConflictError("Umbuchungen werden durch eine Gegenumbuchung korrigiert");
    if (m.reversedBy) throw new ConflictError("Die Bewegung wurde bereits korrigiert");
    const dim: Dim = { locationId: m.locationId, batchId: m.batchId };
    const delta = d(m.quantity.toString()).negated();
    if (m.serial) {
      if (delta.gt(0) && (await serialSum(tx, ctx, item.id, m.serial)).gt(0)) throw new ConflictError(`Seriennummer ${m.serial} ist bereits wieder im Bestand`);
      if (delta.lt(0) && !(await serialSum(tx, ctx, item.id, m.serial, m.locationId)).eq(1)) throw new ConflictError(`Seriennummer ${m.serial} ist nicht mehr an diesem Lagerort`);
    } else {
      const here = await balanceAt(tx, ctx.organizationId, item.id, dim);
      if (here.plus(delta).lt(0)) throw new ConflictError(`Der Bestand würde negativ (vorhanden ${here.toString()} ${item.unit})`);
    }
    const rev = (await book(tx, ctx, item, { kind: "REVERSAL", quantity: delta, dim, serials: m.serial ? [m.serial] : [], reversesId: m.id, costCenterId: m.costCenterId, note: why }))[0]!;
    await writeAudit(tx, ctx, { action: "stock.reverse", entityType: "StockMovement", entityId: rev.id, after: { reverses: m.id, reason: why } });
    return rev;
  }
}

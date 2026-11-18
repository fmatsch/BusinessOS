import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso } from "@/modules/hr/queries";
import { nextSequenceNumber } from "@/modules/finance/service";
import { activeItemsWithStock, itemsByIds, stockOnHand } from "@/modules/inventory/queries";
import { issueStockTx, movementsValueTx, receiveProductionTx, reverseMovementTx } from "@/modules/inventory/service";
import { openDemandByItem } from "@/modules/sales/queries";
import { componentQuantity, explode, findCycle, type BomData } from "./bom";
import { planMrp } from "./mrp";
import { bomInput, confirmInput, productionOrderInput } from "./schema";

type Tx = Prisma.TransactionClient;
const d = (v: Decimal.Value) => new Decimal(v);
const todayIso = () => new Date().toISOString().slice(0, 10);
const lockItem = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
const lockOrder = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "ProductionOrder" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

const toData = (b: { itemId: string; outputQuantity: Prisma.Decimal; lines: { componentItemId: string; quantity: Prisma.Decimal; scrapPercent: Prisma.Decimal }[] }): BomData => ({
  itemId: b.itemId, outputQuantity: d(b.outputQuantity.toString()), lines: b.lines.map((l) => ({ componentItemId: l.componentItemId, quantity: d(l.quantity.toString()), scrapPercent: d(l.scrapPercent.toString()) })),
});

async function activeBoms(tx: Tx, organizationId: string) {
  return (await tx.bom.findMany({ where: { organizationId, status: "ACTIVE" }, include: { lines: true } })).map((b) => ({ id: b.id, version: b.version, data: toData(b) }));
}

/** Prüft, ob die Stückliste zusammen mit allen aktiven einen Zyklus ergibt. */
async function assertNoCycle(tx: Tx, organizationId: string, candidate: BomData) {
  const others = (await activeBoms(tx, organizationId)).map((b) => b.data).filter((b) => b.itemId !== candidate.itemId);
  const cycle = findCycle([...others, candidate]);
  if (cycle) {
    const names = new Map((await itemsByIds(tx, organizationId, cycle)).map((i) => [i.id, i.number]));
    throw new ConflictError(`Die Stückliste würde einen Zyklus bilden: ${cycle.map((c) => names.get(c) ?? c).join(" → ")}`);
  }
}

async function validateBomInput(tx: Tx, ctx: Ctx, input: ReturnType<typeof bomInput.parse>) {
  const ids = [input.itemId, ...input.lines.map((l) => l.componentItemId)];
  const items = await itemsByIds(tx, ctx.organizationId, [...new Set(ids)]);
  if (items.length !== new Set(ids).size) throw new NotFoundError("Artikel");
  if (items.some((i) => !i.active)) throw new ConflictError("Ein Artikel ist deaktiviert");
  if (input.lines.some((l) => l.componentItemId === input.itemId)) throw new ConflictError("Ein Artikel kann nicht Komponente seiner eigenen Stückliste sein");
  if (new Set(input.lines.map((l) => l.componentItemId)).size !== input.lines.length) throw new ConflictError("Jede Komponente darf nur einmal vorkommen");
  await assertNoCycle(tx, ctx.organizationId, { itemId: input.itemId, outputQuantity: input.outputQuantity, lines: input.lines.map((l) => ({ componentItemId: l.componentItemId, quantity: l.quantity, scrapPercent: d(String(l.scrapPercent)) })) });
}

// ───────────────────────── Stücklisten ─────────────────────────

/** Neue Stückliste (Entwurf) – die nächste Version des Artikels. */
export async function createBom(ctx: Ctx, raw: unknown) {
  authorize(ctx, "production.bom.manage");
  const input = bomInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockItem(tx, ctx.organizationId, input.itemId);
    await validateBomInput(tx, ctx, input);
    const version = ((await tx.bom.aggregate({ where: { organizationId: ctx.organizationId, itemId: input.itemId }, _max: { version: true } }))._max.version ?? 0) + 1;
    const created = await tx.bom.create({
      data: {
        organizationId: ctx.organizationId, itemId: input.itemId, version, outputQuantity: input.outputQuantity.toString(), note: input.note ?? null, createdById: ctx.userId,
        lines: { create: input.lines.map((l) => ({ componentItemId: l.componentItemId, quantity: l.quantity.toString(), scrapPercent: new Decimal(String(l.scrapPercent)).toString() })) },
      },
    });
    await writeAudit(tx, ctx, { action: "bom.create", entityType: "Bom", entityId: created.id, after: { itemId: input.itemId, version, lines: input.lines.length } });
    return created;
  });
}

/** Entwurf ersetzen. Aktivierte Stücklisten sind gesperrt (neue Version anlegen). */
export async function updateBom(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "production.bom.manage");
  const input = bomInput.parse(raw);
  return db.$transaction(async (tx) => {
    const bom = await tx.bom.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!bom) throw new NotFoundError("Stückliste");
    if (bom.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können bearbeitet werden – legen Sie eine neue Version an");
    if (input.itemId !== bom.itemId) throw new ConflictError("Der Artikel einer Stückliste lässt sich nicht ändern");
    await validateBomInput(tx, ctx, input);
    await tx.bomLine.deleteMany({ where: { bomId: id } });
    await tx.bom.update({
      where: { id }, data: { outputQuantity: input.outputQuantity.toString(), note: input.note ?? null, lines: { create: input.lines.map((l) => ({ componentItemId: l.componentItemId, quantity: l.quantity.toString(), scrapPercent: new Decimal(String(l.scrapPercent)).toString() })) } },
    });
    await writeAudit(tx, ctx, { action: "bom.update", entityType: "Bom", entityId: id, after: { lines: input.lines.length } });
  });
}

/** Aktivieren: die bisher aktive Version desselben Artikels wird archiviert; danach sind die Zeilen gesperrt. */
export async function activateBom(ctx: Ctx, id: string) {
  authorize(ctx, "production.bom.manage");
  return db.$transaction(async (tx) => {
    const found = await tx.bom.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!found) throw new NotFoundError("Stückliste");
    await lockItem(tx, ctx.organizationId, found.itemId);
    const bom = await tx.bom.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    if (bom.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können aktiviert werden");
    await assertNoCycle(tx, ctx.organizationId, toData(bom));
    const comps = await itemsByIds(tx, ctx.organizationId, bom.lines.map((l) => l.componentItemId));
    if (comps.some((c) => !c.active)) throw new ConflictError("Eine Komponente ist deaktiviert");
    await tx.bom.updateMany({ where: { organizationId: ctx.organizationId, itemId: bom.itemId, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
    await tx.bom.update({ where: { id }, data: { status: "ACTIVE", activatedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "bom.activate", entityType: "Bom", entityId: id, after: { itemId: bom.itemId, version: bom.version } });
  });
}

/** Entwurf löschen. */
export async function deleteBomDraft(ctx: Ctx, id: string) {
  authorize(ctx, "production.bom.manage");
  return db.$transaction(async (tx) => {
    const bom = await tx.bom.findFirst({ where: { id, organizationId: ctx.organizationId, status: "DRAFT" } });
    if (!bom) throw new ConflictError("Nur Entwürfe können gelöscht werden");
    await tx.bomLine.deleteMany({ where: { bomId: id } });
    await tx.bom.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: "bom.delete", entityType: "Bom", entityId: id });
  });
}

export async function listBoms(ctx: Ctx) {
  authorize(ctx, "production.read");
  const boms = await db.bom.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ itemId: "asc" }, { version: "desc" }], include: { _count: { select: { lines: true } } } });
  const items = new Map((await itemsByIds(db, ctx.organizationId, [...new Set(boms.map((b) => b.itemId))])).map((i) => [i.id, i]));
  return boms.map((b) => ({ ...b, item: items.get(b.itemId)! }));
}

/** Stückliste mit Komponenten und der mehrstufigen Auflösung für `explodeQuantity` Stück (Standard: Basismenge). */
export async function getBom(ctx: Ctx, id: string, explodeQuantity?: string) {
  authorize(ctx, "production.read");
  const bom = await db.bom.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!bom) throw new NotFoundError("Stückliste");
  const active = await activeBoms(db, ctx.organizationId);
  const map = new Map(active.map((a) => [a.data.itemId, a.data]));
  map.set(bom.itemId, toData(bom)); // diese Version statt der aktiven
  const qty = explodeQuantity ? d(explodeQuantity) : d(bom.outputQuantity.toString());
  if (!qty.gt(0)) throw new ConflictError("Ungültige Menge");
  let exploded: ReturnType<typeof explode> = [];
  try { exploded = explode(map, bom.itemId, qty); } catch { exploded = []; }
  const ids = [...new Set([bom.itemId, ...bom.lines.map((l) => l.componentItemId), ...exploded.map((e) => e.itemId)])];
  const items = new Map((await itemsByIds(db, ctx.organizationId, ids)).map((i) => [i.id, i]));
  return { ...bom, item: items.get(bom.itemId)!, lines: bom.lines.map((l) => ({ ...l, component: items.get(l.componentItemId)! })), explodeQuantity: qty, exploded: exploded.map((e) => ({ ...e, item: items.get(e.itemId)! })) };
}

// ───────────────────────── Fertigungsaufträge ─────────────────────────

const produced = (confs: { quantity: Prisma.Decimal; reversedAt: Date | null }[]) => confs.filter((c) => !c.reversedAt).reduce((s, c) => s.plus(c.quantity.toString()), d(0));

export async function createProductionOrder(ctx: Ctx, raw: unknown) {
  authorize(ctx, "production.order.manage");
  const input = productionOrderInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = (await itemsByIds(tx, ctx.organizationId, [input.itemId]))[0];
    if (!item) throw new NotFoundError("Artikel");
    if (!item.active) throw new ConflictError("Der Artikel ist deaktiviert");
    const bom = await tx.bom.findFirst({ where: { organizationId: ctx.organizationId, itemId: input.itemId, status: "ACTIVE" } });
    if (!bom) throw new ConflictError("Für den Artikel gibt es keine aktive Stückliste");
    const created = await tx.productionOrder.create({ data: { organizationId: ctx.organizationId, itemId: input.itemId, bomId: bom.id, quantity: input.quantity.toString(), plannedDate: input.plannedDate ? dateFromIso(input.plannedDate) : null, note: input.note ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "production_order.create", entityType: "ProductionOrder", entityId: created.id, after: { itemId: input.itemId, quantity: input.quantity.toString(), bomVersion: bom.version } });
    return created;
  });
}

/** Freigeben vergibt die lückenlose Nummer; ab dann kann zurückgemeldet werden. */
export async function releaseProductionOrder(ctx: Ctx, id: string) {
  authorize(ctx, "production.order.manage");
  return db.$transaction(async (tx) => {
    await lockOrder(tx, ctx.organizationId, id);
    const o = await tx.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!o) throw new NotFoundError("Fertigungsauftrag");
    if (o.status !== "DRAFT") throw new ConflictError("Der Auftrag ist nicht im Entwurf");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "FA", Number(todayIso().slice(0, 4)));
    await tx.productionOrder.update({ where: { id }, data: { status: "RELEASED", number, releasedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "production_order.release", entityType: "ProductionOrder", entityId: id, after: { number } });
    await emitEvent(tx, ctx, "production.order.released", { orderId: id, number, href: `/production/${id}` });
    return { number };
  });
}

/** Stornieren: Entwurf oder freigegebener Auftrag ohne wirksame Rückmeldung. */
export async function cancelProductionOrder(ctx: Ctx, id: string) {
  authorize(ctx, "production.order.manage");
  return db.$transaction(async (tx) => {
    await lockOrder(tx, ctx.organizationId, id);
    const o = await tx.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { confirmations: true } });
    if (!o) throw new NotFoundError("Fertigungsauftrag");
    if (o.status !== "DRAFT" && o.status !== "RELEASED") throw new ConflictError("Der Auftrag kann nicht mehr storniert werden");
    if (produced(o.confirmations).gt(0)) throw new ConflictError("Es gibt Rückmeldungen – bitte zuerst zurücknehmen oder den Auftrag abschließen");
    await tx.productionOrder.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await writeAudit(tx, ctx, { action: "production_order.cancel", entityType: "ProductionOrder", entityId: id });
  });
}

/** Abschließen mit weniger als der geplanten Menge (Rest entfällt). */
export async function completeProductionOrder(ctx: Ctx, id: string) {
  authorize(ctx, "production.order.manage");
  return db.$transaction(async (tx) => {
    await lockOrder(tx, ctx.organizationId, id);
    const o = await tx.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { confirmations: true } });
    if (!o) throw new NotFoundError("Fertigungsauftrag");
    if (o.status !== "RELEASED") throw new ConflictError("Nur freigegebene Aufträge können abgeschlossen werden");
    if (!produced(o.confirmations).gt(0)) throw new ConflictError("Es wurde noch nichts zurückgemeldet – stornieren Sie den Auftrag stattdessen");
    await tx.productionOrder.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "production_order.complete", entityType: "ProductionOrder", entityId: id });
  });
}

export async function listProductionOrders(ctx: Ctx) {
  authorize(ctx, "production.read");
  const orders = await db.productionOrder.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 300, include: { confirmations: { select: { quantity: true, reversedAt: true } } } });
  const items = new Map((await itemsByIds(db, ctx.organizationId, [...new Set(orders.map((o) => o.itemId))])).map((i) => [i.id, i]));
  return orders.map((o) => ({ ...o, item: items.get(o.itemId)!, produced: produced(o.confirmations) }));
}

/** Auftrag mit Rückmeldungen und Materialbedarf für die noch offene Menge samt Bestand (Verfügbarkeit). */
export async function getProductionOrder(ctx: Ctx, id: string) {
  authorize(ctx, "production.read");
  const o = await db.productionOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { confirmations: { orderBy: { createdAt: "asc" } }, bom: { include: { lines: true } } } });
  if (!o) throw new NotFoundError("Fertigungsauftrag");
  const done = produced(o.confirmations);
  const remaining = Decimal.max(0, d(o.quantity.toString()).minus(done));
  const ids = [o.itemId, ...o.bom.lines.map((l) => l.componentItemId)];
  const [items, stock] = await Promise.all([itemsByIds(db, ctx.organizationId, ids), stockOnHand(db, ctx.organizationId, ids)]);
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const outputQuantity = d(o.bom.outputQuantity.toString());
  const requirements = o.bom.lines.map((l) => {
    const need = componentQuantity({ componentItemId: l.componentItemId, quantity: d(l.quantity.toString()), scrapPercent: d(l.scrapPercent.toString()) }, outputQuantity, remaining);
    const onHand = stock.get(l.componentItemId) ?? d(0);
    return { componentItemId: l.componentItemId, item: itemBy.get(l.componentItemId)!, needed: need, onHand, short: Decimal.max(0, need.minus(onHand)) };
  });
  return { ...o, item: itemBy.get(o.itemId)!, produced: done, remaining, requirements };
}

// ───────────────────────── Rückmeldung ─────────────────────────

/**
 * Rückmeldung: verbraucht die Komponenten (Lagerort der Entnahme) und bucht das Endprodukt (Lagerort, Charge bzw. Seriennummern) in einer Transaktion.
 * Der Einstandspreis des Endprodukts ist der Wert der verbrauchten Komponenten je Stück (nach dem Bewertungsverfahren der Komponenten).
 * Komponenten mit Chargen- oder Seriennummernführung werden noch nicht unterstützt.
 */
export async function confirmProduction(ctx: Ctx, raw: unknown) {
  authorize(ctx, "production.confirm");
  const input = confirmInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockOrder(tx, ctx.organizationId, input.orderId);
    const o = await tx.productionOrder.findFirst({ where: { id: input.orderId, organizationId: ctx.organizationId }, include: { confirmations: true, bom: { include: { lines: true } } } });
    if (!o) throw new NotFoundError("Fertigungsauftrag");
    if (o.status !== "RELEASED") throw new ConflictError("Zurückgemeldet wird nur gegen freigegebene Aufträge");
    const remaining = d(o.quantity.toString()).minus(produced(o.confirmations));
    if (input.quantity.gt(remaining)) throw new ConflictError(`Es sind nur noch ${remaining.toString()} offen (gewünscht ${input.quantity.toString()})`);
    const comps = await itemsByIds(tx, ctx.organizationId, o.bom.lines.map((l) => l.componentItemId));
    if (comps.some((c) => c.tracking !== "NONE")) throw new ConflictError("Komponenten mit Chargen- oder Seriennummernführung werden in der Fertigung noch nicht unterstützt");
    const outputQuantity = d(o.bom.outputQuantity.toString());
    const movementIds: string[] = [];
    let totalValue = d(0);
    for (const l of o.bom.lines) {
      const need = componentQuantity({ componentItemId: l.componentItemId, quantity: d(l.quantity.toString()), scrapPercent: d(l.scrapPercent.toString()) }, outputQuantity, input.quantity);
      const r = await issueStockTx(tx, ctx, { itemId: l.componentItemId, quantity: need.toString(), locationId: input.componentLocationId, note: `Fertigungsauftrag ${o.number}` }, { kind: "PRODUCTION_ISSUE" });
      const ids = r.movements.map((m) => m.id);
      movementIds.push(...ids);
      totalValue = totalValue.plus(await movementsValueTx(tx, ctx, l.componentItemId, ids));
    }
    const unitCost = totalValue.div(input.quantity).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
    const out = await receiveProductionTx(tx, ctx, { itemId: o.itemId, quantity: input.quantity, locationId: input.outputLocationId, batchNumber: input.batchNumber, expiresOn: input.expiresOn, serials: input.serials, unitCost, note: `Fertigungsauftrag ${o.number}` });
    movementIds.push(...out.movements.map((m) => m.id));
    const conf = await tx.productionConfirmation.create({
      data: {
        organizationId: ctx.organizationId, orderId: o.id, quantity: input.quantity.toString(), componentLocationId: input.componentLocationId ?? null, outputLocationId: input.outputLocationId ?? null,
        batchNumber: input.batchNumber ?? null, serials: input.serials.length ? input.serials.join("\n") : null, movementIds, createdById: ctx.userId,
      },
    });
    if (input.quantity.gte(remaining)) await tx.productionOrder.update({ where: { id: o.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "production.confirm", entityType: "ProductionConfirmation", entityId: conf.id, after: { order: o.number, quantity: input.quantity.toString(), unitCost: unitCost.toString() } });
    await emitEvent(tx, ctx, "production.confirmed", { orderId: o.id, order: o.number ?? "", quantity: input.quantity.toString(), href: `/production/${o.id}` });
    return { confirmationId: conf.id, unitCost };
  });
}

/** Rücknahme einer Rückmeldung: alle Lagerbewegungen werden per Gegenbuchung zurückgenommen (Endprodukt zuerst). Schlägt fehl, wenn das Endprodukt schon verbraucht/geliefert wurde. */
export async function reverseConfirmation(ctx: Ctx, confirmationId: string, reason: string) {
  authorize(ctx, "production.confirm");
  const why = reason.trim();
  if (why.length < 3) throw new ConflictError("Bitte eine Begründung angeben");
  return db.$transaction(async (tx) => {
    const found = await tx.productionConfirmation.findFirst({ where: { id: confirmationId, organizationId: ctx.organizationId } });
    if (!found) throw new NotFoundError("Rückmeldung");
    await lockOrder(tx, ctx.organizationId, found.orderId);
    const conf = await tx.productionConfirmation.findUniqueOrThrow({ where: { id: confirmationId }, include: { order: true } });
    if (conf.reversedAt) throw new ConflictError("Die Rückmeldung wurde bereits zurückgenommen");
    for (const mid of [...conf.movementIds].reverse()) await reverseMovementTx(tx, ctx, mid, `Rücknahme Fertigungsauftrag ${conf.order.number}: ${why}`);
    await tx.productionConfirmation.update({ where: { id: confirmationId }, data: { reversedAt: new Date(), reversedById: ctx.userId, reverseReason: why } });
    if (conf.order.status === "COMPLETED") await tx.productionOrder.update({ where: { id: conf.orderId }, data: { status: "RELEASED", completedAt: null } });
    await writeAudit(tx, ctx, { action: "production.reverse", entityType: "ProductionConfirmation", entityId: confirmationId, after: { reason: why } });
  });
}

// ───────────────────────── Bedarfsplanung ─────────────────────────

/** Bedarfsplanung auf Abruf: Nettobedarf aus bestätigten Kundenaufträgen, Bestand, geplanten Fertigungszugängen und Mindestbestand. Bucht nichts. */
export async function runMrp(ctx: Ctx) {
  authorize(ctx, "production.read");
  const [items, demand, boms, released] = await Promise.all([
    activeItemsWithStock(db, ctx.organizationId),
    openDemandByItem(db, ctx.organizationId),
    activeBoms(db, ctx.organizationId),
    db.productionOrder.findMany({ where: { organizationId: ctx.organizationId, status: "RELEASED" }, include: { confirmations: { select: { quantity: true, reversedAt: true } } } }),
  ]);
  const planned = new Map<string, Decimal>();
  for (const o of released) planned.set(o.itemId, (planned.get(o.itemId) ?? d(0)).plus(Decimal.max(0, d(o.quantity.toString()).minus(produced(o.confirmations)))));
  try {
    const suggestions = planMrp({ items: items.map((i) => ({ ...i, plannedReceipts: planned.get(i.id) ?? d(0) })), demand, boms: boms.map((b) => b.data) });
    return { suggestions, error: null as string | null };
  } catch (e) {
    return { suggestions: [], error: e instanceof Error ? e.message : "Planung nicht möglich" };
  }
}

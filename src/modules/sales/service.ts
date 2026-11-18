import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso } from "@/modules/hr/queries";
import { createCustomerInvoiceDraftTx, nextSequenceNumber } from "@/modules/finance/service";
import { crmCustomer, crmCustomers, taxRatesById } from "@/modules/finance/queries";
import { itemsByIds } from "@/modules/inventory/queries";
import { issueStockTx, reverseMovementTx } from "@/modules/inventory/service";
import { billingLines, isOrderDone, openQuantities, overDelivery } from "./delivery";
import { deliveryInput, orderInput, shipInput } from "./schema";

type Tx = Prisma.TransactionClient;
const d = (v: Decimal.Value) => new Decimal(v);
const todayIso = () => new Date().toISOString().slice(0, 10);
const lockOrder = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

async function loadOrder(tx: Tx, ctx: Ctx, id: string) {
  await lockOrder(tx, ctx.organizationId, id); // serialisiert Lieferungen und Abrechnung je Auftrag
  const order = await tx.salesOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: { orderBy: { position: "asc" } } } });
  if (!order) throw new NotFoundError("Auftrag");
  return order;
}

/** Je Auftragsposition: Summe der Lieferzeilen (versandt bzw. versandt+Entwurf) und der abgerechneten Zeilen. */
async function quantities(tx: Tx, orderId: string, excludeDeliveryId?: string) {
  const rows = await tx.deliveryLine.findMany({ where: { delivery: { orderId, status: { in: ["DRAFT", "SHIPPED"] }, ...(excludeDeliveryId ? { id: { not: excludeDeliveryId } } : {}) } }, select: { orderLineId: true, quantity: true, invoiceId: true, delivery: { select: { status: true } } } });
  const committed = new Map<string, Decimal>(), shipped = new Map<string, Decimal>(), billed = new Map<string, Decimal>();
  const add = (m: Map<string, Decimal>, k: string, v: Decimal) => m.set(k, (m.get(k) ?? d(0)).plus(v));
  for (const r of rows) {
    const q = d(r.quantity.toString());
    add(committed, r.orderLineId, q);
    if (r.delivery.status === "SHIPPED") { add(shipped, r.orderLineId, q); if (r.invoiceId) add(billed, r.orderLineId, q); }
  }
  return { committed, shipped, billed };
}

/** Auftrag auf „erledigt“ setzen bzw. zurück auf „bestätigt“, je nach Liefer- und Abrechnungsstand. */
async function syncClosed(tx: Tx, orderId: string) {
  const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
  if (order.status !== "CONFIRMED" && order.status !== "CLOSED") return;
  const { shipped, billed } = await quantities(tx, orderId);
  const done = isOrderDone(order.lines.map((l) => ({ id: l.id, quantity: d(l.quantity.toString()) })), shipped, billed);
  const next = done ? "CLOSED" : "CONFIRMED";
  if (next !== order.status) await tx.salesOrder.update({ where: { id: orderId }, data: { status: next } });
}

async function validateOrderInput(tx: Tx, ctx: Ctx, input: ReturnType<typeof orderInput.parse>) {
  const customer = await crmCustomer(tx, ctx.organizationId, input.customerId);
  if (!customer || !customer.active) throw new NotFoundError("Kunde");
  const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter((x): x is string => !!x))];
  const items = await itemsByIds(tx, ctx.organizationId, itemIds);
  if (items.length !== itemIds.length) throw new NotFoundError("Artikel");
  if (items.some((i) => !i.active)) throw new ConflictError("Ein Artikel ist deaktiviert");
  const rates = await taxRatesById(tx, ctx.organizationId, input.lines.map((l) => l.taxCodeId));
  if (input.lines.some((l) => !rates.has(l.taxCodeId))) throw new NotFoundError("Steuerkennzeichen");
}

// ───────────────────────── Aufträge ─────────────────────────

export async function createOrder(ctx: Ctx, raw: unknown) {
  authorize(ctx, "sales.order.manage");
  const input = orderInput.parse(raw);
  return db.$transaction(async (tx) => {
    await validateOrderInput(tx, ctx, input);
    const created = await tx.salesOrder.create({
      data: {
        organizationId: ctx.organizationId, customerId: input.customerId, reference: input.reference ?? null, orderDate: dateFromIso(input.orderDate), note: input.note ?? null, createdById: ctx.userId,
        lines: { create: input.lines.map((l, i) => ({ position: i + 1, itemId: l.itemId ?? null, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "sales_order.create", entityType: "SalesOrder", entityId: created.id, after: { customerId: input.customerId, lines: input.lines.length } });
    return created;
  });
}

/** Entwurf ersetzen (Kopf und Positionen). Bestätigte Aufträge sind gesperrt. */
export async function updateOrder(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "sales.order.manage");
  const input = orderInput.parse(raw);
  return db.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, id);
    if (order.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können bearbeitet werden");
    await validateOrderInput(tx, ctx, input);
    await tx.salesOrderLine.deleteMany({ where: { orderId: id } });
    await tx.salesOrder.update({
      where: { id }, data: {
        customerId: input.customerId, reference: input.reference ?? null, orderDate: dateFromIso(input.orderDate), note: input.note ?? null,
        lines: { create: input.lines.map((l, i) => ({ position: i + 1, itemId: l.itemId ?? null, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "sales_order.update", entityType: "SalesOrder", entityId: id, after: { lines: input.lines.length } });
  });
}

/** Bestätigen vergibt die lückenlose Nummer; danach sind die Positionen gesperrt. */
export async function confirmOrder(ctx: Ctx, id: string) {
  authorize(ctx, "sales.order.manage");
  return db.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, id);
    if (order.status !== "DRAFT") throw new ConflictError("Der Auftrag ist bereits bestätigt");
    const customer = await crmCustomer(tx, ctx.organizationId, order.customerId);
    if (!customer?.active) throw new ConflictError("Der Kunde ist nicht mehr aktiv");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "SO", Number(todayIso().slice(0, 4)));
    await tx.salesOrder.update({ where: { id }, data: { status: "CONFIRMED", number, confirmedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "sales_order.confirm", entityType: "SalesOrder", entityId: id, after: { number } });
    await emitEvent(tx, ctx, "sales.order.confirmed", { orderId: id, number, href: `/sales/${id}` });
    return { number };
  });
}

/** Stornieren: Entwurf oder bestätigter Auftrag ohne (nicht stornierte) Lieferung. */
export async function cancelOrder(ctx: Ctx, id: string) {
  authorize(ctx, "sales.order.manage");
  return db.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, id);
    if (order.status === "CANCELLED" || order.status === "CLOSED") throw new ConflictError("Der Auftrag kann nicht mehr storniert werden");
    if ((await tx.delivery.count({ where: { orderId: id, status: { not: "CANCELLED" } } })) > 0) throw new ConflictError("Es gibt Lieferungen – bitte zuerst stornieren bzw. verwerfen");
    await tx.salesOrder.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await writeAudit(tx, ctx, { action: "sales_order.cancel", entityType: "SalesOrder", entityId: id });
  });
}

export async function listOrders(ctx: Ctx) {
  authorize(ctx, "sales.order.read");
  const orders = await db.salesOrder.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 300, include: { lines: { select: { quantity: true, unitPrice: true } } } });
  const customers = new Map((await crmCustomers(db, ctx.organizationId)).map((c) => [c.id, c.name]));
  return orders.map((o) => ({ ...o, customerName: customers.get(o.customerId) ?? "–", net: o.lines.reduce((s, l) => s.plus(d(l.quantity.toString()).times(l.unitPrice.toString())), d(0)) }));
}

export async function getOrder(ctx: Ctx, id: string) {
  authorize(ctx, "sales.order.read");
  const order = await db.salesOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: { orderBy: { position: "asc" } }, deliveries: { orderBy: { createdAt: "asc" }, include: { lines: true } } } });
  if (!order) throw new NotFoundError("Auftrag");
  const [customer, items, q] = await Promise.all([crmCustomer(db, ctx.organizationId, order.customerId), itemsByIds(db, ctx.organizationId, order.lines.map((l) => l.itemId).filter((x): x is string => !!x)), quantities(db, id)]);
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const open = openQuantities(order.lines.map((l) => ({ id: l.id, quantity: d(l.quantity.toString()) })), q.committed);
  return {
    ...order, customerName: customer?.name ?? "–",
    lines: order.lines.map((l) => ({ ...l, item: l.itemId ? itemBy.get(l.itemId) ?? null : null, shipped: q.shipped.get(l.id) ?? d(0), billed: q.billed.get(l.id) ?? d(0), open: open.find((o) => o.id === l.id)!.open })),
  };
}

// ───────────────────────── Lieferungen ─────────────────────────

/** Lieferung als Entwurf anlegen (plant Mengen ein; gebucht wird erst beim Versand). */
export async function createDelivery(ctx: Ctx, raw: unknown) {
  authorize(ctx, "sales.delivery.manage");
  const input = deliveryInput.parse(raw);
  return db.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, input.orderId);
    if (order.status !== "CONFIRMED") throw new ConflictError("Geliefert wird nur gegen bestätigte, offene Aufträge");
    const q = await quantities(tx, order.id);
    const problem = overDelivery(openQuantities(order.lines.map((l) => ({ id: l.id, quantity: d(l.quantity.toString()) })), q.committed), input.lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })));
    if (problem) throw new ConflictError(problem);
    for (const l of input.lines) if (!order.lines.find((x) => x.id === l.orderLineId)?.itemId && (l.locationId || l.batchNumber || l.serials)) throw new ConflictError("Leistungspositionen haben keinen Lagerort, keine Charge und keine Seriennummern");
    const created = await tx.delivery.create({
      data: {
        organizationId: ctx.organizationId, orderId: order.id, carrier: input.carrier ?? null, trackingNumber: input.trackingNumber ?? null, note: input.note ?? null, createdById: ctx.userId,
        lines: { create: input.lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity.toString(), locationId: l.locationId ?? null, batchNumber: l.batchNumber ?? null, serials: l.serials ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "delivery.create", entityType: "Delivery", entityId: created.id, after: { orderId: order.id, lines: input.lines.length } });
    return created;
  });
}

/** Entwurf einer Lieferung verwerfen. */
export async function discardDelivery(ctx: Ctx, id: string) {
  authorize(ctx, "sales.delivery.manage");
  return db.$transaction(async (tx) => {
    const del = await tx.delivery.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!del) throw new NotFoundError("Lieferung");
    await lockOrder(tx, ctx.organizationId, del.orderId);
    if (del.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können verworfen werden");
    await tx.deliveryLine.deleteMany({ where: { deliveryId: id } });
    await tx.delivery.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: "delivery.discard", entityType: "Delivery", entityId: id });
  });
}

/**
 * Versand: bucht die Warenentnahmen (Lagerort, Charge, Seriennummern) in derselben Transaktion, vergibt die lückenlose Lieferscheinnummer
 * und hält Spediteur/Sendungsnummer fest. Schlägt eine Entnahme fehl (z. B. zu wenig Bestand), geschieht nichts.
 */
export async function shipDelivery(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "sales.delivery.manage");
  const input = shipInput.parse(raw);
  return db.$transaction(async (tx) => {
    const found = await tx.delivery.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!found) throw new NotFoundError("Lieferung");
    const order = await loadOrder(tx, ctx, found.orderId);
    const del = await tx.delivery.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    if (del.status !== "DRAFT") throw new ConflictError("Die Lieferung ist nicht im Entwurf");
    if (order.status !== "CONFIRMED") throw new ConflictError("Der Auftrag ist nicht offen");
    const q = await quantities(tx, order.id, id);
    const problem = overDelivery(openQuantities(order.lines.map((l) => ({ id: l.id, quantity: d(l.quantity.toString()) })), q.committed), del.lines.map((l) => ({ orderLineId: l.orderLineId, quantity: d(l.quantity.toString()) })));
    if (problem) throw new ConflictError(problem);
    const number = await nextSequenceNumber(tx, ctx.organizationId, "LS", Number(input.shippedOn.slice(0, 4)));
    for (const line of del.lines) {
      const ol = order.lines.find((x) => x.id === line.orderLineId)!;
      let movementIds: string[] = [];
      if (ol.itemId) {
        const r = await issueStockTx(tx, ctx, { itemId: ol.itemId, quantity: line.quantity.toString(), locationId: line.locationId, batchNumber: line.batchNumber, serials: line.serials ?? undefined, note: `Lieferung ${number}` });
        movementIds = r.movements.map((m) => m.id);
      }
      await tx.deliveryLine.update({ where: { id: line.id }, data: { movementIds } });
    }
    await tx.delivery.update({ where: { id }, data: { status: "SHIPPED", number, shippedOn: dateFromIso(input.shippedOn), shippedAt: new Date(), carrier: input.carrier ?? del.carrier, trackingNumber: input.trackingNumber ?? del.trackingNumber } });
    await writeAudit(tx, ctx, { action: "delivery.ship", entityType: "Delivery", entityId: id, after: { number, orderId: order.id } });
    await emitEvent(tx, ctx, "sales.delivery.shipped", { deliveryId: id, number, order: order.number ?? "", href: `/sales/${order.id}` });
    return { number };
  });
}

/** Storno einer versandten, noch nicht abgerechneten Lieferung: die Lagerbewegungen werden per Gegenbuchung zurückgenommen. */
export async function cancelDelivery(ctx: Ctx, id: string, reason: string) {
  authorize(ctx, "sales.delivery.manage");
  const why = reason.trim();
  if (why.length < 3) throw new ConflictError("Bitte eine Begründung angeben");
  return db.$transaction(async (tx) => {
    const found = await tx.delivery.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!found) throw new NotFoundError("Lieferung");
    await loadOrder(tx, ctx, found.orderId);
    const del = await tx.delivery.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    if (del.status !== "SHIPPED") throw new ConflictError("Nur versandte Lieferungen können storniert werden");
    if (del.lines.some((l) => l.invoiceId)) throw new ConflictError("Die Lieferung ist bereits abgerechnet – bitte per Gutschrift korrigieren");
    for (const l of del.lines) for (const mid of l.movementIds) await reverseMovementTx(tx, ctx, mid, `Storno Lieferung ${del.number}: ${why}`);
    await tx.delivery.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: why } });
    await syncClosed(tx, del.orderId);
    await writeAudit(tx, ctx, { action: "delivery.cancel", entityType: "Delivery", entityId: id, after: { number: del.number, reason: why } });
  });
}

// ───────────────────────── Abrechnung ─────────────────────────

/** Rechnungsentwurf aus allen gelieferten, noch nicht abgerechneten Mengen. Jede Lieferzeile wird höchstens einmal abgerechnet. */
export async function billOrder(ctx: Ctx, orderId: string) {
  authorize(ctx, "sales.bill");
  return db.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, orderId);
    if (order.status !== "CONFIRMED" && order.status !== "CLOSED") throw new ConflictError("Der Auftrag ist nicht bestätigt");
    const unbilled = await tx.deliveryLine.findMany({ where: { delivery: { orderId, status: "SHIPPED" }, invoiceId: null }, select: { id: true, orderLineId: true, quantity: true, delivery: { select: { number: true } } } });
    const lines = billingLines(order.lines.map((l) => ({ id: l.id, description: l.description, unitPrice: d(l.unitPrice.toString()), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId })), unbilled.map((u) => ({ orderLineId: u.orderLineId, quantity: d(u.quantity.toString()) })));
    if (lines.length === 0) throw new ConflictError("Es gibt keine gelieferten, noch nicht abgerechneten Mengen");
    const numbers = [...new Set(unbilled.map((u) => u.delivery.number).filter(Boolean))].join(", ");
    const inv = await createCustomerInvoiceDraftTx(tx, ctx, {
      customerId: order.customerId, invoiceDate: todayIso(), note: `Auftrag ${order.number}${order.reference ? ` (${order.reference})` : ""}: Lieferung ${numbers}`,
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId ?? undefined })),
    });
    await tx.deliveryLine.updateMany({ where: { id: { in: unbilled.map((u) => u.id) } }, data: { invoiceId: inv.id } });
    await syncClosed(tx, orderId);
    await writeAudit(tx, ctx, { action: "sales_order.bill", entityType: "SalesOrder", entityId: orderId, after: { invoiceId: inv.id, lines: lines.length } });
    return { invoiceId: inv.id };
  });
}

// ───────────────────────── Lieferschein ─────────────────────────

/** Daten für den druckbaren Lieferschein (ohne Preise). */
export async function getDeliveryNote(ctx: Ctx, id: string) {
  authorize(ctx, "sales.order.read");
  const del = await db.delivery.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true, order: { include: { lines: true } } } });
  if (!del) throw new NotFoundError("Lieferung");
  const [customer, items] = await Promise.all([crmCustomer(db, ctx.organizationId, del.order.customerId), itemsByIds(db, ctx.organizationId, del.order.lines.map((l) => l.itemId).filter((x): x is string => !!x))]);
  const itemBy = new Map(items.map((i) => [i.id, i]));
  return {
    ...del, customer,
    rows: del.lines.map((l) => {
      const ol = del.order.lines.find((x) => x.id === l.orderLineId)!;
      const item = ol.itemId ? itemBy.get(ol.itemId) : undefined;
      return { id: l.id, position: ol.position, description: ol.description, itemNumber: item?.number ?? null, unit: item?.unit ?? "", quantity: d(l.quantity.toString()), batchNumber: l.batchNumber, serials: l.serials };
    }).sort((a, b) => a.position - b.position),
  };
}

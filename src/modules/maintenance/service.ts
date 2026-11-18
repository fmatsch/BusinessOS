import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, isoFromDate } from "@/modules/hr/queries";
import { nextSequenceNumber } from "@/modules/finance/service";
import { itemsByIds } from "@/modules/inventory/queries";
import { issueStockTx } from "@/modules/inventory/service";
import { fixedAssetsByIds } from "@/modules/gl/queries";
import { daysUntil, nextDue, type IntervalUnit } from "./rules";
import { completeInput, objectInput, planInput, reportInput } from "./schema";

type Tx = Prisma.TransactionClient;
const year = () => Number(new Date().toISOString().slice(0, 4));
const todayIso = () => new Date().toISOString().slice(0, 10);
const lockOrder = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "MaintenanceOrder" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

// ───────────────────────── Objekte ─────────────────────────

export async function createMaintenanceObject(ctx: Ctx, raw: unknown) {
  authorize(ctx, "maint.manage");
  const input = objectInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (input.fixedAssetId && !(await fixedAssetsByIds(tx, ctx.organizationId, [input.fixedAssetId])).length) throw new NotFoundError("Anlagegut");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "EQ", year());
    const created = await tx.maintenanceObject.create({ data: { organizationId: ctx.organizationId, number, name: input.name, location: input.location ?? null, fixedAssetId: input.fixedAssetId ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "maintenance_object.create", entityType: "MaintenanceObject", entityId: created.id, after: { number, name: input.name } });
    return created;
  });
}

export async function setMaintenanceObjectActive(ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "maint.manage");
  return db.$transaction(async (tx) => {
    const r = await tx.maintenanceObject.updateMany({ where: { id, organizationId: ctx.organizationId }, data: { active } });
    if (r.count !== 1) throw new NotFoundError("Objekt");
    await writeAudit(tx, ctx, { action: "maintenance_object.set_active", entityType: "MaintenanceObject", entityId: id, after: { active } });
  });
}

/** Objekte (auch für Störungsmeldungen: Berechtigung `maint.read` oder `maint.report`). */
export async function listMaintenanceObjects(ctx: Ctx) {
  if (!ctx.permissions.has("maint.read")) authorize(ctx, "maint.report");
  return db.maintenanceObject.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ active: "desc" }, { number: "asc" }], select: { id: true, number: true, name: true, location: true, active: true, fixedAssetId: true } });
}

// ───────────────────────── Wartungspläne ─────────────────────────

export async function createMaintenancePlan(ctx: Ctx, raw: unknown) {
  authorize(ctx, "maint.manage");
  const input = planInput.parse(raw);
  return db.$transaction(async (tx) => {
    const obj = await tx.maintenanceObject.findFirst({ where: { id: input.objectId, organizationId: ctx.organizationId, active: true } });
    if (!obj) throw new NotFoundError("Objekt");
    const created = await tx.maintenancePlan.create({ data: { organizationId: ctx.organizationId, objectId: obj.id, title: input.title, instructions: input.instructions ?? null, intervalUnit: input.intervalUnit, intervalValue: input.intervalValue, nextDueOn: dateFromIso(input.firstDueOn), createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "maintenance_plan.create", entityType: "MaintenancePlan", entityId: created.id, after: { object: obj.number, title: input.title } });
    return created;
  });
}

export async function setMaintenancePlanActive(ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "maint.manage");
  return db.$transaction(async (tx) => {
    const r = await tx.maintenancePlan.updateMany({ where: { id, organizationId: ctx.organizationId }, data: { active } });
    if (r.count !== 1) throw new NotFoundError("Wartungsplan");
    await writeAudit(tx, ctx, { action: "maintenance_plan.set_active", entityType: "MaintenancePlan", entityId: id, after: { active } });
  });
}

export async function listMaintenancePlans(ctx: Ctx) {
  authorize(ctx, "maint.read");
  const plans = await db.maintenancePlan.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { nextDueOn: "asc" }, include: { object: { select: { number: true, name: true, active: true } } } });
  const today = todayIso();
  return plans.map((p) => ({ ...p, daysUntilDue: daysUntil(isoFromDate(p.nextDueOn), today) }));
}

/**
 * Erzeugt für alle aktiven Wartungspläne, die bis `until` (Standard heute) fällig sind, einen vorbeugenden Auftrag.
 * Je Plan höchstens ein offener Auftrag (auch per Datenbankindex), daher beliebig oft aufrufbar.
 */
export async function generateDueOrders(ctx: Ctx, until?: string) {
  authorize(ctx, "maint.manage");
  const limit = until ?? todayIso();
  if (Number.isNaN(Date.parse(`${limit}T00:00:00Z`))) throw new ConflictError("Ungültiges Datum");
  return db.$transaction(async (tx) => {
    const plans = await tx.maintenancePlan.findMany({ where: { organizationId: ctx.organizationId, active: true, nextDueOn: { lte: dateFromIso(limit) }, object: { active: true }, orders: { none: { status: { in: ["OPEN", "IN_PROGRESS"] } } } }, include: { object: true }, orderBy: { nextDueOn: "asc" } });
    const created: string[] = [];
    for (const p of plans) {
      const number = await nextSequenceNumber(tx, ctx.organizationId, "IH", year());
      await tx.maintenanceOrder.create({ data: { organizationId: ctx.organizationId, number, objectId: p.objectId, planId: p.id, kind: "PREVENTIVE", title: `${p.title} (${p.object.number})`, description: p.instructions, priority: "NORMAL", dueOn: p.nextDueOn, reportedById: ctx.userId } });
      created.push(number);
    }
    await writeAudit(tx, ctx, { action: "maintenance_order.generate", entityType: "MaintenanceOrder", entityId: ctx.organizationId, after: { until: limit, created: created.length } });
    return { created };
  });
}

// ───────────────────────── Aufträge ─────────────────────────

/** Störung melden (Berechtigung `maint.report`, auch Mitarbeiter): legt einen Auftrag an. */
export async function reportIssue(ctx: Ctx, raw: unknown) {
  authorize(ctx, "maint.report");
  const input = reportInput.parse(raw);
  return db.$transaction(async (tx) => {
    const obj = await tx.maintenanceObject.findFirst({ where: { id: input.objectId, organizationId: ctx.organizationId, active: true } });
    if (!obj) throw new NotFoundError("Objekt");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "IH", year());
    const created = await tx.maintenanceOrder.create({ data: { organizationId: ctx.organizationId, number, objectId: obj.id, kind: "CORRECTIVE", title: input.title, description: input.description ?? null, priority: input.priority, reportedById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "maintenance_order.report", entityType: "MaintenanceOrder", entityId: created.id, after: { number, object: obj.number, priority: input.priority } });
    await emitEvent(tx, ctx, "maintenance.order.reported", { orderId: created.id, number, priority: input.priority, href: `/maintenance/${created.id}` });
    return { id: created.id, number };
  });
}

export async function startMaintenanceOrder(ctx: Ctx, id: string) {
  authorize(ctx, "maint.work");
  return db.$transaction(async (tx) => {
    const r = await tx.maintenanceOrder.updateMany({ where: { id, organizationId: ctx.organizationId, status: "OPEN" }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("Nur offene Aufträge können begonnen werden");
    await writeAudit(tx, ctx, { action: "maintenance_order.start", entityType: "MaintenanceOrder", entityId: id });
  });
}

/**
 * Abschluss mit Bericht, Zeitaufwand und verbrauchten Ersatzteilen (Lagerentnahme in derselben Transaktion – schlägt eine fehl, geschieht nichts).
 * Bei Wartungsplänen rückt die Fälligkeit ab dem Erledigungsdatum weiter. Danach ist der Auftrag unveränderlich.
 */
export async function completeMaintenanceOrder(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "maint.work");
  const input = completeInput.parse(raw);
  if (input.doneOn > todayIso()) throw new ConflictError("Das Erledigungsdatum liegt in der Zukunft");
  return db.$transaction(async (tx) => {
    await lockOrder(tx, ctx.organizationId, id);
    const o = await tx.maintenanceOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { plan: true } });
    if (!o) throw new NotFoundError("Instandhaltungsauftrag");
    if (o.status !== "OPEN" && o.status !== "IN_PROGRESS") throw new ConflictError("Der Auftrag ist bereits abgeschlossen");
    if (input.parts.length) {
      const items = await itemsByIds(tx, ctx.organizationId, input.parts.map((p) => p.itemId));
      if (items.length !== new Set(input.parts.map((p) => p.itemId)).size) throw new NotFoundError("Artikel");
    }
    for (const part of input.parts) {
      const r = await issueStockTx(tx, ctx, { itemId: part.itemId, quantity: part.quantity.toString(), locationId: part.locationId, note: `Instandhaltung ${o.number}` });
      await tx.maintenancePart.create({ data: { organizationId: ctx.organizationId, orderId: id, itemId: part.itemId, quantity: part.quantity.toString(), movementIds: r.movements.map((m) => m.id) } });
    }
    await tx.maintenanceOrder.update({ where: { id }, data: { status: "DONE", doneAt: new Date(), doneOn: dateFromIso(input.doneOn), doneById: ctx.userId, report: input.report, minutesSpent: input.minutesSpent } });
    if (o.plan) {
      const next = nextDue(input.doneOn, o.plan.intervalUnit as IntervalUnit, o.plan.intervalValue);
      await tx.maintenancePlan.update({ where: { id: o.plan.id }, data: { lastDoneOn: dateFromIso(input.doneOn), nextDueOn: dateFromIso(next) } });
    }
    await writeAudit(tx, ctx, { action: "maintenance_order.complete", entityType: "MaintenanceOrder", entityId: id, after: { number: o.number, minutes: input.minutesSpent, parts: input.parts.length } });
  });
}

export async function cancelMaintenanceOrder(ctx: Ctx, id: string) {
  authorize(ctx, "maint.manage");
  return db.$transaction(async (tx) => {
    const r = await tx.maintenanceOrder.updateMany({ where: { id, organizationId: ctx.organizationId, status: { in: ["OPEN", "IN_PROGRESS"] } }, data: { status: "CANCELLED" } });
    if (r.count !== 1) throw new ConflictError("Der Auftrag kann nicht storniert werden");
    await writeAudit(tx, ctx, { action: "maintenance_order.cancel", entityType: "MaintenanceOrder", entityId: id });
  });
}

export async function listMaintenanceOrders(ctx: Ctx) {
  authorize(ctx, "maint.read");
  const rows = await db.maintenanceOrder.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ createdAt: "desc" }], take: 300, include: { object: { select: { number: true, name: true } } } });
  const rank: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  const open = rows.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS").sort((a, b) => rank[a.priority]! - rank[b.priority]!);
  return [...open, ...rows.filter((r) => r.status === "DONE" || r.status === "CANCELLED")];
}

export async function getMaintenanceOrder(ctx: Ctx, id: string) {
  authorize(ctx, "maint.read");
  const o = await db.maintenanceOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { object: true, parts: true } });
  if (!o) throw new NotFoundError("Instandhaltungsauftrag");
  const items = new Map((await itemsByIds(db, ctx.organizationId, o.parts.map((p) => p.itemId))).map((i) => [i.id, i]));
  return { ...o, parts: o.parts.map((p) => ({ ...p, item: items.get(p.itemId)! })) };
}

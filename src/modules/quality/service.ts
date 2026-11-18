import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { nextSequenceNumber } from "@/modules/finance/service";
import { itemsByIds } from "@/modules/inventory/queries";
import { decisionProblem, evaluate, outcome } from "./rules";
import { decisionInput, inspectionInput, ncInput, planInput, resultInput } from "./schema";

type Tx = Prisma.TransactionClient;
const d = (v: Decimal.Value) => new Decimal(v);
const year = () => Number(new Date().toISOString().slice(0, 4));
const lockItem = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
const lockInspection = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "Inspection" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

// ───────────────────────── Prüfpläne ─────────────────────────

export async function createInspectionPlan(ctx: Ctx, raw: unknown) {
  authorize(ctx, "qm.plan.manage");
  const input = planInput.parse(raw);
  for (const c of input.characteristics) {
    if (c.kind === "QUANTITATIVE" && c.minValue == null && c.maxValue == null) throw new ConflictError(`${c.name}: mindestens eine Grenze angeben`);
    if (c.kind === "QUALITATIVE" && (c.minValue != null || c.maxValue != null)) throw new ConflictError(`${c.name}: qualitative Merkmale haben keine Grenzen`);
    if (c.minValue != null && c.maxValue != null && c.minValue.gt(c.maxValue)) throw new ConflictError(`${c.name}: untere Grenze größer als obere`);
  }
  return db.$transaction(async (tx) => {
    const item = (await itemsByIds(tx, ctx.organizationId, [input.itemId]))[0];
    if (!item) throw new NotFoundError("Artikel");
    await lockItem(tx, ctx.organizationId, input.itemId);
    const version = ((await tx.inspectionPlan.aggregate({ where: { organizationId: ctx.organizationId, itemId: input.itemId }, _max: { version: true } }))._max.version ?? 0) + 1;
    const created = await tx.inspectionPlan.create({
      data: {
        organizationId: ctx.organizationId, itemId: input.itemId, version, note: input.note ?? null, createdById: ctx.userId,
        characteristics: { create: input.characteristics.map((c, i) => ({ position: i + 1, name: c.name, kind: c.kind, unit: c.unit ?? null, minValue: c.minValue?.toString() ?? null, maxValue: c.maxValue?.toString() ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "inspection_plan.create", entityType: "InspectionPlan", entityId: created.id, after: { itemId: input.itemId, version, characteristics: input.characteristics.length } });
    return created;
  });
}

/** Aktivieren archiviert die bisher aktive Version desselben Artikels; danach sind die Merkmale gesperrt. */
export async function activateInspectionPlan(ctx: Ctx, id: string) {
  authorize(ctx, "qm.plan.manage");
  return db.$transaction(async (tx) => {
    const plan = await tx.inspectionPlan.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!plan) throw new NotFoundError("Prüfplan");
    await lockItem(tx, ctx.organizationId, plan.itemId);
    if (plan.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können aktiviert werden");
    await tx.inspectionPlan.updateMany({ where: { organizationId: ctx.organizationId, itemId: plan.itemId, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
    await tx.inspectionPlan.update({ where: { id }, data: { status: "ACTIVE", activatedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "inspection_plan.activate", entityType: "InspectionPlan", entityId: id, after: { itemId: plan.itemId, version: plan.version } });
  });
}

export async function deleteInspectionPlanDraft(ctx: Ctx, id: string) {
  authorize(ctx, "qm.plan.manage");
  return db.$transaction(async (tx) => {
    const plan = await tx.inspectionPlan.findFirst({ where: { id, organizationId: ctx.organizationId, status: "DRAFT" } });
    if (!plan) throw new ConflictError("Nur Entwürfe können gelöscht werden");
    await tx.inspectionCharacteristic.deleteMany({ where: { planId: id } });
    await tx.inspectionPlan.delete({ where: { id } });
    await writeAudit(tx, ctx, { action: "inspection_plan.delete", entityType: "InspectionPlan", entityId: id });
  });
}

export async function listInspectionPlans(ctx: Ctx) {
  authorize(ctx, "qm.read");
  const plans = await db.inspectionPlan.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ itemId: "asc" }, { version: "desc" }], include: { characteristics: { orderBy: { position: "asc" } } } });
  const items = new Map((await itemsByIds(db, ctx.organizationId, [...new Set(plans.map((p) => p.itemId))])).map((i) => [i.id, i]));
  return plans.map((p) => ({ ...p, item: items.get(p.itemId)! }));
}

// ───────────────────────── Prüflose ─────────────────────────

/** Prüflos anlegen (gegen den aktiven Prüfplan des Artikels). Nummer QP-JJJJ-NNNN. */
export async function createInspection(ctx: Ctx, raw: unknown) {
  authorize(ctx, "qm.inspect");
  const input = inspectionInput.parse(raw);
  return db.$transaction(async (tx) => {
    const item = (await itemsByIds(tx, ctx.organizationId, [input.itemId]))[0];
    if (!item) throw new NotFoundError("Artikel");
    const plan = await tx.inspectionPlan.findFirst({ where: { organizationId: ctx.organizationId, itemId: input.itemId, status: "ACTIVE" } });
    if (!plan) throw new ConflictError("Für den Artikel gibt es keinen aktiven Prüfplan");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "QP", year());
    const created = await tx.inspection.create({ data: { organizationId: ctx.organizationId, number, itemId: input.itemId, planId: plan.id, quantity: input.quantity.toString(), batchNumber: input.batchNumber ?? null, source: input.source, reference: input.reference ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "inspection.create", entityType: "Inspection", entityId: created.id, after: { number, itemId: input.itemId, planVersion: plan.version } });
    return created;
  });
}

/** Ergebnis zu einem Merkmal erfassen oder überschreiben (solange das Prüflos offen ist). Messwerte werden gegen die Grenzen bewertet. */
export async function recordInspectionResult(ctx: Ctx, inspectionId: string, raw: unknown) {
  authorize(ctx, "qm.inspect");
  const input = resultInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockInspection(tx, ctx.organizationId, inspectionId);
    const insp = await tx.inspection.findFirst({ where: { id: inspectionId, organizationId: ctx.organizationId } });
    if (!insp) throw new NotFoundError("Prüflos");
    if (insp.status !== "OPEN") throw new ConflictError("Das Prüflos ist bereits entschieden");
    const ch = await tx.inspectionCharacteristic.findFirst({ where: { id: input.characteristicId, planId: insp.planId } });
    if (!ch) throw new NotFoundError("Prüfmerkmal");
    const ev = evaluate({ kind: ch.kind, minValue: ch.minValue ? d(ch.minValue.toString()) : null, maxValue: ch.maxValue ? d(ch.maxValue.toString()) : null }, { value: input.value ?? null, passed: input.passed ?? null });
    if ("error" in ev) throw new ConflictError(`${ch.name}: ${ev.error}`);
    const data = { position: ch.position, name: ch.name, kind: ch.kind, unit: ch.unit, minValue: ch.minValue?.toString() ?? null, maxValue: ch.maxValue?.toString() ?? null, value: ev.value?.toString() ?? null, passed: ev.passed, note: input.note ?? null, recordedById: ctx.userId, recordedAt: new Date() };
    await tx.inspectionResult.upsert({ where: { inspectionId_characteristicId: { inspectionId, characteristicId: ch.id } }, create: { inspectionId, characteristicId: ch.id, ...data }, update: data });
    await writeAudit(tx, ctx, { action: "inspection.result", entityType: "Inspection", entityId: inspectionId, after: { characteristic: ch.name, passed: ev.passed } });
    return { passed: ev.passed };
  });
}

/**
 * Entscheid (Verwendungsentscheid): Annahme oder Ablehnung. Nur bei vollständiger Prüfung; Annahme mit nicht bestandenen Merkmalen nur als Sonderfreigabe mit Begründung.
 * Ablehnung und Sonderfreigabe legen automatisch eine Abweichung (NC) an. Entschiedene Prüflose sind unveränderlich.
 */
export async function decideInspection(ctx: Ctx, inspectionId: string, raw: unknown) {
  authorize(ctx, "qm.decide");
  const input = decisionInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockInspection(tx, ctx.organizationId, inspectionId);
    const insp = await tx.inspection.findFirst({ where: { id: inspectionId, organizationId: ctx.organizationId }, include: { results: true } });
    if (!insp) throw new NotFoundError("Prüflos");
    if (insp.status !== "OPEN") throw new ConflictError("Das Prüflos ist bereits entschieden");
    const expected = await tx.inspectionCharacteristic.count({ where: { planId: insp.planId } });
    const o = outcome(expected, insp.results);
    const problem = decisionProblem(o, input.decision, input.note ?? null, input.deviation);
    if (problem) throw new ConflictError(problem);
    const status = input.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
    await tx.inspection.update({ where: { id: inspectionId }, data: { status, deviation: input.deviation, decisionNote: input.note ?? null, decidedById: ctx.userId, decidedAt: new Date() } });
    let nc: string | null = null;
    if (status === "REJECTED" || input.deviation) {
      const failed = insp.results.filter((r) => !r.passed).sort((a, b) => a.position - b.position).map((r) => `${r.name}${r.value !== null ? ` = ${r.value.toString()}${r.unit ? ` ${r.unit}` : ""}` : ""}`).join("; ");
      const number = await nextSequenceNumber(tx, ctx.organizationId, "NC", year());
      const created = await tx.nonConformance.create({ data: { organizationId: ctx.organizationId, number, inspectionId, itemId: insp.itemId, description: `${status === "REJECTED" ? "Prüflos abgelehnt" : "Sonderfreigabe"} ${insp.number}: ${failed}`, createdById: ctx.userId } });
      nc = created.number;
    }
    await writeAudit(tx, ctx, { action: "inspection.decide", entityType: "Inspection", entityId: inspectionId, after: { number: insp.number, status, deviation: input.deviation, nonConformance: nc } });
    await emitEvent(tx, ctx, "quality.inspection.decided", { inspectionId, number: insp.number, status, href: `/quality/${inspectionId}` });
    return { status, nonConformance: nc };
  });
}

export async function listInspections(ctx: Ctx) {
  authorize(ctx, "qm.read");
  const rows = await db.inspection.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 300 });
  const items = new Map((await itemsByIds(db, ctx.organizationId, [...new Set(rows.map((r) => r.itemId))])).map((i) => [i.id, i]));
  return rows.map((r) => ({ ...r, item: items.get(r.itemId)! }));
}

export async function getInspection(ctx: Ctx, id: string) {
  authorize(ctx, "qm.read");
  const insp = await db.inspection.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { results: true } });
  if (!insp) throw new NotFoundError("Prüflos");
  const [plan, items, ncs] = await Promise.all([
    db.inspectionPlan.findUniqueOrThrow({ where: { id: insp.planId }, include: { characteristics: { orderBy: { position: "asc" } } } }),
    itemsByIds(db, ctx.organizationId, [insp.itemId]),
    db.nonConformance.findMany({ where: { organizationId: ctx.organizationId, inspectionId: id }, select: { id: true, number: true, status: true } }),
  ]);
  const byChar = new Map(insp.results.map((r) => [r.characteristicId, r]));
  return { ...insp, planVersion: plan.version, item: items[0]!, nonConformances: ncs, characteristics: plan.characteristics.map((c) => ({ ...c, result: byChar.get(c.id) ?? null })) };
}

// ───────────────────────── Abweichungen ─────────────────────────

export async function createNonConformance(ctx: Ctx, raw: unknown) {
  authorize(ctx, "qm.nc.manage");
  const input = ncInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (input.itemId && !(await itemsByIds(tx, ctx.organizationId, [input.itemId])).length) throw new NotFoundError("Artikel");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "NC", year());
    const created = await tx.nonConformance.create({ data: { organizationId: ctx.organizationId, number, itemId: input.itemId ?? null, description: input.description, cause: input.cause ?? null, action: input.action ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "nonconformance.create", entityType: "NonConformance", entityId: created.id, after: { number } });
    return created;
  });
}

/** Ursache und Maßnahme ergänzen (solange offen). */
export async function updateNonConformance(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "qm.nc.manage");
  const input = ncInput.pick({ cause: true, action: true }).parse(raw);
  return db.$transaction(async (tx) => {
    const r = await tx.nonConformance.updateMany({ where: { id, organizationId: ctx.organizationId, status: "OPEN" }, data: { cause: input.cause ?? null, action: input.action ?? null } });
    if (r.count !== 1) throw new ConflictError("Nur offene Abweichungen können bearbeitet werden");
    await writeAudit(tx, ctx, { action: "nonconformance.update", entityType: "NonConformance", entityId: id });
  });
}

/** Schließen: Ursache und Maßnahme sind Pflicht. Danach unveränderlich. */
export async function closeNonConformance(ctx: Ctx, id: string) {
  authorize(ctx, "qm.nc.manage");
  return db.$transaction(async (tx) => {
    const nc = await tx.nonConformance.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!nc) throw new NotFoundError("Abweichung");
    if (nc.status !== "OPEN") throw new ConflictError("Die Abweichung ist bereits geschlossen");
    if (!nc.cause?.trim() || !nc.action?.trim()) throw new ConflictError("Zum Schließen sind Ursache und Maßnahme nötig");
    await tx.nonConformance.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date(), closedById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "nonconformance.close", entityType: "NonConformance", entityId: id, after: { number: nc.number } });
  });
}

export async function listNonConformances(ctx: Ctx) {
  authorize(ctx, "qm.read");
  const rows = await db.nonConformance.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 300 });
  const items = new Map((await itemsByIds(db, ctx.organizationId, [...new Set(rows.map((r) => r.itemId).filter((x): x is string => !!x))])).map((i) => [i.id, i]));
  return rows.map((r) => ({ ...r, item: r.itemId ? items.get(r.itemId) ?? null : null }));
}

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, can, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { budgetOf, committedOf, fiscalYearRange } from "@/modules/budget/queries";
import { decisionInput, orderInput, requestInput, supplierInput } from "./schema";
import { computeTotal } from "./rules";
import { stepsFor } from "@/platform/approvals/engine";
import { getActivePolicy, PURCHASE_REQUEST } from "@/platform/approvals/policy";
import type { Permission } from "@/platform/authz/permissions";

async function nextNumber(tx: Prisma.TransactionClient, organizationId: string, prefix: string) {
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;
  const seq = await tx.sequence.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: { organizationId, key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${key}-${String(seq.value).padStart(4, "0")}`;
}

async function emit(tx: Prisma.TransactionClient, ctx: Ctx, type: string, payload: Prisma.InputJsonValue) {
  await tx.outboxEvent.create({ data: { organizationId: ctx.organizationId, type, payload } });
}

// ───────── Lieferanten ─────────

export async function listSuppliers(ctx: Ctx) {
  authorize(ctx, "procurement.supplier.read");
  return db.supplier.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { number: "asc" } });
}

export async function createSupplier(ctx: Ctx, raw: unknown) {
  authorize(ctx, "procurement.supplier.write");
  const input = supplierInput.parse(raw);
  return db.$transaction(async (tx) => {
    const created = await tx.supplier.create({
      data: { organizationId: ctx.organizationId, number: input.number, name: input.name, email: input.email ?? null },
    });
    await writeAudit(tx, ctx, {
      action: "supplier.create", entityType: "Supplier", entityId: created.id,
      after: { number: created.number, name: created.name },
    });
    return created;
  });
}

// ───────── Bestellanforderungen ─────────

export async function listRequests(ctx: Ctx) {
  authorize(ctx, "procurement.request.create");
  const all = can(ctx, "procurement.request.read_all");
  return db.purchaseRequest.findMany({
    where: { organizationId: ctx.organizationId, ...(all ? {} : { requesterId: ctx.userId }) },
    orderBy: { createdAt: "desc" },
    include: { costCenter: { select: { code: true, name: true } } },
  });
}

export async function getRequest(ctx: Ctx, id: string) {
  authorize(ctx, "procurement.request.create");
  const all = can(ctx, "procurement.request.read_all");
  const request = await db.purchaseRequest.findFirst({
    where: { id, organizationId: ctx.organizationId, ...(all ? {} : { requesterId: ctx.userId }) },
    include: {
      lines: true,
      costCenter: true,
      approvals: { orderBy: { sequence: "asc" } },
      orders: { include: { supplier: { select: { name: true } }, costCenter: { select: { code: true } } } },
    },
  });
  if (!request) throw new NotFoundError("Bestellanforderung");
  return request;
}

/** Legt eine Anforderung an und reicht sie sofort ein; die Freigabeschritte ergeben sich aus dem Betrag. */
export async function createRequest(ctx: Ctx, raw: unknown) {
  authorize(ctx, "procurement.request.create");
  const input = requestInput.parse(raw);
  const total = computeTotal(input.lines);

  return db.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
    if (input.costCenterId) {
      const cc = await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId, active: true } });
      if (!cc) throw new NotFoundError("Kostenstelle");
    }
    const policy = await getActivePolicy(tx, ctx.organizationId, PURCHASE_REQUEST);
    const steps = stepsFor(policy.steps, total);
    const request = await tx.purchaseRequest.create({
      data: {
        organizationId: ctx.organizationId,
        number: await nextNumber(tx, ctx.organizationId, "PR"),
        title: input.title,
        requesterId: ctx.userId,
        costCenterId: input.costCenterId ?? null,
        status: "SUBMITTED",
        submittedAt: new Date(),
        policyVersion: policy.version,
        currency: org.currency,
        totalAmount: total,
        lines: { create: input.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })) },
        approvals: {
          create: steps.map((step, i) => ({
            organizationId: ctx.organizationId, stepKey: step.key, label: step.label, requiredPermission: step.permission, sequence: i + 1,
          })),
        },
      },
    });
    await writeAudit(tx, ctx, {
      action: "purchase_request.submit", entityType: "PurchaseRequest", entityId: request.id,
      after: { number: request.number, total: total.toString(), policyVersion: policy.version, steps: steps.map((x) => x.key) },
    });
    await emit(tx, ctx, "purchase_request.submitted", { requestId: request.id, total: total.toString() });
    return request;
  });
}

/** Offene Freigaben, die der Benutzer mit seinen Rechten entscheiden darf (nächster offener Schritt). */
export async function listPendingApprovals(ctx: Ctx) {
  const mine = [...ctx.permissions];
  if (mine.length === 0) return [];
  const pending = await db.approval.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "PENDING",
      requiredPermission: { in: mine },
      request: { status: "SUBMITTED", requesterId: { not: ctx.userId } },
    },
    include: { request: true },
    orderBy: { request: { submittedAt: "asc" } },
  });
  // nur der jeweils nächste offene Schritt ist entscheidbar
  const result = [];
  for (const a of pending) {
    const earlier = await db.approval.count({
      where: { requestId: a.requestId, sequence: { lt: a.sequence }, status: { not: "APPROVED" } },
    });
    if (earlier === 0) result.push(a);
  }
  return result;
}

export async function decideRequest(ctx: Ctx, raw: unknown) {
  const input = decisionInput.parse(raw);

  return db.$transaction(async (tx) => {
    const request = await tx.purchaseRequest.findFirst({
      where: { id: input.requestId, organizationId: ctx.organizationId },
      include: { approvals: { orderBy: { sequence: "asc" } } },
    });
    if (!request) throw new NotFoundError("Bestellanforderung");
    if (request.status !== "SUBMITTED") throw new ConflictError("Anforderung ist nicht mehr offen");

    const step = request.approvals.find((a) => a.status === "PENDING");
    if (!step) throw new ConflictError("Kein offener Freigabeschritt");
    authorize(ctx, step.requiredPermission as Permission);
    if (request.requesterId === ctx.userId) throw new ConflictError("Eigene Anforderungen dürfen nicht selbst freigegeben werden");

    // Bedingtes Update verhindert Doppelentscheidungen bei parallelen Anfragen
    const claimed = await tx.approval.updateMany({
      where: { id: step.id, status: "PENDING" },
      data: {
        status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decidedById: ctx.userId,
        decidedAt: new Date(),
        comment: input.comment ?? null,
      },
    });
    if (claimed.count !== 1) throw new ConflictError("Schritt wurde bereits entschieden");

    const remaining = request.approvals.filter((a) => a.id !== step.id && a.status === "PENDING").length;
    const newStatus = input.decision === "REJECT" ? "REJECTED" : remaining === 0 ? "APPROVED" : "SUBMITTED";
    if (newStatus !== "SUBMITTED") {
      await tx.purchaseRequest.update({ where: { id: request.id }, data: { status: newStatus } });
    }
    await writeAudit(tx, ctx, {
      action: `purchase_request.${input.decision === "APPROVE" ? "approve_step" : "reject"}`,
      entityType: "PurchaseRequest", entityId: request.id,
      after: { step: step.stepKey, resulting: newStatus, comment: input.comment ?? null },
    });
    // Zwischenstand und Endzustand lösen jeweils ein Event aus (Benachrichtigung der nächsten Freigeber bzw. des Antragstellers)
    await emit(tx, ctx, newStatus === "SUBMITTED" ? "purchase_request.step_approved" : `purchase_request.${newStatus.toLowerCase()}`, { requestId: request.id });
    return { status: newStatus };
  });
}

// ───────── Bestellungen ─────────

export async function listOrders(ctx: Ctx) {
  authorize(ctx, "procurement.order.create");
  return db.purchaseOrder.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: "desc" },
    include: { supplier: { select: { name: true } }, costCenter: { select: { code: true, name: true } }, request: { select: { number: true } } },
  });
}

/** Freigegebene Anforderung → Bestellung, Kostenstelle zuweisen, Budget wird (abgeleitet) gebunden. */
export async function createOrder(ctx: Ctx, raw: unknown) {
  authorize(ctx, "procurement.order.create");
  const input = orderInput.parse(raw);

  return db.$transaction(async (tx) => {
    const request = await tx.purchaseRequest.findFirst({ where: { id: input.requestId, organizationId: ctx.organizationId } });
    if (!request) throw new NotFoundError("Bestellanforderung");
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, organizationId: ctx.organizationId, active: true } });
    if (!supplier) throw new NotFoundError("Lieferant");
    const costCenter = await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId, active: true } });
    if (!costCenter) throw new NotFoundError("Kostenstelle");

    const claimed = await tx.purchaseRequest.updateMany({
      where: { id: request.id, organizationId: ctx.organizationId, status: "APPROVED" },
      data: { status: "ORDERED", costCenterId: costCenter.id },
    });
    if (claimed.count !== 1) throw new ConflictError("Nur freigegebene, noch nicht bestellte Anforderungen können bestellt werden");

    const order = await tx.purchaseOrder.create({
      data: {
        organizationId: ctx.organizationId,
        number: await nextNumber(tx, ctx.organizationId, "PO"),
        requestId: request.id,
        supplierId: supplier.id,
        costCenterId: costCenter.id,
        currency: request.currency,
        totalAmount: request.totalAmount,
      },
    });

    const range = fiscalYearRange(order.createdAt.getFullYear());
    const budget = await budgetOf(tx, ctx.organizationId, costCenter.id, range.year);
    const committed = await committedOf(tx, ctx.organizationId, costCenter.id, range);
    const overBudget = budget ? committed.gt(budget.amount) : null; // null = kein Budget hinterlegt

    await writeAudit(tx, ctx, {
      action: "purchase_order.create", entityType: "PurchaseOrder", entityId: order.id,
      after: {
        number: order.number, requestId: request.id, supplierId: supplier.id, costCenterId: costCenter.id,
        total: order.totalAmount.toString(), committedAfter: committed.toString(), overBudget,
      },
    });
    await emit(tx, ctx, "purchase_order.created", { orderId: order.id, costCenterId: costCenter.id });
    return { order, overBudget };
  });
}

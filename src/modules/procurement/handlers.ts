import type { Prisma } from "@prisma/client";
import type { EventHandler, HandlerMap } from "@/platform/events/dispatcher";
import { notify, usersWithPermission } from "@/platform/notifications/service";

async function loadRequest(tx: Prisma.TransactionClient, organizationId: string, payload: Prisma.JsonValue) {
  const requestId = (payload as { requestId?: string } | null)?.requestId;
  if (!requestId) throw new Error("Event ohne requestId");
  // Organisation aus dem Event: Handler lesen nie außerhalb der Organisation des Events
  const request = await tx.purchaseRequest.findFirst({
    where: { id: requestId, organizationId },
    include: { approvals: { orderBy: { sequence: "asc" } } },
  });
  if (!request) return null; // inzwischen entfernt: nichts zu benachrichtigen
  return request;
}

/** Benachrichtigt die Freigeber des nächsten offenen Schritts (außer dem Antragsteller). */
const notifyNextApprovers: EventHandler = async (event, tx) => {
  const request = await loadRequest(tx, event.organizationId, event.payload);
  if (!request || request.status !== "SUBMITTED") return;
  const step = request.approvals.find((a) => a.status === "PENDING");
  if (!step) return;
  const approvers = (await usersWithPermission(tx, event.organizationId, step.requiredPermission)).filter((u) => u !== request.requesterId);
  await notify(tx, event.organizationId, approvers.map((userId) => ({
    userId, type: "approval", href: `/procurement/${request.id}`,
    title: `Freigabe erforderlich: ${request.number}`,
    body: `${request.title} · Schritt „${step.label || step.stepKey}"`,
    dedupeKey: `${event.id}:${userId}:approval`,
  })));
};

const notifyApproved: EventHandler = async (event, tx) => {
  const request = await loadRequest(tx, event.organizationId, event.payload);
  if (!request) return;
  await notify(tx, event.organizationId, [{
    userId: request.requesterId, type: "info", href: `/procurement/${request.id}`,
    title: `Freigegeben: ${request.number}`, body: request.title, dedupeKey: `${event.id}:${request.requesterId}:approved`,
  }]);
  // Einkauf kann jetzt bestellen
  const buyers = (await usersWithPermission(tx, event.organizationId, "procurement.order.create")).filter((u) => u !== request.requesterId);
  await notify(tx, event.organizationId, buyers.map((userId) => ({
    userId, type: "task", href: `/procurement/${request.id}`,
    title: `Bestellung anlegen: ${request.number}`, body: request.title, dedupeKey: `${event.id}:${userId}:order-task`,
  })));
};

const notifyRejected: EventHandler = async (event, tx) => {
  const request = await loadRequest(tx, event.organizationId, event.payload);
  if (!request) return;
  await notify(tx, event.organizationId, [{
    userId: request.requesterId, type: "info", href: `/procurement/${request.id}`,
    title: `Abgelehnt: ${request.number}`, body: request.title, dedupeKey: `${event.id}:${request.requesterId}:rejected`,
  }]);
};

const notifyOrdered: EventHandler = async (event, tx) => {
  const orderId = (event.payload as { orderId?: string } | null)?.orderId;
  if (!orderId) throw new Error("Event ohne orderId");
  const order = await tx.purchaseOrder.findFirst({ where: { id: orderId, organizationId: event.organizationId }, include: { request: true } });
  if (!order?.request) return;
  await notify(tx, event.organizationId, [{
    userId: order.request.requesterId, type: "info", href: `/procurement/${order.request.id}`,
    title: `Bestellt: ${order.request.number}`, body: `Bestellung ${order.number}`, dedupeKey: `${event.id}:${order.request.requesterId}:ordered`,
  }]);
};

export const procurementHandlers: HandlerMap = {
  "purchase_request.submitted": [notifyNextApprovers],
  "purchase_request.step_approved": [notifyNextApprovers],
  "purchase_request.approved": [notifyApproved],
  "purchase_request.rejected": [notifyRejected],
  "purchase_order.created": [notifyOrdered],
};

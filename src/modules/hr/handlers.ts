import type { Prisma } from "@prisma/client";
import type { EventHandler, HandlerMap } from "@/platform/events/dispatcher";
import { notify, usersWithPermission } from "@/platform/notifications/service";

async function load(tx: Prisma.TransactionClient, organizationId: string, payload: Prisma.JsonValue) {
  const absenceId = (payload as { absenceId?: string } | null)?.absenceId;
  if (!absenceId) throw new Error("Event ohne absenceId");
  return tx.absenceRequest.findFirst({
    where: { id: absenceId, organizationId },
    include: { employee: { include: { manager: { select: { userId: true } } } }, type: true, approvals: { orderBy: { sequence: "asc" } } },
  });
}

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;
const name = (a: Loaded) => `${a.employee.firstName} ${a.employee.lastName}`;
const range = (a: Loaded) => `${a.startDate.toISOString().slice(0, 10)} bis ${a.endDate.toISOString().slice(0, 10)}`;

/** Wer den Antrag in diesem Schritt entscheiden darf: direkte Führungskraft und Personal – nie die antragstellende Person. */
async function approversFor(tx: Prisma.TransactionClient, organizationId: string, a: Loaded, permission: string) {
  const ids = new Set(await usersWithPermission(tx, organizationId, permission));
  if (permission === "hr.absence.approve") {
    // „approve" gilt nur für das eigene Team: statt aller Führungskräfte nur die direkte Führungskraft (und Personal mit approve_all)
    const all = new Set(await usersWithPermission(tx, organizationId, "hr.absence.approve_all"));
    ids.clear();
    if (a.employee.manager?.userId) ids.add(a.employee.manager.userId);
    for (const u of all) ids.add(u);
  }
  if (a.employee.userId) ids.delete(a.employee.userId);
  return [...ids];
}

const notifyApprovers: EventHandler = async (event, tx) => {
  const a = await load(tx, event.organizationId, event.payload);
  if (!a || a.status !== "PENDING") return;
  const step = a.approvals.find((x) => x.status === "PENDING");
  if (!step) return;
  const users = await approversFor(tx, event.organizationId, a, step.requiredPermission);
  await notify(tx, event.organizationId, users.map((userId) => ({
    userId, type: "approval", href: "/absences",
    title: `Abwesenheitsantrag: ${name(a)}`, body: `${a.type.name} ${range(a)} (${a.days.toString()} Arbeitstage)`,
    dedupeKey: `${event.id}:${userId}:absence-approval`,
  })));
};

const notifyDecision = (word: string): EventHandler => async (event, tx) => {
  const a = await load(tx, event.organizationId, event.payload);
  if (!a?.employee.userId) return;
  await notify(tx, event.organizationId, [{
    userId: a.employee.userId, type: "info", href: "/absences",
    title: `${a.type.name} ${word}`, body: range(a), dedupeKey: `${event.id}:${a.employee.userId}:absence-${word}`,
  }]);
};

/** Meldung ohne Freigabe (z. B. Krankenstand): die direkte Führungskraft wird informiert. Keine Diagnosen. */
const notifyManagerInfo = (title: (a: Loaded) => string): EventHandler => async (event, tx) => {
  const a = await load(tx, event.organizationId, event.payload);
  const userId = a?.employee.manager?.userId;
  if (!a || !userId || userId === a.employee.userId) return;
  await notify(tx, event.organizationId, [{
    userId, type: "info", href: "/absences", title: title(a), body: range(a), dedupeKey: `${event.id}:${userId}:absence-info`,
  }]);
};

export const hrHandlers: HandlerMap = {
  "absence.requested": [notifyApprovers],
  "absence.step_approved": [notifyApprovers],
  "absence.approved": [notifyDecision("genehmigt")],
  "absence.rejected": [notifyDecision("abgelehnt")],
  "absence.recorded": [notifyManagerInfo((a) => `${a.type.name} gemeldet: ${name(a)}`)],
  "absence.cancelled": [notifyManagerInfo((a) => `Abwesenheit storniert: ${name(a)}`)],
};

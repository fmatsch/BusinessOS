import type { Prisma } from "@prisma/client";
import type { EventHandler, HandlerMap } from "@/platform/events/dispatcher";
import { notify, usersWithPermission } from "@/platform/notifications/service";
import { employeeBasics } from "@/modules/hr/queries";

type Emp = Awaited<ReturnType<typeof employeeBasics>>[number];

async function emp(tx: Prisma.TransactionClient, organizationId: string, id: string): Promise<Emp | null> {
  return (await employeeBasics(tx, organizationId, [id]))[0] ?? null;
}

/** Direkte Führungskraft und Personalwesen (approve_all) – nie die Person selbst. */
async function approvers(tx: Prisma.TransactionClient, organizationId: string, e: Emp) {
  const ids = new Set(await usersWithPermission(tx, organizationId, "time.period.approve_all"));
  if (e.managerId) { const m = await emp(tx, organizationId, e.managerId); if (m?.userId) ids.add(m.userId); }
  if (e.userId) ids.delete(e.userId);
  return [...ids];
}

const label = (p: { year: number; month: number }) => `${String(p.month).padStart(2, "0")}/${p.year}`;

const requestCreated: EventHandler = async (event, tx) => {
  const { requestId } = event.payload as { requestId: string };
  const r = await tx.timeEntryRequest.findFirst({ where: { id: requestId, organizationId: event.organizationId } });
  if (!r || r.status !== "PENDING") return;
  const e = await emp(tx, event.organizationId, r.employeeId);
  if (!e) return;
  const users = await approvers(tx, event.organizationId, e);
  await notify(tx, event.organizationId, users.map((userId) => ({
    userId, type: "approval", href: "/time/team", title: `Zeitantrag: ${e.firstName} ${e.lastName}`, body: r.reason, dedupeKey: `${event.id}:${userId}:time-request`,
  })));
};

const requestDecided: EventHandler = async (event, tx) => {
  const { requestId } = event.payload as { requestId: string };
  const r = await tx.timeEntryRequest.findFirst({ where: { id: requestId, organizationId: event.organizationId } });
  if (!r) return;
  const e = await emp(tx, event.organizationId, r.employeeId);
  if (!e?.userId) return;
  await notify(tx, event.organizationId, [{
    userId: e.userId, type: "info", href: "/time", title: r.status === "APPROVED" ? "Zeitantrag genehmigt" : "Zeitantrag abgelehnt",
    body: r.comment ?? r.reason, dedupeKey: `${event.id}:${e.userId}:time-decided`,
  }]);
};

type PeriodPayload = { employeeId: string; year: number; month: number; comment?: string };

const periodSubmitted: EventHandler = async (event, tx) => {
  const p = event.payload as PeriodPayload;
  const e = await emp(tx, event.organizationId, p.employeeId);
  if (!e) return;
  const users = await approvers(tx, event.organizationId, e);
  await notify(tx, event.organizationId, users.map((userId) => ({
    userId, type: "approval", href: "/time/team", title: `Monatsabschluss eingereicht: ${e.firstName} ${e.lastName}`, body: label(p), dedupeKey: `${event.id}:${userId}:period-submitted`,
  })));
};

const toEmployee = (title: (p: PeriodPayload) => string): EventHandler => async (event, tx) => {
  const p = event.payload as PeriodPayload;
  const e = await emp(tx, event.organizationId, p.employeeId);
  if (!e?.userId) return;
  await notify(tx, event.organizationId, [{ userId: e.userId, type: "info", href: "/time", title: title(p), body: p.comment ?? label(p), dedupeKey: `${event.id}:${e.userId}:period-info` }]);
};

export const timeHandlers: HandlerMap = {
  "time.request.created": [requestCreated],
  "time.request.decided": [requestDecided],
  "time.period.submitted": [periodSubmitted],
  "time.period.approved": [toEmployee((p) => `Monatsabschluss ${label(p)} freigegeben`)],
  "time.period.returned": [toEmployee((p) => `Monatsabschluss ${label(p)} zurückgegeben`)],
  "time.period.reopened": [toEmployee((p) => `Monat ${label(p)} wurde wieder geöffnet`)],
};

import type { Prisma } from "@prisma/client";
import type { EventHandler, HandlerMap } from "@/platform/events/dispatcher";
import { notify, usersWithPermission } from "@/platform/notifications/service";
import { employeeBasics } from "@/modules/hr/queries";

type Pair = { shiftId: string; employeeId: string; start: string };
const fmt = (iso: string) => new Date(iso).toLocaleString("de-AT", { timeZone: "Europe/Vienna", dateStyle: "short", timeStyle: "short" });

async function userOf(tx: Prisma.TransactionClient, organizationId: string, employeeId: string) {
  const [e] = await employeeBasics(tx, organizationId, [employeeId]);
  return e ?? null;
}

const rosterPublished: EventHandler = async (event, tx) => {
  const { rosterId, version } = event.payload as { rosterId: string; version: number };
  const v = await tx.rosterVersion.findFirst({ where: { rosterId, version, organizationId: event.organizationId }, include: { roster: { include: { site: true } } } });
  if (!v) return;
  const changes = v.changes as unknown as { added: Pair[]; removed: Pair[] };
  const people = await employeeBasics(tx, event.organizationId, [...new Set([...changes.added, ...changes.removed].map((p) => p.employeeId))]);
  const user = new Map(people.map((p) => [p.id, p.userId]));
  const items: Parameters<typeof notify>[2] = [];
  for (const [kind, list] of [["added", changes.added], ["removed", changes.removed]] as const) {
    const per = new Map<string, Pair[]>();
    for (const p of list) (per.get(p.employeeId) ?? per.set(p.employeeId, []).get(p.employeeId)!).push(p);
    for (const [employeeId, pairs] of per) {
      const userId = user.get(employeeId);
      if (!userId) continue;
      const first = pairs.map((p) => p.start).sort()[0]!;
      items.push({
        userId, type: "info", href: "/roster",
        title: kind === "added" ? `Dienstplan ${v.roster.site.name}: ${pairs.length} neue Schicht(en)` : `Dienstplan ${v.roster.site.name}: ${pairs.length} Schicht(en) entfernt`,
        body: `Version ${version}, ab ${fmt(first)}`, dedupeKey: `${event.id}:${userId}:roster-${kind}`,
      });
    }
  }
  await notify(tx, event.organizationId, items);
};

async function loadSwap(tx: Prisma.TransactionClient, event: { organizationId: string; payload: Prisma.JsonValue }) {
  const swapId = (event.payload as { swapId?: string } | null)?.swapId;
  if (!swapId) throw new Error("Event ohne swapId");
  const swap = await tx.shiftSwapRequest.findFirst({ where: { id: swapId, organizationId: event.organizationId }, include: { shift: true, roster: { include: { site: true } } } });
  if (!swap) return null;
  const [from, to] = await Promise.all([userOf(tx, event.organizationId, swap.fromEmployeeId), userOf(tx, event.organizationId, swap.toEmployeeId)]);
  return { swap, from, to };
}

const body = (s: NonNullable<Awaited<ReturnType<typeof loadSwap>>>) => `${s.swap.roster.site.name}, ${fmt(s.swap.shift.startAt.toISOString())}`;
const name = (e: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}` : "?");

const swapRequested: EventHandler = async (event, tx) => {
  const s = await loadSwap(tx, event);
  if (!s?.to?.userId || s.swap.status !== "PENDING_PEER") return;
  await notify(tx, event.organizationId, [{ userId: s.to.userId, type: "task", href: "/roster", title: `Tauschanfrage von ${name(s.from)}`, body: body(s), dedupeKey: `${event.id}:${s.to.userId}:swap-req` }]);
};

const swapAccepted: EventHandler = async (event, tx) => {
  const s = await loadSwap(tx, event);
  if (!s || s.swap.status !== "PENDING_APPROVAL") return;
  const users = new Set(await usersWithPermission(tx, event.organizationId, "roster.plan"));
  if (s.from?.managerId) { const m = await userOf(tx, event.organizationId, s.from.managerId); if (m?.userId) users.add(m.userId); }
  for (const u of [s.from?.userId, s.to?.userId]) if (u) users.delete(u);
  await notify(tx, event.organizationId, [...users].map((userId) => ({
    userId, type: "approval", href: "/roster", title: `Schichttausch wartet auf Freigabe: ${name(s.from)} ↔ ${name(s.to)}`, body: body(s), dedupeKey: `${event.id}:${userId}:swap-approval`,
  })));
};

const tell = (title: (s: NonNullable<Awaited<ReturnType<typeof loadSwap>>>) => string, who: "from" | "both"): EventHandler => async (event, tx) => {
  const s = await loadSwap(tx, event);
  if (!s) return;
  const targets = (who === "both" ? [s.from, s.to] : [s.from]).filter((x): x is NonNullable<typeof x> => !!x?.userId);
  await notify(tx, event.organizationId, targets.map((t) => ({ userId: t.userId!, type: "info", href: "/roster", title: title(s), body: body(s), dedupeKey: `${event.id}:${t.userId}:swap-info` })));
};

export const rosterHandlers: HandlerMap = {
  "roster.published": [rosterPublished],
  "swap.requested": [swapRequested],
  "swap.accepted": [swapAccepted],
  "swap.declined": [tell((s) => `${name(s.to)} hat den Tausch abgelehnt`, "from")],
  "swap.approved": [tell(() => "Schichttausch genehmigt", "both")],
  "swap.rejected": [tell(() => "Schichttausch abgelehnt", "both")],
};

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Ctx } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";

export interface NewNotification {
  userId: string;
  title: string;
  body?: string;
  href?: string;
  type?: string;
  /** eindeutig pro Zustellung; macht die Erzeugung bei Event-Wiederholung idempotent */
  dedupeKey: string;
}

/** Interner Aufruf (Event-Handler): erzeugt Benachrichtigungen, doppelte dedupeKeys werden ignoriert. */
export async function notify(tx: Prisma.TransactionClient, organizationId: string, items: NewNotification[]) {
  if (items.length === 0) return;
  await tx.notification.createMany({
    data: items.map((n) => ({
      organizationId, userId: n.userId, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null,
      href: n.href ?? null, type: n.type ?? "info", dedupeKey: n.dedupeKey,
    })),
    skipDuplicates: true,
  });
}

/** Aktive Mitglieder der Organisation, deren Rolle die Berechtigung enthält. */
export async function usersWithPermission(tx: Prisma.TransactionClient, organizationId: string, permission: string) {
  const rows = await tx.organizationMembership.findMany({
    where: { organizationId, user: { active: true }, role: { permissions: { some: { permission: { key: permission } } } } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ── Eigene Benachrichtigungen (immer auf Benutzer und aktive Organisation beschränkt) ──

export function listNotifications(ctx: Ctx, take = 100) {
  return db.notification.findMany({
    where: { organizationId: ctx.organizationId, userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export function unreadCount(ctx: Pick<Ctx, "userId" | "organizationId">) {
  return db.notification.count({ where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null } });
}

export async function markRead(ctx: Ctx, id: string) {
  const r = await db.notification.updateMany({
    where: { id, organizationId: ctx.organizationId, userId: ctx.userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (r.count === 0 && !(await db.notification.findFirst({ where: { id, organizationId: ctx.organizationId, userId: ctx.userId }, select: { id: true } })))
    throw new NotFoundError("Benachrichtigung");
}

export async function markAllRead(ctx: Ctx) {
  await db.notification.updateMany({
    where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null },
    data: { readAt: new Date() },
  });
}

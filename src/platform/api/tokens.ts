import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import type { Permission } from "@/platform/authz/permissions";

/**
 * API-Token für die lesende REST-API. Das Token handelt als der erstellende Benutzer in genau seiner Organisation; die Berechtigungen werden bei jedem Aufruf
 * aus der aktuellen Rolle gelesen (Rollenentzug wirkt sofort). In der Datenbank steht nur der Hash.
 */

export const TOKEN_PREFIX = "bos_";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const createInput = z.object({
  name: z.string().trim().min(1, "Bitte einen Namen angeben").max(80),
  /** Gültigkeit in Tagen (1–730) */
  expiresInDays: z.coerce.number().int().min(1).max(730).default(90),
});

/** Legt ein Token an und gibt es EINMALIG im Klartext zurück. */
export async function createApiToken(ctx: Ctx, raw: unknown) {
  authorize(ctx, "api.token.manage");
  const input = createInput.parse(raw);
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  return db.$transaction(async (tx) => {
    const created = await tx.apiToken.create({ data: { organizationId: ctx.organizationId, userId: ctx.userId, name: input.name, prefix: token.slice(0, TOKEN_PREFIX.length + 6), tokenHash: hash(token), expiresAt } });
    await writeAudit(tx, ctx, { action: "api_token.create", entityType: "ApiToken", entityId: created.id, after: { name: input.name, expiresAt: expiresAt.toISOString() } });
    return { id: created.id, token, expiresAt };
  });
}

export async function listApiTokens(ctx: Ctx) {
  authorize(ctx, "api.token.manage");
  return db.apiToken.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, prefix: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true, userId: true } });
}

export async function revokeApiToken(ctx: Ctx, id: string) {
  authorize(ctx, "api.token.manage");
  return db.$transaction(async (tx) => {
    const t = await tx.apiToken.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!t) throw new NotFoundError("API-Token");
    if (t.revokedAt) throw new ConflictError("Das Token ist bereits widerrufen");
    await tx.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "api_token.revoke", entityType: "ApiToken", entityId: id, after: { name: t.name } });
  });
}

export interface ApiContext { ctx: Ctx; tokenId: string }

/**
 * Prüft einen `Authorization: Bearer`-Header. Gibt den Kontext (Benutzer, Organisation, aktuelle Berechtigungen) zurück oder `null`
 * (unbekannt, widerrufen, abgelaufen, Benutzer inaktiv oder nicht mehr Mitglied). Die Berechtigung `api.token.manage` wird nie weitergegeben.
 */
export async function authenticateApiToken(header: string | null): Promise<ApiContext | null> {
  const m = /^Bearer\s+(bos_[0-9a-f]{48})$/.exec(header?.trim() ?? "");
  if (!m) return null;
  const t = await db.apiToken.findUnique({ where: { tokenHash: hash(m[1]!) } });
  if (!t || t.revokedAt || (t.expiresAt && t.expiresAt.getTime() <= Date.now())) return null;
  const membership = await db.organizationMembership.findFirst({
    where: { userId: t.userId, organizationId: t.organizationId, user: { active: true } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  if (!membership) return null;
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000) await db.apiToken.update({ where: { id: t.id }, data: { lastUsedAt: new Date() } });
  const permissions = new Set(membership.role.permissions.map((rp) => rp.permission.key as Permission));
  permissions.delete("api.token.manage");
  return { ctx: { userId: t.userId, organizationId: t.organizationId, permissions }, tokenId: t.id };
}

// ───────────────────────── Ratenbegrenzung ─────────────────────────

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** Gleitendes Fenster je Token im Speicher des Prozesses (bei mehreren Prozessen gilt die Grenze je Prozess). */
export function rateLimit(key: string, limit = 120, now = Date.now()): { ok: boolean; retryAfterSeconds: number } {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) { hits.set(key, recent); return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000)) }; }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true, retryAfterSeconds: 0 };
}
export const _resetRateLimit = () => hits.clear();

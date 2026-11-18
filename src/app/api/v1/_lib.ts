import { ZodError } from "zod";
import { authenticateApiToken, rateLimit } from "@/platform/api/tokens";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";

/** Gemeinsamer Rahmen der REST-API: Token prüfen, Rate-Limit, Fehler in einheitliches JSON übersetzen. Die Berechtigung prüft jeweils der Service. */

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...HEADERS, ...extra } });
}
export const apiError = (status: number, code: string, message: string, extra: Record<string, string> = {}) => json({ error: { code, message } }, status, extra);

export async function withApi(req: Request, handler: (ctx: Ctx, url: URL) => Promise<Response | unknown>): Promise<Response> {
  const auth = await authenticateApiToken(req.headers.get("authorization"));
  if (!auth) return apiError(401, "unauthorized", "Ungültiges, abgelaufenes oder widerrufenes API-Token", { "WWW-Authenticate": 'Bearer realm="BusinessOS"' });
  const rl = rateLimit(auth.tokenId);
  if (!rl.ok) return apiError(429, "rate_limited", "Zu viele Anfragen", { "Retry-After": String(rl.retryAfterSeconds) });
  try {
    const out = await handler(auth.ctx, new URL(req.url));
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (e instanceof ForbiddenError) return apiError(403, "forbidden", "Keine Berechtigung");
    if (e instanceof NotFoundError) return apiError(404, "not_found", e.message);
    if (e instanceof ConflictError) return apiError(409, "conflict", e.message);
    if (e instanceof ZodError) return apiError(422, "invalid_request", e.issues.map((i) => i.message).join("; "));
    console.error("API error", e);
    return apiError(500, "internal_error", "Interner Fehler");
  }
}

/** Seitenweise Ausgabe: `?limit=1..200` (Standard 50) und `?offset=0..`. */
export function paginate<T>(rows: T[], url: URL) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  return { data: rows.slice(offset, offset + limit), page: { limit, offset, total: rows.length } };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

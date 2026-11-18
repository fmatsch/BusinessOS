import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { _resetRateLimit, authenticateApiToken, createApiToken, listApiTokens, rateLimit, revokeApiToken } from "@/platform/api/tokens";
import { createCustomer } from "@/modules/finance/service";
import { createItem } from "@/modules/inventory/service";
import { OPENAPI } from "./_openapi";
import { GET as customersGET } from "./customers/route";
import { GET as itemsGET } from "./items/route";
import { GET as ordersGET } from "./sales-orders/route";
import { GET as invoicesGET } from "./customer-invoices/route";
import { GET as invoiceGET } from "./customer-invoices/[id]/route";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;

function routePaths(dir = path.join(__dirname), base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (!name.startsWith("_")) out.push(...routePaths(full, `${base}/${name.replace(/^\[(.+)\]$/, "{$1}")}`)); }
    else if (name === "route.ts" && base !== "/openapi.json") out.push(base);
  }
  return out.sort();
}

describe("OpenAPI-Beschreibung", () => {
  it("beschreibt genau die vorhandenen Routen (kein Auseinanderlaufen von Code und Dokumentation)", () => {
    expect(Object.keys(OPENAPI.paths).sort()).toEqual(routePaths());
  });
  it("jeder Pfad ist nur lesend (GET) und verlangt ein Token", () => {
    for (const p of Object.values(OPENAPI.paths)) expect(Object.keys(p)).toEqual(["get"]);
    expect(OPENAPI.security).toEqual([{ bearer: [] }]);
  });
  it("Ratenbegrenzung: gleitendes Fenster je Token", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, t0 + i).ok).toBe(true);
    const blocked = rateLimit("k", 3, t0 + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(rateLimit("andere", 3, t0 + 10).ok).toBe(true); // je Token getrennt
    expect(rateLimit("k", 3, t0 + 61_000).ok).toBe(true); // nach dem Fenster wieder frei
  });
});

describe.skipIf(!hasDb)("REST-API: Token, Zugriff, Berechtigungen", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];
  const I: Record<string, string> = {};

  async function makeOrg(name: string) {
    const org = await db.organization.create({ data: { tenantId, name } });
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await db.role.create({ data: { organizationId: org.id, key, name: def.name, system: true } });
      const perms = await db.permission.findMany({ where: { key: { in: [...def.permissions] } } });
      await db.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
    return org.id;
  }
  async function makeUser(org: string, label: string, role: RoleKey) {
    const user = await db.user.create({ data: { email: `${label}-${org}@test.invalid`, name: label, passwordHash: await bcrypt.hash("x", 4) } });
    userIds.push(user.id);
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    c[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
    I[`membership_${label}`] = user.id;
  }
  const call = (handler: (req: Request, x: never) => Promise<Response> | Response, token: string | null, query = "", extra: object = {}) =>
    handler(new Request(`http://localhost/api/v1/x${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), extra as never);

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-API" } })).id;
    orgA = await makeOrg("TEST-API-A");
    orgB = await makeOrg("TEST-API-B");
    for (const [l, r] of [["owner", "owner"], ["fin", "finance"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "ownerB", "owner");
    await createCustomer(c.fin!, { number: "K1", name: "Kunde A" });
    await createCustomer(c.ownerB!, { number: "KB", name: "Kunde B (fremd)" });
    await createItem(c.fin!, { number: "A1", name: "Artikel" });
    I.ownerToken = (await createApiToken(c.owner!, { name: "ERP-Anbindung", expiresInDays: 30 })).token;
    I.empToken = ""; // Mitarbeiter dürfen keine Tokens anlegen (siehe Test)
  });

  beforeEach(() => _resetRateLimit());

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      for (const m of ["apiToken", "auditLog", "item", "customer", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Token verwalten: nur der Inhaber, Klartext einmalig, in der Datenbank nur der Hash", async () => {
    await expect(createApiToken(c.fin!, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createApiToken(c.emp!, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createApiToken(c.owner!, { name: "" })).rejects.toThrow();
    expect(I.ownerToken).toMatch(/^bos_[0-9a-f]{48}$/);
    const rows = await db.apiToken.findMany({ where: { organizationId: orgA } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(I.ownerToken!); // kein Klartext
    expect(rows[0]!.prefix).toBe(I.ownerToken!.slice(0, 10));
    const list = await listApiTokens(c.owner!);
    expect(list.map((t) => t.name)).toEqual(["ERP-Anbindung"]);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    await expect(listApiTokens(c.fin!)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listApiTokens(c.ownerB!)).toEqual([]); // Mandantentrennung
    expect(await db.auditLog.count({ where: { organizationId: orgA, action: "api_token.create" } })).toBe(1);
  });

  it("Authentifizierung: fehlend, falsch, fremdes Format → 401; gültig → Daten der eigenen Organisation", async () => {
    expect((await call(customersGET, null)).status).toBe(401);
    expect((await call(customersGET, "bos_" + "0".repeat(48))).status).toBe(401);
    expect((await call(customersGET, "kein-token")).status).toBe(401);
    expect((await call(customersGET, null)).headers.get("www-authenticate")).toContain("Bearer");
    const res = await call(customersGET, I.ownerToken!);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((x: { name: string }) => x.name)).toEqual(["Kunde A"]); // nie Daten der anderen Organisation
    expect(body.page).toEqual({ limit: 50, offset: 0, total: 1 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toMatch(/organizationId|createdById|receivableAccountId/); // nur freigegebene Felder
    const items = await (await call(itemsGET, I.ownerToken!)).json();
    expect(items.data[0]).toMatchObject({ number: "A1", onHand: "0" });
  });

  it("Pagination, Filter, Fehlerformat", async () => {
    const lim = await (await call(customersGET, I.ownerToken!, "?limit=1&offset=5")).json();
    expect(lim.data).toEqual([]);
    expect(lim.page).toMatchObject({ limit: 1, offset: 5, total: 1 });
    expect((await (await call(ordersGET, I.ownerToken!, "?status=CONFIRMED")).json()).data).toEqual([]);
    const notFound = await call(invoiceGET, I.ownerToken!, "", { params: Promise.resolve({ id: "gibt-es-nicht" }) });
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error.code).toBe("not_found");
  });

  it("Berechtigungen des Benutzers gelten; Rollenentzug wirkt sofort; Rate-Limit liefert 429", async () => {
    // Token eines Mitarbeiters (direkt in der Datenbank angelegt – der Service lässt es nicht zu) darf nichts lesen
    const empUser = I.membership_emp!;
    const plain = "bos_" + "ab".repeat(24);
    const { createHash } = await import("node:crypto");
    await db.apiToken.create({ data: { organizationId: orgA, userId: empUser, name: "unzulässig", prefix: plain.slice(0, 10), tokenHash: createHash("sha256").update(plain).digest("hex"), expiresAt: new Date(Date.now() + 1e9) } });
    expect((await call(customersGET, plain)).status).toBe(403);
    expect((await call(invoicesGET, plain)).status).toBe(403);
    // Die Berechtigung zur Token-Verwaltung wird nie weitergegeben
    const ctx = (await authenticateApiToken(`Bearer ${I.ownerToken}`))!.ctx;
    expect(ctx.permissions.has("api.token.manage")).toBe(false);
    expect(ctx.permissions.has("finance.master.read")).toBe(true);
    // Rate-Limit
    for (let i = 0; i < 120; i++) await call(customersGET, I.ownerToken!);
    const limited = await call(customersGET, I.ownerToken!);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("Widerruf, Ablauf und inaktive Benutzer sperren sofort", async () => {
    const t2 = await createApiToken(c.owner!, { name: "Kurzzeit", expiresInDays: 1 });
    expect((await call(customersGET, t2.token)).status).toBe(200);
    await db.apiToken.update({ where: { id: t2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(customersGET, t2.token)).status).toBe(401); // abgelaufen
    const t3 = await createApiToken(c.owner!, { name: "Widerruf" });
    await expect(revokeApiToken(c.fin!, t3.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeApiToken(c.ownerB!, t3.id)).rejects.toBeInstanceOf(NotFoundError);
    await revokeApiToken(c.owner!, t3.id);
    expect((await call(customersGET, t3.token)).status).toBe(401);
    await expect(revokeApiToken(c.owner!, t3.id)).rejects.toBeInstanceOf(ConflictError);
    const t4 = await createApiToken(c.owner!, { name: "Inaktiv" });
    await db.user.update({ where: { id: I.membership_owner! }, data: { active: false } });
    expect((await call(customersGET, t4.token)).status).toBe(401);
    expect((await call(customersGET, I.ownerToken!)).status).toBe(401);
    await db.user.update({ where: { id: I.membership_owner! }, data: { active: true } });
    expect((await call(customersGET, I.ownerToken!)).status).toBe(200);
  });
});

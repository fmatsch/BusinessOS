import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { NotFoundError } from "@/platform/errors";
import { publishPolicy, readPolicy } from "@/platform/approvals/policy";
import { listNotifications, markRead, unreadCount } from "@/platform/notifications/service";
import { runOutbox } from "@/modules/events";
import { createRequest, decideRequest } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const line = (price: string) => [{ description: "x", quantity: "1", unitPrice: price }];

describe.skipIf(!hasDb)("Benachrichtigungen und versionierte Freigaberegeln", () => {
  let tenantId = "", orgA = "", orgB = "";
  const users: Record<string, string> = {};
  const ctx: Record<string, Ctx> = {};
  const createdUserIds: string[] = [];

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
    createdUserIds.push(user.id);
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    users[`${label}`] = user.id;
    ctx[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
  }
  const titles = async (label: string) => (await listNotifications(ctx[label]!)).map((n) => n.title);

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-M6" } })).id;
    orgA = await makeOrg("TEST-M6-A");
    orgB = await makeOrg("TEST-M6-B");
    await makeUser(orgA, "emp", "employee");
    await makeUser(orgA, "mgr1", "manager");
    await makeUser(orgA, "mgr2", "manager");
    await makeUser(orgA, "fin", "finance");
    await makeUser(orgA, "own", "owner");
    await makeUser(orgB, "mgrB", "manager");
    await makeUser(orgB, "empB", "employee");
    ctx.ownB = { ...ctx.mgrB!, permissions: new Set(PERMISSIONS) as Ctx["permissions"] };
  });

  afterAll(async () => {
    const ids = [orgA, orgB];
    for (const m of ["notification", "outboxEvent", "auditLog", "purchaseRequest", "approvalPolicy", "sequence"] as const)
      await (db[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: ids } } });
    await db.organizationMembership.deleteMany({ where: { organizationId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.organization.deleteMany({ where: { id: { in: ids } } });
    await db.tenant.delete({ where: { id: tenantId } });
    await db.$disconnect();
  });

  it("Einreichen benachrichtigt genau die Freigeber des ersten Schritts – nicht den Antragsteller, nicht andere Organisationen", async () => {
    const req = await createRequest(ctx.emp!, { title: "Notebook", lines: line("1000") });
    await runOutbox({ organizationId: orgA });
    const wanted = `Freigabe erforderlich: ${req.number}`;
    for (const who of ["mgr1", "mgr2", "own"]) expect(await titles(who)).toContain(wanted);
    for (const who of ["emp", "fin"]) expect(await titles(who)).not.toContain(wanted);
    expect(await titles("mgrB")).toEqual([]);
    expect(await unreadCount(ctx.mgr1!)).toBeGreaterThan(0);
  });

  it("Zwischenfreigabe benachrichtigt die Freigeber des nächsten Schritts; Endfreigabe Antragsteller und Einkauf", async () => {
    const req = await createRequest(ctx.emp!, { title: "Server", lines: line("6000") });
    await runOutbox({ organizationId: orgA });
    expect(await titles("fin")).not.toContain(`Freigabe erforderlich: ${req.number}`); // Schritt 1 gehört der Führungskraft

    await decideRequest(ctx.mgr1!, { requestId: req.id, decision: "APPROVE" });
    await runOutbox({ organizationId: orgA });
    expect(await titles("fin")).toContain(`Freigabe erforderlich: ${req.number}`); // Schritt 2: Finanzen

    await decideRequest(ctx.fin!, { requestId: req.id, decision: "APPROVE" });
    await runOutbox({ organizationId: orgA });
    expect(await titles("emp")).toContain(`Freigegeben: ${req.number}`);
    expect(await titles("fin")).toContain(`Bestellung anlegen: ${req.number}`);
  });

  it("Ablehnung benachrichtigt den Antragsteller", async () => {
    const req = await createRequest(ctx.emp!, { title: "Stühle", lines: line("100") });
    await decideRequest(ctx.mgr1!, { requestId: req.id, decision: "REJECT" });
    await runOutbox({ organizationId: orgA });
    expect(await titles("emp")).toContain(`Abgelehnt: ${req.number}`);
  });

  it("erneute Zustellung desselben Events erzeugt keine Doppel", async () => {
    const req = await createRequest(ctx.emp!, { title: "Doppelt", lines: line("10") });
    await runOutbox({ organizationId: orgA });
    const before = await db.notification.count({ where: { organizationId: orgA } });
    await db.outboxEvent.updateMany({ where: { organizationId: orgA, type: "purchase_request.submitted", payload: { path: ["requestId"], equals: req.id } }, data: { processedAt: null } });
    await runOutbox({ organizationId: orgA });
    expect(await db.notification.count({ where: { organizationId: orgA } })).toBe(before);
  });

  it("eigene Benachrichtigungen: lesen, als gelesen markieren; fremde sind nicht erreichbar", async () => {
    const mine = (await listNotifications(ctx.mgr1!))[0]!;
    await markRead(ctx.mgr1!, mine.id);
    expect((await db.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).not.toBeNull();
    await expect(markRead(ctx.mgr2!, mine.id)).rejects.toBeInstanceOf(NotFoundError); // anderer Benutzer, gleiche Organisation
    await expect(markRead(ctx.mgrB!, mine.id)).rejects.toBeInstanceOf(NotFoundError); // andere Organisation
    expect(await listNotifications(ctx.mgrB!)).toEqual([]);
  });

  describe("Freigaberegel (versioniert)", () => {
    it("nur mit org.settings.manage; ungültige Regeln werden abgelehnt", async () => {
      const steps = [{ key: "MANAGER", label: "Führungskraft", permission: "procurement.request.approve" }];
      await expect(publishPolicy(ctx.mgr1!, steps)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(readPolicy(ctx.fin!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(publishPolicy(ctx.own!, [])).rejects.toThrow();
      await expect(publishPolicy(ctx.own!, [{ ...steps[0], minAmount: "5" }])).rejects.toThrow();
    });

    it("neue Version gilt nur für neue Vorgänge; laufende behalten ihre Schritte", async () => {
      const before = await createRequest(ctx.emp!, { title: "Vor Änderung", lines: line("3000") });
      expect((await readPolicy(ctx.own!)).policy.version).toBe(1);

      const v2 = await publishPolicy(ctx.own!, [
        { key: "MANAGER", label: "Teamleitung", permission: "procurement.request.approve" },
        { key: "FINANCE", label: "Controlling", permission: "procurement.request.approve_finance", minAmount: "1000" },
      ]);
      expect(v2.version).toBe(2);

      const after = await createRequest(ctx.emp!, { title: "Nach Änderung", lines: line("3000") });
      const oldApprovals = await db.approval.findMany({ where: { requestId: before.id }, orderBy: { sequence: "asc" } });
      const newApprovals = await db.approval.findMany({ where: { requestId: after.id }, orderBy: { sequence: "asc" } });
      expect(oldApprovals.map((a) => a.stepKey)).toEqual(["MANAGER"]); // alte Regel: 3.000 < 5.000
      expect(newApprovals.map((a) => [a.stepKey, a.label])).toEqual([["MANAGER", "Teamleitung"], ["FINANCE", "Controlling"]]);
      expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id: before.id } })).policyVersion).toBe(1);
      expect((await db.purchaseRequest.findUniqueOrThrow({ where: { id: after.id } })).policyVersion).toBe(2);

      // Bezeichnung der neuen Regel erscheint in der Benachrichtigung
      await runOutbox({ organizationId: orgA });
      expect((await listNotifications(ctx.mgr1!)).some((n) => n.title === `Freigabe erforderlich: ${after.number}` && n.body?.includes("Teamleitung"))).toBe(true);

      const audit = await db.auditLog.findMany({ where: { organizationId: orgA, action: "approval_policy.publish" } });
      expect(audit).toHaveLength(1);
    });

    it("Regel einer Organisation beeinflusst andere nicht", async () => {
      expect((await readPolicy(ctx.ownB!)).policy.version).toBe(1);
      const req = await createRequest(ctx.empB!, { title: "B", lines: line("3000") });
      expect((await db.approval.findMany({ where: { requestId: req.id } })).map((a) => a.stepKey)).toEqual(["MANAGER"]);
    });
  });
});

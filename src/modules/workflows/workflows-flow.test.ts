import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { runOutbox } from "@/modules/events";
import { listWorkflowRuns, listWorkflows, publishWorkflow, setWorkflowEnabled, workflowHistory } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;

describe.skipIf(!hasDb)("Workflows: Regeln auf Ereignisse", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];

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
  }
  const def = (extra: Record<string, unknown> = {}) => ({
    key: "grosse-rechnung", name: "Große Ausgangsrechnung", eventType: "customer_invoice.issued",
    conditions: [{ field: "gross", op: "gt", value: "5000" }],
    actions: [{ type: "NOTIFY", recipient: { kind: "PERMISSION", permission: "finance.invoice.read" }, title: "Große Rechnung {{number}}: {{gross}} €", body: "Bitte prüfen" }],
    ...extra,
  });
  const emit = (org: string, type: string, payload: Record<string, unknown>) => db.outboxEvent.create({ data: { organizationId: org, type, payload: payload as never } });
  const notesFor = (org: string, userId: string) => db.notification.findMany({ where: { organizationId: org, userId, type: "workflow" } });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-WF" } })).id;
    orgA = await makeOrg("TEST-WF-A");
    orgB = await makeOrg("TEST-WF-B");
    for (const [l, r] of [["owner", "owner"], ["fin", "finance"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "ownerB", "owner");
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      for (const m of ["notification", "workflowRun", "workflowDefinition", "outboxEvent", "auditLog"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Veröffentlichen: nur mit Berechtigung, Versionen zählen hoch, Prüfungen, Mandantentrennung", async () => {
    await expect(publishWorkflow(c.fin!, def())).rejects.toBeInstanceOf(ForbiddenError); // Finanzen darf lesen, nicht verwalten
    await expect(publishWorkflow(c.owner!, def({ conditions: [{ field: "nix", op: "eq", value: "1" }] }))).rejects.toThrow(/gibt es bei diesem Ereignis nicht/);
    await expect(publishWorkflow(c.owner!, def({ eventType: "gibt.es.nicht" }))).rejects.toThrow(/Unbekanntes Ereignis/);
    const v1 = await publishWorkflow(c.owner!, def());
    expect(v1.version).toBe(1);
    const v2 = await publishWorkflow(c.owner!, def({ name: "Große Ausgangsrechnung (neu)", conditions: [{ field: "gross", op: "gt", value: "10000" }] }));
    expect(v2.version).toBe(2);
    expect((await listWorkflows(c.fin!)).map((w) => [w.key, w.version])).toEqual([["grosse-rechnung", 2]]); // nur die aktuelle Version
    expect((await workflowHistory(c.fin!, "grosse-rechnung")).map((w) => w.version)).toEqual([2, 1]);
    await expect(listWorkflows(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listWorkflows(c.ownerB!)).toEqual([]);
    await expect(workflowHistory(c.ownerB!, "grosse-rechnung")).rejects.toBeInstanceOf(NotFoundError);
    // Version 1 bleibt unverändert
    expect((await db.workflowDefinition.findFirstOrThrow({ where: { organizationId: orgA, key: "grosse-rechnung", version: 1 } })).conditions).toEqual([{ field: "gross", op: "gt", value: "5000" }]);
  });

  it("Ereignis löst nur aus, wenn die Bedingungen der aktuellen Version zutreffen; Benachrichtigung geht an Berechtigte", async () => {
    const small = await emit(orgA, "customer_invoice.issued", { number: "AR-1", gross: "6000", href: "/finance/out/x", actorUserId: c.emp!.userId });
    await runOutbox({ organizationId: orgA });
    // Version 2 (> 10.000): 6.000 trifft nicht zu
    expect(await notesFor(orgA, c.fin!.userId)).toHaveLength(0);
    let runs = await db.workflowRun.findMany({ where: { organizationId: orgA, eventId: small.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ matched: false, notifications: 0 });

    const big = await emit(orgA, "customer_invoice.issued", { number: "AR-2", gross: "12000.50", href: "/finance/out/y", actorUserId: c.emp!.userId });
    await runOutbox({ organizationId: orgA });
    const fin = await notesFor(orgA, c.fin!.userId), own = await notesFor(orgA, c.owner!.userId);
    expect(fin).toHaveLength(1);
    expect(own).toHaveLength(1);
    expect(fin[0]).toMatchObject({ title: "Große Rechnung AR-2: 12000.50 €", body: "Bitte prüfen", href: "/finance/out/y" });
    expect(await notesFor(orgA, c.emp!.userId)).toHaveLength(0); // ohne Berechtigung
    const bigRuns = await db.workflowRun.findMany({ where: { organizationId: orgA, eventId: big.id }, include: { definition: true } });
    expect(bigRuns[0]).toMatchObject({ matched: true, notifications: 2 });
    expect(bigRuns[0]!.definition.version).toBe(2); // das Protokoll nennt die ausgelöste Version
    expect((await listWorkflowRuns(c.fin!)).length).toBeGreaterThanOrEqual(2);
  });

  it("Mandantentrennung: Ereignisse anderer Organisationen lösen keine Regeln aus", async () => {
    const before = (await db.notification.count({ where: { organizationId: orgA, type: "workflow" } }));
    await emit(orgB, "customer_invoice.issued", { number: "AR-B", gross: "99999", actorUserId: c.ownerB!.userId });
    await runOutbox({ organizationId: orgB });
    expect(await db.notification.count({ where: { organizationId: orgA, type: "workflow" } })).toBe(before);
    expect(await db.workflowRun.count({ where: { organizationId: orgB } })).toBe(0);
  });

  it("Ausschalten als neue Version; Auslöser für die auslösende Person; keine Doppelzustellung", async () => {
    await expect(setWorkflowEnabled(c.fin!, "grosse-rechnung", false)).rejects.toBeInstanceOf(ForbiddenError);
    const off = await setWorkflowEnabled(c.owner!, "grosse-rechnung", false);
    expect(off).toMatchObject({ version: 3, enabled: false });
    await expect(setWorkflowEnabled(c.owner!, "grosse-rechnung", false)).rejects.toBeInstanceOf(ConflictError);
    const e = await emit(orgA, "customer_invoice.issued", { number: "AR-3", gross: "50000" });
    await runOutbox({ organizationId: orgA });
    expect(await db.workflowRun.count({ where: { organizationId: orgA, eventId: e.id } })).toBe(0); // ausgeschaltet: kein Eintrag

    await publishWorkflow(c.owner!, { key: "eigene-meldung", name: "Rückmeldung an die auslösende Person", eventType: "stock.below_reorder", conditions: [{ field: "onHand", op: "lte", value: "0" }], actions: [{ type: "NOTIFY", recipient: { kind: "ACTOR" }, title: "Artikel {{item}} ist leer" }] });
    const ev = await emit(orgA, "stock.below_reorder", { item: "A1", onHand: "0", reorderLevel: "5", actorUserId: c.emp!.userId });
    await runOutbox({ organizationId: orgA });
    expect((await notesFor(orgA, c.emp!.userId)).map((n) => n.title)).toEqual(["Artikel A1 ist leer"]);

    // dasselbe Ereignis ein zweites Mal verarbeiten (Wiederzustellung): keine zweite Benachrichtigung, kein zweiter Protokolleintrag
    const { workflowHandlers } = await import("./handlers");
    const msg = { id: ev.id, organizationId: orgA, type: "stock.below_reorder", payload: ev.payload, attempts: 0 };
    await db.$transaction((tx) => workflowHandlers["stock.below_reorder"]![0]!(msg as never, tx));
    expect(await notesFor(orgA, c.emp!.userId)).toHaveLength(1);
    expect(await db.workflowRun.count({ where: { organizationId: orgA, eventId: ev.id } })).toBe(1);
  });

  it("Grenzen: Quelltext in Texten bleibt Text; unbekannte Felder werden nicht ersetzt; fremde Links werden verworfen", async () => {
    await publishWorkflow(c.owner!, { key: "text", name: "Text", eventType: "quote.accepted", conditions: [], actions: [{ type: "NOTIFY", recipient: { kind: "PERMISSION", permission: "finance.invoice.read" }, title: "{{number}} {{actorUserId}} {{secret}}" }] });
    await emit(orgA, "quote.accepted", { number: "<img src=x onerror=alert(1)>", gross: "1", secret: "geheim", actorUserId: "u-1", href: "https://evil.example/x" });
    await runOutbox({ organizationId: orgA });
    const n = (await notesFor(orgA, c.fin!.userId)).find((x) => x.title.includes("<img"))!;
    expect(n.title).toBe("<img src=x onerror=alert(1)>  "); // actorUserId und secret nicht deklariert
    expect(n.href).toBeNull();
  });
});

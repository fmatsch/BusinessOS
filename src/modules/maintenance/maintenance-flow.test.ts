import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { adjustStock, createItem, getItem } from "@/modules/inventory/service";
import { cancelMaintenanceOrder, completeMaintenanceOrder, createMaintenanceObject, createMaintenancePlan, generateDueOrders, getMaintenanceOrder, listMaintenanceObjects, listMaintenanceOrders, listMaintenancePlans, reportIssue, setMaintenanceObjectActive, setMaintenancePlanActive, startMaintenanceOrder } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Instandhaltung: Objekte, Wartungspläne, Aufträge", () => {
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
  }

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Maintenance" } })).id;
    orgA = await makeOrg("TEST-MT-A");
    orgB = await makeOrg("TEST-MT-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    I.part = (await createItem(c.fin!, { number: "ET1", name: "Keilriemen" })).id;
    await adjustStock(c.fin!, { itemId: I.part, counted: "5", reason: "Anfangsbestand" });
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.maintenancePart.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.maintenanceOrder.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.maintenancePlan.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.maintenanceObject.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "item", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Objekte und Wartungspläne: Berechtigung, Prüfungen, Mandantentrennung", async () => {
    await expect(createMaintenanceObject(c.mgr!, { name: "Presse" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createMaintenanceObject(c.fin!, { name: "" })).rejects.toThrow();
    await expect(createMaintenanceObject(c.fin!, { name: "Presse", fixedAssetId: "fremd" })).rejects.toBeInstanceOf(NotFoundError);
    const o = await createMaintenanceObject(c.fin!, { name: "Presse 1", location: "Halle 2" });
    I.obj = o.id;
    expect(o.number).toMatch(/^EQ-\d{4}-0001$/);
    expect((await listMaintenanceObjects(c.emp!)).map((x) => x.name)).toEqual(["Presse 1"]); // Mitarbeiter sehen die Objekte zum Melden
    expect(await listMaintenanceObjects(c.finB!)).toEqual([]);
    await expect(createMaintenancePlan(c.fin!, { objectId: I.obj, title: "Ölwechsel", intervalUnit: "MONTHS", intervalValue: 0, firstDueOn: day(0) })).rejects.toThrow();
    await expect(createMaintenancePlan(c.fin!, { objectId: "fremd", title: "Ölwechsel", intervalUnit: "MONTHS", intervalValue: 3, firstDueOn: day(0) })).rejects.toBeInstanceOf(NotFoundError);
    const p = await createMaintenancePlan(c.fin!, { objectId: I.obj, title: "Ölwechsel", instructions: "Öl 5 l, Filter", intervalUnit: "MONTHS", intervalValue: 3, firstDueOn: day(-2) });
    I.plan = p.id;
    const plans = await listMaintenancePlans(c.mgr!);
    expect(plans[0]!.daysUntilDue).toBe(-2);
    await expect(listMaintenancePlans(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listMaintenancePlans(c.finB!)).toEqual([]);
  });

  it("Fällige Pläne erzeugen genau einen Auftrag (wiederholbar); nur bis zum Stichtag", async () => {
    await expect(generateDueOrders(c.mgr!)).rejects.toBeInstanceOf(ForbiddenError);
    const early = await createMaintenancePlan(c.fin!, { objectId: I.obj, title: "Sicherheitsprüfung", intervalUnit: "DAYS", intervalValue: 30, firstDueOn: day(20) });
    const first = await generateDueOrders(c.fin!);
    expect(first.created).toHaveLength(1); // nur der überfällige Ölwechsel
    expect((await generateDueOrders(c.fin!)).created).toEqual([]); // wiederholbar
    const later = await generateDueOrders(c.fin!, day(25));
    expect(later.created).toHaveLength(1);
    I.early = early.id;
    const orders = await listMaintenanceOrders(c.mgr!);
    expect(orders.map((o) => [o.kind, o.status])).toEqual([["PREVENTIVE", "OPEN"], ["PREVENTIVE", "OPEN"]]);
    I.order = orders.find((o) => o.title.startsWith("Ölwechsel"))!.id;
    I.order2 = orders.find((o) => o.title.startsWith("Sicherheit"))!.id;
    await expect(setMaintenancePlanActive(c.mgr!, I.plan!, false)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Störung melden (auch Mitarbeiter), Prioritäten sortieren, Auftrag abschließen mit Ersatzteilen, Plan rückt weiter", async () => {
    await expect(reportIssue(c.emp!, { objectId: I.obj, title: "x" })).rejects.toThrow();
    await expect(reportIssue(c.emp!, { objectId: "fremd", title: "Presse leckt" })).rejects.toBeInstanceOf(NotFoundError);
    const rep = await reportIssue(c.emp!, { objectId: I.obj, title: "Presse leckt", description: "Öl unter der Maschine", priority: "URGENT" });
    expect(rep.number).toMatch(/^IH-\d{4}-0003$/);
    await expect(listMaintenanceOrders(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listMaintenanceOrders(c.mgr!))[0]!.id).toBe(rep.id); // dringend zuerst

    await expect(completeMaintenanceOrder(c.emp!, I.order!, { report: "fertig", minutesSpent: 10, doneOn: day(0) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(completeMaintenanceOrder(c.mgr!, I.order!, { report: "fertig", minutesSpent: 10, doneOn: day(1) })).rejects.toThrow(/Zukunft/);
    await expect(completeMaintenanceOrder(c.mgr!, I.order!, { report: "x", minutesSpent: 10, doneOn: day(0) })).rejects.toThrow(/berichten/);
    // zu viele Ersatzteile: alles oder nichts
    await expect(completeMaintenanceOrder(c.mgr!, I.order!, { report: "Öl gewechselt", minutesSpent: 45, doneOn: day(0), parts: [{ itemId: I.part, quantity: "9" }] })).rejects.toThrow(/Nicht genug Bestand/);
    expect((await getMaintenanceOrder(c.mgr!, I.order!)).status).toBe("OPEN");
    await startMaintenanceOrder(c.mgr!, I.order!);
    await expect(startMaintenanceOrder(c.mgr!, I.order!)).rejects.toBeInstanceOf(ConflictError);
    await completeMaintenanceOrder(c.mgr!, I.order!, { report: "Öl gewechselt", minutesSpent: 45, doneOn: day(0), parts: [{ itemId: I.part, quantity: "2" }] });
    expect((await getItem(c.fin!, I.part!)).onHand.toString()).toBe("3");
    const done = await getMaintenanceOrder(c.mgr!, I.order!);
    expect([done.status, done.minutesSpent, done.parts.map((p) => `${p.item.number}:${p.quantity}`)]).toEqual(["DONE", 45, ["ET1:2"]]);
    // Plan: nächste Fälligkeit 3 Monate nach dem Erledigungsdatum
    const plan = (await listMaintenancePlans(c.fin!)).find((p) => p.id === I.plan)!;
    expect(plan.lastDoneOn!.toISOString().slice(0, 10)).toBe(day(0));
    expect(plan.daysUntilDue).toBeGreaterThan(80);
    // abgeschlossene Aufträge sind unveränderlich
    await expect(completeMaintenanceOrder(c.mgr!, I.order!, { report: "nochmal", minutesSpent: 1, doneOn: day(0) })).rejects.toThrow(/bereits abgeschlossen/);
    await expect(db.maintenanceOrder.update({ where: { id: I.order! }, data: { title: "x" } })).rejects.toThrow(/unveränderlich/);
    await expect(db.maintenancePart.updateMany({ where: { orderId: I.order! }, data: { quantity: "9" } })).rejects.toThrow(/append-only/);
    // Fremdzugriff
    await expect(completeMaintenanceOrder(c.finB!, I.order2!, { report: "fremd", minutesSpent: 1, doneOn: day(0) })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMaintenanceOrder(c.finB!, I.order2!)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listMaintenanceOrders(c.finB!)).toEqual([]);
  });

  it("Stornieren, inaktive Objekte erzeugen keine Aufträge", async () => {
    await expect(cancelMaintenanceOrder(c.mgr!, I.order2!)).rejects.toBeInstanceOf(ForbiddenError);
    await cancelMaintenanceOrder(c.fin!, I.order2!);
    await expect(cancelMaintenanceOrder(c.fin!, I.order2!)).rejects.toBeInstanceOf(ConflictError);
    await setMaintenanceObjectActive(c.fin!, I.obj!, false);
    expect((await generateDueOrders(c.fin!, day(400))).created).toEqual([]);
    await expect(reportIssue(c.emp!, { objectId: I.obj, title: "Presse klemmt" })).rejects.toBeInstanceOf(NotFoundError);
    await setMaintenanceObjectActive(c.fin!, I.obj!, true);
    expect((await generateDueOrders(c.fin!, day(400))).created.length).toBeGreaterThan(0);
  });
});

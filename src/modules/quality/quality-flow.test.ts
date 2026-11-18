import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createItem } from "@/modules/inventory/service";
import { activateInspectionPlan, closeNonConformance, createInspection, createInspectionPlan, createNonConformance, decideInspection, deleteInspectionPlanDraft, getInspection, listInspectionPlans, listInspections, listNonConformances, recordInspectionResult, updateNonConformance } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;

describe.skipIf(!hasDb)("Qualitätsmanagement: Prüfpläne, Prüflose, Abweichungen", () => {
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
  const chars = [
    { name: "Durchmesser", kind: "QUANTITATIVE", unit: "mm", minValue: "9.9", maxValue: "10.1" },
    { name: "Sichtprüfung", kind: "QUALITATIVE" },
  ];

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Quality" } })).id;
    orgA = await makeOrg("TEST-QM-A");
    orgB = await makeOrg("TEST-QM-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    I.item = (await createItem(c.fin!, { number: "Q1", name: "Bolzen" })).id;
    I.itemB = (await createItem(c.finB!, { number: "QB", name: "Fremd" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.inspectionResult.deleteMany({ where: { inspection: { organizationId: { in: orgs } } } });
      await tx.inspection.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.nonConformance.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.inspectionCharacteristic.deleteMany({ where: { plan: { organizationId: { in: orgs } } } });
      await tx.inspectionPlan.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "item", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Prüfplan: Berechtigung, Prüfungen der Merkmale, Aktivierung sperrt, nur ein aktiver", async () => {
    await expect(createInspectionPlan(c.mgr!, { itemId: I.item, characteristics: chars })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createInspectionPlan(c.fin!, { itemId: I.item, characteristics: [] })).rejects.toThrow(/Prüfmerkmal/);
    await expect(createInspectionPlan(c.fin!, { itemId: I.item, characteristics: [{ name: "x", kind: "QUANTITATIVE" }] })).rejects.toThrow(/Grenze/);
    await expect(createInspectionPlan(c.fin!, { itemId: I.item, characteristics: [{ name: "x", kind: "QUANTITATIVE", minValue: "5", maxValue: "1" }] })).rejects.toThrow(/untere Grenze/);
    await expect(createInspectionPlan(c.fin!, { itemId: I.item, characteristics: [{ name: "x", kind: "QUALITATIVE", minValue: "1" }] })).rejects.toThrow(/keine Grenzen/);
    await expect(createInspectionPlan(c.fin!, { itemId: I.itemB, characteristics: chars })).rejects.toBeInstanceOf(NotFoundError);
    const p1 = await createInspectionPlan(c.fin!, { itemId: I.item, characteristics: chars });
    expect(p1.version).toBe(1);
    await expect(createInspection(c.mgr!, { itemId: I.item, quantity: "10" })).rejects.toThrow(/keinen aktiven Prüfplan/);
    await activateInspectionPlan(c.fin!, p1.id);
    await expect(activateInspectionPlan(c.fin!, p1.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(db.inspectionCharacteristic.updateMany({ where: { planId: p1.id }, data: { maxValue: "99" } })).rejects.toThrow(/unveränderlich/);
    const p2 = await createInspectionPlan(c.fin!, { itemId: I.item, characteristics: chars });
    await activateInspectionPlan(c.fin!, p2.id);
    expect((await listInspectionPlans(c.mgr!)).map((p) => `${p.version}:${p.status}`).sort()).toEqual(["1:ARCHIVED", "2:ACTIVE"]);
    await expect(deleteInspectionPlanDraft(c.fin!, p2.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await listInspectionPlans(c.finB!)).toEqual([]);
    await expect(listInspectionPlans(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Prüflos: Ergebnisse werden bewertet, Entscheid nur vollständig; Ablehnung legt eine Abweichung an", async () => {
    await expect(createInspection(c.emp!, { itemId: I.item, quantity: "10" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createInspection(c.mgr!, { itemId: I.item, quantity: "0" })).rejects.toThrow();
    const insp = await createInspection(c.mgr!, { itemId: I.item, quantity: "100", batchNumber: "C-7", source: "GOODS_RECEIPT", reference: "WE-1" });
    expect(insp.number).toMatch(/^QP-\d{4}-0001$/);
    const full = await getInspection(c.mgr!, insp.id);
    const [dia, vis] = full.characteristics;
    await expect(decideInspection(c.mgr!, insp.id, { decision: "ACCEPT" })).rejects.toBeInstanceOf(ForbiddenError); // Führungskraft prüft, entscheidet nicht
    await expect(decideInspection(c.fin!, insp.id, { decision: "ACCEPT" })).rejects.toThrow(/alle Merkmale/);
    await expect(recordInspectionResult(c.mgr!, insp.id, { characteristicId: dia!.id })).rejects.toThrow(/Messwert/);
    await expect(recordInspectionResult(c.mgr!, insp.id, { characteristicId: vis!.id, value: "1", passed: true })).rejects.toThrow(/keinen Messwert/);
    await expect(recordInspectionResult(c.mgr!, insp.id, { characteristicId: "fremd", value: "10" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await recordInspectionResult(c.mgr!, insp.id, { characteristicId: dia!.id, value: "10.2" })).toEqual({ passed: false }); // außerhalb
    expect(await recordInspectionResult(c.mgr!, insp.id, { characteristicId: dia!.id, value: "10.0" })).toEqual({ passed: true }); // korrigiert
    await recordInspectionResult(c.mgr!, insp.id, { characteristicId: vis!.id, passed: "false", note: "Kratzer" });
    await expect(decideInspection(c.fin!, insp.id, { decision: "ACCEPT" })).rejects.toThrow(/Sonderfreigabe/);
    await expect(decideInspection(c.fin!, insp.id, { decision: "ACCEPT", deviation: true, note: "kurz" })).rejects.toThrow(/Begründung/);
    const r = await decideInspection(c.fin!, insp.id, { decision: "REJECT", note: "Sichtmangel" });
    expect(r.status).toBe("REJECTED");
    expect(r.nonConformance).toMatch(/^NC-\d{4}-0001$/);
    const after = await getInspection(c.mgr!, insp.id);
    expect(after.status).toBe("REJECTED");
    expect(after.nonConformances).toHaveLength(1);
    expect((await db.nonConformance.findFirstOrThrow({ where: { organizationId: orgA } })).description).toContain("Sichtprüfung");
    await expect(decideInspection(c.fin!, insp.id, { decision: "REJECT" })).rejects.toThrow(/bereits entschieden/);
    await expect(recordInspectionResult(c.mgr!, insp.id, { characteristicId: dia!.id, value: "10" })).rejects.toThrow(/bereits entschieden/);
    // auch auf Datenbankebene unveränderlich
    await expect(db.inspectionResult.updateMany({ where: { inspectionId: insp.id }, data: { passed: true } })).rejects.toThrow(/unveränderlich/);
    await expect(db.inspection.update({ where: { id: insp.id }, data: { status: "ACCEPTED" } })).rejects.toThrow(/unveränderlich/);
    expect((await listInspections(c.mgr!)).map((x) => x.id)).toContain(insp.id);
    expect(await listInspections(c.finB!)).toEqual([]);
    await expect(getInspection(c.finB!, insp.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordInspectionResult(c.finB!, insp.id, { characteristicId: dia!.id, value: "10" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Prüflos: alles bestanden → Annahme ohne Abweichung; Ablehnen nicht möglich; Sonderfreigabe mit Begründung", async () => {
    const ok = await createInspection(c.mgr!, { itemId: I.item, quantity: "50" });
    const [dia, vis] = (await getInspection(c.mgr!, ok.id)).characteristics;
    await recordInspectionResult(c.mgr!, ok.id, { characteristicId: dia!.id, value: "10.05" });
    await recordInspectionResult(c.mgr!, ok.id, { characteristicId: vis!.id, passed: true });
    await expect(decideInspection(c.fin!, ok.id, { decision: "REJECT" })).rejects.toThrow(/nicht möglich/);
    expect(await decideInspection(c.fin!, ok.id, { decision: "ACCEPT" })).toEqual({ status: "ACCEPTED", nonConformance: null });

    const dev = await createInspection(c.mgr!, { itemId: I.item, quantity: "5" });
    const [d2, v2] = (await getInspection(c.mgr!, dev.id)).characteristics;
    await recordInspectionResult(c.mgr!, dev.id, { characteristicId: d2!.id, value: "10.15" });
    await recordInspectionResult(c.mgr!, dev.id, { characteristicId: v2!.id, passed: true });
    const r = await decideInspection(c.fin!, dev.id, { decision: "ACCEPT", deviation: true, note: "Kunde akzeptiert Toleranz" });
    expect(r.status).toBe("ACCEPTED");
    expect(r.nonConformance).toMatch(/^NC-\d{4}-0002$/);
    expect((await getInspection(c.mgr!, dev.id)).deviation).toBe(true);
  });

  it("Abweichung: Ursache und Maßnahme sind Pflicht zum Schließen; geschlossene sind unveränderlich", async () => {
    await expect(createNonConformance(c.mgr!, { description: "Verpackung beschädigt" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createNonConformance(c.fin!, { description: "kurz" })).rejects.toThrow(/beschreiben/);
    const nc = await createNonConformance(c.fin!, { description: "Verpackung beschädigt", itemId: I.item });
    await expect(closeNonConformance(c.fin!, nc.id)).rejects.toThrow(/Ursache und Maßnahme/);
    await updateNonConformance(c.fin!, nc.id, { cause: "Transportschaden", action: "Verpackung geändert" });
    await expect(closeNonConformance(c.finB!, nc.id)).rejects.toBeInstanceOf(NotFoundError);
    await closeNonConformance(c.fin!, nc.id);
    await expect(closeNonConformance(c.fin!, nc.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(updateNonConformance(c.fin!, nc.id, { cause: "x", action: "y" })).rejects.toBeInstanceOf(ConflictError);
    await expect(db.nonConformance.update({ where: { id: nc.id }, data: { description: "geändert" } })).rejects.toThrow(/unveränderlich/);
    expect((await listNonConformances(c.mgr!)).length).toBe(3);
    expect(await listNonConformances(c.finB!)).toEqual([]);
  });
});

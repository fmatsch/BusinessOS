import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createAccount, listAccounts } from "@/modules/finance/service";
import { createAsset, disposeAsset, listAssets, runDepreciation } from "./assets";
import { activateGl, closePeriod } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const now = new Date();
const ymOf = (back: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, iso: d.toISOString().slice(0, 10) }; };

describe.skipIf(!hasDb)("Anlagenbuchhaltung", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];
  const A: Record<string, string> = {};

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
    tenantId = (await db.tenant.create({ data: { name: "TEST-AS" } })).id;
    orgA = await makeOrg("TEST-AS-A");
    orgB = await makeOrg("TEST-AS-B");
    for (const [l, r] of [["fin", "finance"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    await createAccount(c.fin!, { number: "0300", name: "Betriebs- und Geschäftsausstattung", type: "GL" });
    await createAccount(c.fin!, { number: "7010", name: "AfA", type: "GL" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    A.asset = acc["0300"]!; A.afa = acc["7010"]!;
    await activateGl(c.fin!, { startDate: `${ymOf(6).y}-01-01` });
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.assetDepreciation.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.journalLine.deleteMany({ where: { entry: { organizationId: { in: orgs } } } });
      for (const m of ["journalEntry", "accountingPeriod", "fixedAsset", "glSettings", "auditLog", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Anlegen: Berechtigung, Prüfungen, Nummer, Mandantentrennung", async () => {
    const base = { name: "Server", acquiredOn: ymOf(2).iso, cost: "1200", usefulLifeMonths: 12, assetAccountId: A.asset, depreciationAccountId: A.afa };
    await expect(createAsset(c.emp!, base)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAsset(c.fin!, { ...base, cost: "0" })).rejects.toThrow(/Anschaffungskosten/);
    await expect(createAsset(c.fin!, { ...base, residualValue: "1200" })).rejects.toThrow(/Restwert/);
    await expect(createAsset(c.fin!, { ...base, usefulLifeMonths: 0 })).rejects.toThrow(/Nutzungsdauer/);
    await expect(createAsset(c.fin!, { ...base, assetAccountId: "fremd" })).rejects.toBeInstanceOf(NotFoundError);
    const a = await createAsset(c.fin!, base);
    A.id = a.id;
    expect(a.number).toMatch(/^AV-\d{4}-0001$/);
    expect((await listAssets(c.finB!))).toEqual([]);
  });

  it("Abschreibung: je Monat einmal, ausgeglichene Buchung, Buchwert, noch nicht abgelaufene Monate abgewiesen", async () => {
    const m2 = ymOf(2), m1 = ymOf(1);
    await expect(runDepreciation(c.emp!, m2.y, m2.m)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runDepreciation(c.fin!, ymOf(0).y, ymOf(0).m)).rejects.toThrow(/noch nicht abgelaufen/);
    expect(await runDepreciation(c.fin!, m2.y, m2.m)).toMatchObject({ posted: 1 });
    expect((await runDepreciation(c.fin!, m2.y, m2.m)).posted).toBe(0); // wiederholbar
    await runDepreciation(c.fin!, m1.y, m1.m);
    const entries = await db.journalEntry.findMany({ where: { organizationId: orgA, source: "DEPRECIATION" }, include: { lines: true } });
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.lines.map((l) => [l.accountId === A.afa ? "afa" : "anlage", String(l.debit), String(l.credit)]).sort()).toEqual([["afa", "100", "0"], ["anlage", "0", "100"]]);
    const [row] = await listAssets(c.fin!);
    expect(row!.bookedDepreciation.toString()).toBe("200");
    expect(row!.bookedBookValue.toString()).toBe("1000");
    expect(row!.bookValue.toString()).toBe(row!.bookedBookValue.minus(100).toString()); // rechnerisch inklusive laufendem Monat
  });

  it("geschlossene Periode, Ausscheiden", async () => {
    const m3 = ymOf(3);
    await closePeriod(c.fin!, { year: m3.y, month: m3.m });
    // nichts zu buchen vor der Anschaffung – kein Fehler
    expect((await runDepreciation(c.fin!, m3.y, m3.m)).posted).toBe(0);
    const early = await createAsset(c.fin!, { name: "Früh", acquiredOn: m3.iso, cost: "300", usefulLifeMonths: 3, assetAccountId: A.asset, depreciationAccountId: A.afa });
    await expect(runDepreciation(c.fin!, m3.y, m3.m)).rejects.toThrow(/abgeschlossen/);
    await disposeAsset(c.fin!, early.id, ymOf(1).iso);
    await expect(disposeAsset(c.fin!, early.id, ymOf(1).iso)).rejects.toBeInstanceOf(ConflictError);
    await db.accountingPeriod.updateMany({ where: { organizationId: orgA, year: m3.y, month: m3.m }, data: { status: "OPEN" } });
    expect((await runDepreciation(c.fin!, ymOf(1).y, ymOf(1).m)).posted).toBe(0); // ausgeschieden und bereits abgeschrieben
  });
});

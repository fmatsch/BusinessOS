import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createAccount, createCustomer, createTaxCode, getCustomerInvoice, listAccounts, setCustomerAccounts } from "@/modules/finance/service";
import { billProject, bookProjectTime, createProject, getProject, listProjects, reverseProjectTime, setProjectStatus } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const dayIso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)("Projekte: Stunden buchen und abrechnen", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const userIds: string[] = [];
  const ids: Record<string, string> = {};

  async function makeOrg(name: string) {
    const org = await db.organization.create({ data: { tenantId, name } });
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await db.role.create({ data: { organizationId: org.id, key, name: def.name, system: true } });
      const perms = await db.permission.findMany({ where: { key: { in: [...def.permissions] } } });
      await db.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
    return org.id;
  }
  async function makeUser(org: string, label: string, role: RoleKey, withEmployee = true) {
    const user = await db.user.create({ data: { email: `${label}-${org}@test.invalid`, name: label, passwordHash: await bcrypt.hash("x", 4) } });
    userIds.push(user.id);
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    if (withEmployee) await db.employee.create({ data: { organizationId: org, number: `E-${label}`, firstName: label, lastName: "Test", userId: user.id } });
    c[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
  }
  const project = (extra: Record<string, unknown> = {}) => createProject(c.mgr!, { name: "Website", customerId: ids.customer, hourlyRate: "120", budgetHours: "10", ...extra });
  const bill = (projectId: string, extra: Record<string, unknown> = {}) => billProject(c.fin!, { projectId, upTo: dayIso(0), taxCodeId: ids.ust20, ...extra });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Projects" } })).id;
    orgA = await makeOrg("TEST-PJ-A");
    orgB = await makeOrg("TEST-PJ-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"], ["emp2", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgA, "noprofile", "employee", false);
    await makeUser(orgB, "finB", "finance");
    await createAccount(c.fin!, { number: "4000", name: "Erlöse", type: "GL" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    ids.ust20 = (await createTaxCode(c.fin!, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    ids.customer = (await createCustomer(c.fin!, { number: "K1", name: "Kunde GmbH" })).id;
    await setCustomerAccounts(c.fin!, ids.customer!, { uid: "", accountId: acc["20001"], lineAccountId: acc["4000"] });
    ids.customerB = (await createCustomer(c.finB!, { number: "KB", name: "Kunde B" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.projectBillingItem.deleteMany({ where: { billing: { organizationId: { in: orgs } } } });
      await tx.projectBilling.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.projectTime.deleteMany({ where: { organizationId: { in: orgs }, kind: "REVERSAL" } });
      await tx.projectTime.deleteMany({ where: { organizationId: { in: orgs } } });
      for (const m of ["outboxEvent", "auditLog", "project", "customerInvoice", "customer", "taxCode", "account", "sequence", "employee"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Projekte anlegen: Berechtigung, Prüfungen, Nummernkreis, Satz nur für Berechtigte sichtbar", async () => {
    await expect(createProject(c.emp!, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(project({ customerId: ids.customerB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(project({ hourlyRate: "0" })).rejects.toThrow(/Stundensatz/);
    await expect(project({ startsOn: "2027-03-02", endsOn: "2027-03-01" })).rejects.toThrow(/Ende/);
    const p = await project();
    expect(p.number).toMatch(/^PJ-\d{4}-\d{4}$/);
    ids.p = p.id;
    const asEmp = (await listProjects(c.emp!)).find((x) => x.id === p.id)!;
    expect(asEmp.hourlyRate).toBeNull(); // Mitarbeiter sehen den Verrechnungssatz nicht
    expect(String((await listProjects(c.mgr!)).find((x) => x.id === p.id)!.hourlyRate)).toBe("120");
    await expect(listProjects(c.finB!).then((l) => l.length)).resolves.toBe(0);
    await expect(getProject(c.finB!, p.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Zeiten buchen: Prüfungen, Tagesgrenze 24 h, Gegenbuchung, Sichtbarkeit", async () => {
    await expect(bookProjectTime(c.noprofile!, { projectId: ids.p, workDate: dayIso(0), hours: "1" })).rejects.toThrow(/Mitarbeiterprofil/);
    await expect(bookProjectTime(c.emp!, { projectId: ids.p, workDate: dayIso(1), hours: "1" })).rejects.toThrow(/Zukunft/);
    await expect(bookProjectTime(c.emp!, { projectId: ids.p, workDate: dayIso(0), hours: "25" })).rejects.toThrow();
    await expect(bookProjectTime(c.emp!, { projectId: "fremd", workDate: dayIso(0), hours: "1" })).rejects.toBeInstanceOf(NotFoundError);
    const a = await bookProjectTime(c.emp!, { projectId: ids.p, workDate: dayIso(-3), hours: "2.5", note: "Konzept" });
    expect(a.minutes).toBe(150);
    await bookProjectTime(c.emp2!, { projectId: ids.p, workDate: dayIso(-3), hours: "1" });
    await expect(bookProjectTime(c.emp!, { projectId: ids.p, workDate: dayIso(-3), hours: "22" })).rejects.toThrow(/24 Stunden/);

    const mine = await getProject(c.emp!, ids.p!);
    expect(mine.times).toHaveLength(1); // nur die eigenen Buchungen
    const all = await getProject(c.mgr!, ids.p!);
    expect(all.times).toHaveLength(2);
    expect(all).toMatchObject({ bookedMinutes: 210, billedMinutes: 0, budgetUsed: 35 });

    await expect(reverseProjectTime(c.emp2!, a.id, "Fehler")).rejects.toBeInstanceOf(ForbiddenError); // fremde Buchung
    await expect(reverseProjectTime(c.emp!, a.id, "x")).rejects.toThrow(/Begründung/);
    await reverseProjectTime(c.emp!, a.id, "Falsches Projekt");
    await expect(reverseProjectTime(c.emp!, a.id, "nochmal")).rejects.toBeInstanceOf(ConflictError);
    expect((await getProject(c.mgr!, ids.p!)).bookedMinutes).toBe(60);
    await expect(db.projectTime.update({ where: { id: a.id }, data: { minutes: 1 } })).rejects.toThrow(); // Journal
    await bookProjectTime(c.emp!, { projectId: ids.p, workDate: dayIso(-3), hours: "2.5" }); // Tag wieder frei (Gegenbuchung zählt)
  });

  it("Abrechnung: Rechnungsentwurf mit Stunden × Satz, jede Zeit nur einmal, danach keine Korrektur", async () => {
    await expect(billProject(c.mgr!, { projectId: ids.p, upTo: dayIso(0), taxCodeId: ids.ust20 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(bill(ids.p!, { upTo: dayIso(1) })).rejects.toThrow(/Zukunft/);
    await expect(bill(ids.p!, { upTo: dayIso(-10) })).rejects.toThrow(/keine abrechenbaren/); // vor allen Buchungen
    const r = await bill(ids.p!);
    expect(r.minutes).toBe(210); // 1 h + 2,5 h
    expect(r.net.toString()).toBe("420"); // 3,5 h × 120
    const inv = await getCustomerInvoice(c.fin!, r.invoiceId);
    expect(inv).toMatchObject({ status: "DRAFT", kind: "INVOICE" });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]!.quantity.toString()).toBe("3.5");
    expect(String(inv.netTotal)).toBe("420");
    expect(inv.note).toContain("PJ-");

    await expect(bill(ids.p!)).rejects.toThrow(/keine abrechenbaren/); // nichts doppelt
    const d = await getProject(c.fin!, ids.p!);
    expect(d).toMatchObject({ billedMinutes: 210, openMinutes: 0 });
    expect(d.billings).toHaveLength(1);
    const billed = d.times.find((t) => t.kind === "WORK" && !t.reversed)!;
    expect(billed.billed).toBe(true);
    await expect(reverseProjectTime(c.mgr!, billed.id, "zu spät")).rejects.toThrow(/abgerechnet/);
    await expect(db.projectBilling.update({ where: { id: d.billings[0]!.id }, data: { minutes: 1 } })).rejects.toThrow();
    // neue Zeit → zweiter Lauf nur mit der neuen Zeit
    await bookProjectTime(c.emp2!, { projectId: ids.p, workDate: dayIso(-1), hours: "0.33" });
    const r2 = await bill(ids.p!);
    expect(r2.minutes).toBe(20);
    expect(r2.net.toString()).toBe("39.6"); // 0,33 h × 120
  });

  it("Voraussetzungen: Kunde und Satz nötig, abgeschlossene Projekte nehmen keine Zeit, Korrigiertes wird nicht abgerechnet", async () => {
    const noRate = await project({ hourlyRate: "", name: "Ohne Satz" });
    await bookProjectTime(c.emp!, { projectId: noRate.id, workDate: dayIso(-1), hours: "1" });
    await expect(bill(noRate.id)).rejects.toThrow(/Stundensatz/);
    const noCust = await project({ customerId: "", name: "Ohne Kunde" });
    await bookProjectTime(c.emp!, { projectId: noCust.id, workDate: dayIso(-1), hours: "1" });
    await expect(bill(noCust.id)).rejects.toThrow(/Kunde/);

    const p = await project({ name: "Korrektur" });
    const t = await bookProjectTime(c.emp!, { projectId: p.id, workDate: dayIso(-1), hours: "2" });
    await reverseProjectTime(c.emp!, t.id, "Irrtum");
    await expect(bill(p.id)).rejects.toThrow(/keine abrechenbaren/); // Buchung und Gegenbuchung heben sich auf
    await setProjectStatus(c.mgr!, p.id, "CLOSED");
    await expect(bookProjectTime(c.emp!, { projectId: p.id, workDate: dayIso(-1), hours: "1" })).rejects.toThrow(/abgeschlossene/);
    await expect(setProjectStatus(c.mgr!, p.id, "CLOSED")).rejects.toBeInstanceOf(ConflictError);
    await setProjectStatus(c.mgr!, p.id, "ACTIVE");
    await expect(setProjectStatus(c.emp!, p.id, "CLOSED")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("parallele Abrechnung erzeugt nur einen Entwurf je Zeit", async () => {
    const p = await project({ name: "Parallel" });
    await bookProjectTime(c.emp!, { projectId: p.id, workDate: dayIso(-2), hours: "4" });
    const r = await Promise.allSettled([bill(p.id), bill(p.id), bill(p.id)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.projectBilling.count({ where: { projectId: p.id } })).toBe(1);
    expect(await db.projectBillingItem.count({ where: { billing: { projectId: p.id } } })).toBe(1);
  });
});

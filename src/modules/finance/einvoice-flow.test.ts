import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createAccount, createCreditNoteDraft, createCustomer, createCustomerInvoice, createTaxCode, getCustomerInvoiceEInvoice, issueCustomerInvoice, listAccounts, setCustomerAccounts, setCustomerEinvoiceEndpoint, setIssuerProfile } from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!hasDb)("E-Rechnung aus ausgestellten Ausgangsrechnungen", () => {
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
    tenantId = (await db.tenant.create({ data: { name: "TEST-EInvoice" } })).id;
    orgA = await makeOrg("TEST-EI-A");
    orgB = await makeOrg("TEST-EI-B");
    for (const [l, r] of [["fin", "finance"], ["emp", "employee"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");
    await createAccount(c.fin!, { number: "4000", name: "Erlöse", type: "GL" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    I.ust = (await createTaxCode(c.fin!, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    I.cust = (await createCustomer(c.fin!, { number: "K1", name: "Kunde GmbH", street: "Ring 5", zip: "4020", city: "Linz", uid: "ATU87654321" })).id;
    await setCustomerAccounts(c.fin!, I.cust, { uid: "ATU87654321", accountId: acc["20001"], lineAccountId: acc["4000"] });
    await setIssuerProfile(c.fin!, { legalName: "Muster GmbH", street: "Ringstraße 5", zip: "1010", city: "Wien", country: "AT" }); // bewusst unvollständig
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["outboxEvent", "auditLog", "customerInvoice", "customer", "issuerProfile", "taxCode", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Adresse des Kunden: Berechtigung, Format, Mandantentrennung", async () => {
    await expect(setCustomerEinvoiceEndpoint(c.emp!, I.cust!, "a@b.at")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCustomerEinvoiceEndpoint(c.fin!, I.cust!, "keine adresse")).rejects.toBeInstanceOf(ConflictError);
    await expect(setCustomerEinvoiceEndpoint(c.finB!, I.cust!, "a@b.at")).rejects.toBeInstanceOf(NotFoundError);
    await setCustomerEinvoiceEndpoint(c.fin!, I.cust!, "9915:kunde-gmbh");
    expect((await db.customer.findUniqueOrThrow({ where: { id: I.cust! } })).einvoiceEndpoint).toBe("9915:kunde-gmbh");
  });

  it("Entwürfe haben keine E-Rechnung; unvollständige Stammdaten werden benannt statt falsche XML zu erzeugen", async () => {
    const draft = await createCustomerInvoice(c.fin!, { customerId: I.cust, invoiceDate: today, lines: [{ description: "Beratung", quantity: "3", unitPrice: "100", taxCodeId: I.ust }] });
    await expect(getCustomerInvoiceEInvoice(c.fin!, draft.id)).rejects.toThrow(/ausgestellte/);
    await issueCustomerInvoice(c.fin!, draft.id);
    I.inv = draft.id;
    const r = await getCustomerInvoiceEInvoice(c.fin!, draft.id);
    expect(r.xml).toBeNull();
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringMatching(/UID/), expect.stringMatching(/IBAN/), expect.stringMatching(/E-Mail/)]));
    await expect(getCustomerInvoiceEInvoice(c.emp!, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCustomerInvoiceEInvoice(c.finB!, draft.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("mit vollständigen Aussteller-Angaben entsteht die UBL-Datei; der Beleg hält den Stand beim Ausstellen (Snapshot)", async () => {
    // neuer Beleg nach Ergänzung der Stammdaten
    await setIssuerProfile(c.fin!, { legalName: "Muster GmbH", street: "Ringstraße 5", zip: "1010", city: "Wien", country: "AT", uid: "ATU12345678", iban: "AT611904300234573201", bic: "BKAUATWW", email: "office@muster.example" });
    const inv = await createCustomerInvoice(c.fin!, { customerId: I.cust, invoiceDate: today, lines: [{ description: "Beratung & Schulung", quantity: "3", unitPrice: "100", taxCodeId: I.ust }] });
    await issueCustomerInvoice(c.fin!, inv.id);
    const r = await getCustomerInvoiceEInvoice(c.fin!, inv.id);
    expect(r.problems).toEqual([]);
    expect(r.filename).toMatch(/^AR-\d{4}-0002\.xml$/);
    expect(r.xml).toContain("Beratung &amp; Schulung");
    expect(r.xml).toContain('<cbc:EndpointID schemeID="9915">kunde-gmbh</cbc:EndpointID>');
    expect(r.xml).toContain('<cbc:PayableAmount currencyID="EUR">360.00</cbc:PayableAmount>');
    // der erste Beleg trägt weiterhin den damaligen (unvollständigen) Stand
    expect((await getCustomerInvoiceEInvoice(c.fin!, I.inv!)).xml).toBeNull();

    const credit = await createCreditNoteDraft(c.fin!, inv.id);
    await issueCustomerInvoice(c.fin!, credit.id);
    const cr = await getCustomerInvoiceEInvoice(c.fin!, credit.id);
    expect(cr.xml).toContain("<CreditNote ");
    expect(cr.xml).toContain(`<cbc:ID>${r.filename.replace(".xml", "")}</cbc:ID>`); // Bezug auf die Rechnung
  });
});

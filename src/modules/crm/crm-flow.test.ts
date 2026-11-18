import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { publishPolicy } from "@/platform/approvals/policy";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createAccount, createCustomer, createTaxCode, getCustomerInvoice, listAccounts, setCustomerAccounts, setIssuerProfile } from "@/modules/finance/service";
import {
  acceptQuote, addActivity, anonymizeContact, cancelQuote, createContact, createQuote, declineQuote, decideQuote, duplicateQuote, getCrmCustomer, getQuote, getQuotePdf,
  listCrmCustomers, listPendingQuoteApprovals, listQuotes, sendQuote, submitQuote,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)("CRM: Kontakte, Aktivitäten, Angebote", () => {
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
  async function makeUser(org: string, label: string, role: RoleKey) {
    const user = await db.user.create({ data: { email: `${label}-${org}@test.invalid`, name: label, passwordHash: await bcrypt.hash("x", 4) } });
    userIds.push(user.id);
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    c[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
  }
  const line = (price = "100", qty = "1") => ({ description: "Beratung", quantity: qty, unitPrice: price, taxCodeId: ids.ust20 });
  const quote = (extra: Record<string, unknown> = {}, who = "fin") => createQuote(c[who]!, { customerId: ids.customer, title: "Angebot Beratung", validUntil: plusDays(30), lines: [line()], ...extra });
  /** Entwurf → Freigabe → versendet */
  async function sent(extra: Record<string, unknown> = {}) {
    const q = await quote(extra);
    await submitQuote(c.fin!, q.id);
    await decideQuote(c.mgr!, { quoteId: q.id, decision: "APPROVE" });
    const number = await sendQuote(c.fin!, q.id);
    return { id: q.id, number };
  }

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-CRM" } })).id;
    orgA = await makeOrg("TEST-CRM-A");
    orgB = await makeOrg("TEST-CRM-B");
    for (const [l, r] of [["fin", "finance"], ["mgr", "manager"], ["emp", "employee"], ["owner", "owner"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");

    await createAccount(c.fin!, { number: "4000", name: "Erlöse", type: "GL" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    ids.ust20 = (await createTaxCode(c.fin!, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    ids.vst20 = (await createTaxCode(c.fin!, { key: "vst20", name: "Vorsteuer 20 %", rate: "20", direction: "INPUT" })).id;
    ids.customer = (await createCustomer(c.fin!, { number: "K1", name: "Kunde GmbH" })).id;
    await setCustomerAccounts(c.fin!, ids.customer!, { uid: "", accountId: acc["20001"], lineAccountId: acc["4000"] });
    ids.customerB = (await createCustomer(c.finB!, { number: "KB", name: "Kunde B" })).id;
    await setIssuerProfile(c.fin!, { legalName: "Muster GmbH", street: "Ringstraße 5", zip: "1010", city: "Wien" });
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["outboxEvent", "auditLog", "approvalPolicy", "quote", "activity", "contact", "customerInvoice", "issuerProfile", "customer", "taxCode", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  describe("Kontakte und Aktivitäten", () => {
    it("Berechtigungen, Prüfungen und Mandantentrennung", async () => {
      await expect(listCrmCustomers(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createContact(c.mgr!, { customerId: ids.customer, name: "X" })).rejects.toBeInstanceOf(ForbiddenError); // Führungskraft darf lesen, nicht schreiben
      await expect(createContact(c.fin!, { customerId: ids.customer, name: "X", email: "kein-mail" })).rejects.toThrow(/E-Mail/);
      await expect(createContact(c.fin!, { customerId: ids.customerB, name: "X" })).rejects.toBeInstanceOf(NotFoundError);
      const p = await createContact(c.fin!, { customerId: ids.customer, name: "Erika Muster", position: "Einkauf", email: "erika@kunde.example", phone: "+43 1 234" });
      ids.contact = p.id;
      await expect(addActivity(c.fin!, { customerId: ids.customer, contactId: ids.contact, type: "CALL", occurredOn: plusDays(2), subject: "Zukunft" })).rejects.toBeInstanceOf(ConflictError);
      await expect(addActivity(c.fin!, { customerId: ids.customerB, type: "NOTE", occurredOn: today, subject: "fremd" })).rejects.toBeInstanceOf(NotFoundError);
      const a = await addActivity(c.fin!, { customerId: ids.customer, contactId: ids.contact, type: "CALL", occurredOn: today, subject: "Bedarf besprochen", body: "Interesse an Wartung" });
      const view = await getCrmCustomer(c.mgr!, ids.customer!);
      expect(view.contacts.map((x) => x.name)).toContain("Erika Muster");
      expect(view.activities[0]).toMatchObject({ id: a.id, subject: "Bedarf besprochen" });
      expect(view.invoices).toBeNull(); // Führungskraft ohne Finanzberechtigung sieht keine Rechnungen
      expect((await listCrmCustomers(c.fin!)).find((x) => x.id === ids.customer)).toMatchObject({ contactCount: 1 });
      await expect(getCrmCustomer(c.finB!, ids.customer!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(db.activity.update({ where: { id: a.id }, data: { subject: "geändert" } })).rejects.toThrow(); // unveränderlich
    });

    it("Anonymisieren entfernt personenbezogene Daten, behält den Datensatz; Audit-Log enthält keine Personendaten", async () => {
      await expect(anonymizeContact(c.mgr!, ids.contact!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(anonymizeContact(c.finB!, ids.contact!)).rejects.toBeInstanceOf(NotFoundError);
      await anonymizeContact(c.fin!, ids.contact!);
      const row = await db.contact.findUniqueOrThrow({ where: { id: ids.contact! } });
      expect(row).toMatchObject({ name: "Gelöschter Kontakt", email: null, phone: null, position: null, active: false });
      expect(row.anonymizedAt).not.toBeNull();
      await expect(anonymizeContact(c.fin!, ids.contact!)).rejects.toBeInstanceOf(NotFoundError); // nur einmal
      const audit = JSON.stringify(await db.auditLog.findMany({ where: { organizationId: orgA, entityType: "Contact" } }));
      expect(audit).not.toMatch(/Erika|erika@|\+43 1 234/);
    });
  });

  describe("Angebote", () => {
    it("Ablauf: Entwurf → Freigabe (Vier-Augen) → versendet mit Nummer und PDF → angenommen → Rechnungsentwurf", async () => {
      const q = await quote({ lines: [line("100", "2"), line("50")] });
      expect(String(q.netTotal)).toBe("250");
      expect(String(q.grossTotal)).toBe("300");
      await expect(sendQuote(c.fin!, q.id)).rejects.toThrow(/freigegeben/); // nie ohne Freigabe
      await expect(getQuotePdf(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError);
      await submitQuote(c.fin!, q.id);
      await expect(submitQuote(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError);
      expect((await listPendingQuoteApprovals(c.mgr!)).map((a) => a.quoteId)).toContain(q.id);
      expect((await listPendingQuoteApprovals(c.fin!)).map((a) => a.quoteId)).not.toContain(q.id); // nicht die eigenen

      await expect(decideQuote(c.fin!, { quoteId: q.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError); // keine Freigabeberechtigung
      await expect(decideQuote(c.emp!, { quoteId: q.id, decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideQuote(c.finB!, { quoteId: q.id, decision: "APPROVE" })).rejects.toBeInstanceOf(NotFoundError);
      // Eigene Angebote: der Inhaber hat alle Rechte, darf sein eigenes Angebot trotzdem nicht freigeben
      const own = await quote({}, "owner");
      await submitQuote(c.owner!, own.id);
      await expect(decideQuote(c.owner!, { quoteId: own.id, decision: "APPROVE" })).rejects.toThrow(/Vier-Augen/);

      expect(await decideQuote(c.mgr!, { quoteId: q.id, decision: "APPROVE" })).toEqual({ status: "APPROVED" });
      const number = await sendQuote(c.fin!, q.id);
      expect(number).toMatch(/^AN-\d{4}-\d{4}$/);
      await expect(sendQuote(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError);
      await expect(cancelQuote(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError); // Versendetes wird nicht verworfen

      const pdf = await getQuotePdf(c.mgr!, q.id);
      const s = Buffer.from(pdf.bytes).toString("latin1");
      expect(pdf.filename).toBe(`${number}.pdf`);
      expect(s).toContain("(Angebot)");
      expect(s).toContain("(Gültig bis)".replace("ü", "\xfc"));
      expect(s).toContain("(300,00)");
      expect(s).toContain("(Ringstra\xdfe 5)"); // Briefkopf aus dem festgehaltenen Stand
      await expect(getQuotePdf(c.finB!, q.id)).rejects.toBeInstanceOf(NotFoundError);

      await expect(acceptQuote(c.mgr!, q.id)).rejects.toBeInstanceOf(ForbiddenError); // Rechnungsentwurf braucht Finanzberechtigung
      const { invoiceId } = await acceptQuote(c.fin!, q.id);
      const inv = await getCustomerInvoice(c.fin!, invoiceId);
      expect(inv).toMatchObject({ status: "DRAFT", kind: "INVOICE" });
      expect(String(inv.grossTotal)).toBe("300");
      expect(inv.note).toContain(number);
      expect(inv.lines).toHaveLength(2);
      expect((await getQuote(c.fin!, q.id)).status).toBe("ACCEPTED");
      await expect(acceptQuote(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError);
      await expect(declineQuote(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("Ablehnung intern braucht Begründung; Ablehnung durch den Kunden; Kopie; Verwerfen", async () => {
      const q = await quote();
      await submitQuote(c.fin!, q.id);
      await expect(decideQuote(c.mgr!, { quoteId: q.id, decision: "REJECT" })).rejects.toThrow(/Begründung/);
      expect(await decideQuote(c.mgr!, { quoteId: q.id, decision: "REJECT", comment: "Preis zu niedrig" })).toEqual({ status: "REJECTED" });
      await expect(sendQuote(c.fin!, q.id)).rejects.toBeInstanceOf(ConflictError);
      const copy = await duplicateQuote(c.fin!, q.id, plusDays(14));
      expect(copy.status).toBe("DRAFT");
      expect(String(copy.grossTotal)).toBe(String(q.grossTotal));
      await cancelQuote(c.fin!, copy.id);
      expect((await getQuote(c.fin!, copy.id)).status).toBe("CANCELLED");

      const s = await sent();
      await declineQuote(c.fin!, s.id, "zu teuer");
      expect((await getQuote(c.fin!, s.id)).status).toBe("DECLINED");
      await expect(acceptQuote(c.fin!, s.id)).rejects.toBeInstanceOf(ConflictError);
      expect((await listQuotes(c.mgr!)).length).toBeGreaterThan(3);
      await expect(listQuotes(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("Gültigkeit: Vergangenheit wird abgewiesen; abgelaufene Angebote werden weder versendet noch angenommen", async () => {
      await expect(quote({ validUntil: plusDays(-1) })).rejects.toBeInstanceOf(ConflictError);
      await expect(quote({ lines: [{ description: "x", quantity: "1", unitPrice: "1", taxCodeId: ids.vst20 }] })).rejects.toBeInstanceOf(NotFoundError); // nur Umsatzsteuer
      const s = await sent();
      await db.quote.update({ where: { id: s.id }, data: { validUntil: new Date(`${plusDays(-1)}T00:00:00Z`) } });
      await expect(acceptQuote(c.fin!, s.id)).rejects.toThrow(/abgelaufen/);
      const q = await quote();
      await submitQuote(c.fin!, q.id);
      await decideQuote(c.mgr!, { quoteId: q.id, decision: "APPROVE" });
      await db.quote.update({ where: { id: q.id }, data: { validUntil: new Date(`${plusDays(-1)}T00:00:00Z`) } });
      await expect(sendQuote(c.fin!, q.id)).rejects.toThrow(/abgelaufen/);
    });

    it("Freigaberegel: mehrere Schritte laut Regel (kein fester Schwellenwert im Code)", async () => {
      await publishPolicy(c.owner!, [{ key: "SALES_LEAD", label: "Vertriebsleitung", permission: "crm.quote.approve" }, { key: "BIG", label: "Zweite Freigabe", permission: "crm.quote.approve", minAmount: "1000" }], "QUOTE");
      const small = await quote();
      await submitQuote(c.fin!, small.id);
      expect(await decideQuote(c.mgr!, { quoteId: small.id, decision: "APPROVE" })).toEqual({ status: "APPROVED" });
      const big = await quote({ lines: [line("5000")] });
      await submitQuote(c.fin!, big.id);
      expect(await decideQuote(c.mgr!, { quoteId: big.id, decision: "APPROVE" })).toEqual({ status: "PENDING" });
      expect(await decideQuote(c.mgr!, { quoteId: big.id, decision: "APPROVE" })).toEqual({ status: "APPROVED" });
      expect((await getQuote(c.fin!, big.id)).approvals.map((a) => a.status)).toEqual(["APPROVED", "APPROVED"]);
      await publishPolicy(c.owner!, [{ key: "SALES_LEAD", label: "Vertriebsleitung", permission: "crm.quote.approve" }], "QUOTE");
    });

    it("parallel: ein Angebot wird nur einmal versendet; Nummern sind lückenlos", async () => {
      const qs = await Promise.all([quote(), quote(), quote()]);
      for (const q of qs) { await submitQuote(c.fin!, q.id); await decideQuote(c.mgr!, { quoteId: q.id, decision: "APPROVE" }); }
      const r = await Promise.allSettled([sendQuote(c.fin!, qs[0]!.id), sendQuote(c.fin!, qs[0]!.id), sendQuote(c.fin!, qs[1]!.id), sendQuote(c.fin!, qs[2]!.id)]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(3);
      const numbers = (await db.quote.findMany({ where: { id: { in: qs.map((q) => q.id) } }, select: { number: true } })).map((x) => Number(x.number!.slice(-4))).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(3);
      expect(numbers[2]! - numbers[0]!).toBe(2);
    });
  });
});

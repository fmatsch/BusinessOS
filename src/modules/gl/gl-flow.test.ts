import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import {
  approveSupplierInvoice, createAccount, createCreditNoteDraft, createCustomer, createCustomerInvoice, createSupplierInvoice, createTaxCode, issueCustomerInvoice,
  listAccounts, markCustomerInvoicePaid, unpayCustomerInvoiceTx, setAccountKind, setCustomerAccounts, setSupplierAccounts, setTaxGlMapping, markSupplierInvoicePaid,
} from "@/modules/finance/service";
import { createSupplier } from "@/modules/procurement/service";
import {
  accountLedger, activateGl, vatReturn, balanceSheetReport, closePeriod, createManualEntry, getEntry, incomeStatementReport, listEntries, postMissingDocuments, reopenPeriod, reverseEntry, trialBalance,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const today = new Date().toISOString().slice(0, 10);
const year = Number(today.slice(0, 4));

describe.skipIf(!hasDb)("Hauptbuch", () => {
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
  const entriesOf = (source: string) => db.journalEntry.findMany({ where: { organizationId: orgA, source }, include: { lines: true, reversedBy: true }, orderBy: { createdAt: "asc" } });
  const sale = async (price: string, date = today) => {
    const inv = await createCustomerInvoice(c.fin!, { customerId: A.customer, invoiceDate: date, lines: [{ description: "Leistung", quantity: "1", unitPrice: price, taxCodeId: A.ust20 }] });
    await issueCustomerInvoice(c.fin!, inv.id);
    return inv.id;
  };
  const line = (account: string, debit: string, credit: string) => ({ accountId: A[account], debit, credit });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-GL" } })).id;
    orgA = await makeOrg("TEST-GL-A");
    orgB = await makeOrg("TEST-GL-B");
    for (const [l, r] of [["fin", "finance"], ["fin2", "finance"], ["emp", "employee"], ["owner", "owner"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");

    for (const [number, name, type] of [["2800", "Bank", "GL"], ["2500", "Vorsteuer", "GL"], ["3500", "Umsatzsteuer", "GL"], ["4000", "Erlöse", "GL"], ["7000", "Aufwand", "GL"], ["9000", "Eigenkapital", "GL"], ["9999", "Unklar", "GL"], ["20001", "Debitor", "CUSTOMER"], ["33001", "Kreditor", "VENDOR"]] as const)
      await createAccount(c.fin!, { number, name, type });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    Object.assign(A, { bank: acc["2800"], vst: acc["2500"], ust: acc["3500"], erloes: acc["4000"], aufwand: acc["7000"], ek: acc["9000"], unklar: acc["9999"], deb: acc["20001"], kred: acc["33001"] });
    for (const [k, kind] of [["bank", "ASSET"], ["vst", "ASSET"], ["ust", "LIABILITY"], ["erloes", "INCOME"], ["aufwand", "EXPENSE"], ["ek", "EQUITY"]] as const) await setAccountKind(c.fin!, A[k]!, kind);
    A.ust20 = (await createTaxCode(c.fin!, { key: "ust20", name: "USt 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    A.vst20 = (await createTaxCode(c.fin!, { key: "vst20", name: "VSt 20 %", rate: "20", direction: "INPUT", bmdCode: "2", datevKey: "9" })).id;
    await setTaxGlMapping(c.fin!, A.ust20!, { vatAccountId: A.ust!, uvaBaseCode: "022", uvaTaxCode: "022" });
    await setTaxGlMapping(c.fin!, A.vst20!, { vatAccountId: A.vst!, uvaTaxCode: "060" });
    A.customer = (await createCustomer(c.fin!, { number: "K1", name: "Kunde GmbH" })).id;
    await setCustomerAccounts(c.fin!, A.customer, { uid: "", accountId: A.deb, lineAccountId: A.erloes });
    A.supplier = (await createSupplier(c.fin!, { number: "L1", name: "Lieferant GmbH" })).id;
    await setSupplierAccounts(c.fin!, A.supplier, { uid: "", accountId: A.kred, lineAccountId: A.aufwand });
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.journalLine.deleteMany({ where: { entry: { organizationId: { in: orgs } } } });
      await tx.journalEntry.deleteMany({ where: { organizationId: { in: orgs }, reversesId: { not: null } } });
      for (const m of ["journalEntry", "accountingPeriod", "glSettings", "outboxEvent", "auditLog", "bankLine", "bankImport", "customerInvoice", "supplierInvoice", "customer", "supplier", "taxCode", "account", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("vor dem Einschalten wird nichts gebucht; Einschalten nur mit Berechtigung, Startdatum bleibt", async () => {
    const early = await sale("40", `${year}-01-05`); // vor dem Einschalten ausgestellt
    expect(await db.journalEntry.count({ where: { organizationId: orgA } })).toBe(0);
    await expect(createManualEntry(c.fin!, { date: today, text: "x", lines: [line("bank", "1", ""), line("ek", "", "1")] })).rejects.toThrow(/noch nicht eingeschaltet/);
    await expect(activateGl(c.emp!, { startDate: `${year}-01-01` })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(activateGl(c.fin!, { startDate: `${year}-01-01`, bankAccountId: "fremd" })).rejects.toBeInstanceOf(NotFoundError);
    await activateGl(c.fin!, { startDate: `${year}-01-01`, bankAccountId: A.bank });
    await expect(activateGl(c.fin!, { startDate: `${year}-02-01`, bankAccountId: A.bank })).rejects.toThrow(/Startdatum/);
    A.early = early;
  });

  it("manuelle Buchungen: Prüfungen, lückenlose Nummern, Mandantentrennung, Storno, unveränderlich", async () => {
    await expect(createManualEntry(c.emp!, { date: today, text: "x", lines: [line("bank", "1", ""), line("ek", "", "1")] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createManualEntry(c.fin!, { date: today, text: "ungleich", lines: [line("bank", "100", ""), line("ek", "", "99")] })).rejects.toThrow(/nicht ausgeglichen/);
    await expect(createManualEntry(c.fin!, { date: today, text: "fremd", lines: [{ accountId: "fremd", debit: "1" }, line("ek", "", "1")] })).rejects.toBeInstanceOf(NotFoundError);
    await createAccount(c.fin!, { number: "8888", name: "Alt", type: "GL" });
    const alt = (await listAccounts(c.fin!)).find((a) => a.number === "8888")!;
    await db.account.update({ where: { id: alt.id }, data: { active: false } });
    await expect(createManualEntry(c.fin!, { date: today, text: "inaktiv", lines: [{ accountId: alt.id, debit: "1" }, line("ek", "", "1")] })).rejects.toThrow(/inaktive/);

    const opening = await createManualEntry(c.fin!, { date: `${year}-01-01`, text: "Eröffnungsbilanz", opening: true, lines: [line("bank", "1000", ""), line("ek", "", "1000")] });
    const second = await createManualEntry(c.fin!, { date: today, text: "Einlage", lines: [line("bank", "500", ""), line("ek", "", "500")] });
    const n1 = Number(opening.number.slice(-5)), n2 = Number(second.number.slice(-5));
    expect(n2).toBe(n1 + 1);
    expect(opening.source).toBe("OPENING");
    await expect(getEntry(c.finB!, opening.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listEntries(c.finB!)).toEqual([]);

    // die Datenbank verhindert unausgeglichene Sätze auch am Service vorbei
    await expect(db.$transaction(async (tx) => {
      const e = await tx.journalEntry.create({ data: { organizationId: orgA, number: "BU-X-00001", entryDate: new Date(), text: "direkt", source: "MANUAL", createdById: "x" } });
      await tx.journalLine.create({ data: { entryId: e.id, accountId: A.bank!, debit: "5", credit: "0" } });
    })).rejects.toThrow(/nicht ausgeglichen/);
    await expect(db.journalLine.create({ data: { entryId: second.id, accountId: A.bank!, debit: "5", credit: "5" } })).rejects.toThrow(); // beide Seiten

    // unveränderlich; Korrektur per Storno
    await expect(db.journalEntry.update({ where: { id: second.id }, data: { text: "geändert" } })).rejects.toThrow();
    await expect(reverseEntry(c.fin!, second.id, "x")).rejects.toThrow(/Begründung/);
    const rev = await reverseEntry(c.fin!, second.id, "Falsch gebucht");
    expect(rev.reversesId).toBe(second.id);
    const full = await getEntry(c.fin!, rev.id);
    expect(full.lines.map((l) => [String(l.debit), String(l.credit)]).sort()).toEqual([["0", "500"], ["500", "0"]]);
    await expect(reverseEntry(c.fin!, second.id, "nochmal")).rejects.toBeInstanceOf(ConflictError);
    await expect(reverseEntry(c.fin!, rev.id, "Storno des Stornos")).rejects.toThrow(/Stornobuchungen/);
  });

  it("Belege werden automatisch gebucht: Ausgangs-, Eingangsrechnung, Gutschrift, Zahlung und deren Rücknahme", async () => {
    const saleId = await sale("100");
    const [s] = (await entriesOf("CUSTOMER_INVOICE")).filter((e) => e.sourceId === saleId);
    const byAcc = (e: NonNullable<typeof s>) => Object.fromEntries(e.lines.map((l) => [[A.deb, A.erloes, A.ust].indexOf(l.accountId) >= 0 ? ["deb", "erloes", "ust"][[A.deb, A.erloes, A.ust].indexOf(l.accountId)]! : l.accountId, [String(l.debit), String(l.credit)]]));
    expect(byAcc(s!)).toEqual({ deb: ["120", "0"], erloes: ["0", "100"], ust: ["0", "20"] });
    expect(s!.lines.find((l) => l.accountId === A.ust)).toMatchObject({ taxCodeId: A.ust20, taxRole: "TAX" });

    const inv = await createSupplierInvoice(c.fin!, { supplierId: A.supplier, invoiceNumber: `E-${Date.now()}`, invoiceDate: today, lines: [{ description: "Material", netAmount: "50", taxCodeId: A.vst20, expenseAccountId: A.aufwand }] });
    await approveSupplierInvoice(c.fin2!, inv.id);
    const [p] = (await entriesOf("SUPPLIER_INVOICE")).filter((e) => e.sourceId === inv.id);
    expect(p!.lines.map((l) => [l.accountId === A.aufwand ? "aufwand" : l.accountId === A.vst ? "vst" : "kred", String(l.debit), String(l.credit)]).sort()).toEqual([["aufwand", "50", "0"], ["kred", "0", "60"], ["vst", "10", "0"]]);

    // Zahlung: Bank an Debitor
    await markCustomerInvoicePaid(c.fin!, { id: saleId, paidOn: today });
    let pays = (await entriesOf("CUSTOMER_PAYMENT")).filter((e) => e.sourceId?.startsWith(saleId));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.lines.map((l) => [l.accountId === A.bank ? "bank" : "deb", String(l.debit), String(l.credit)]).sort()).toEqual([["bank", "120", "0"], ["deb", "0", "120"]]);
    // Rücknahme storniert die Zahlungsbuchung, erneuter Vermerk bucht neu
    await db.$transaction((tx) => unpayCustomerInvoiceTx(tx, c.fin!, saleId));
    pays = (await entriesOf("CUSTOMER_PAYMENT")).filter((e) => e.sourceId?.startsWith(saleId));
    expect(pays[0]!.reversedBy).not.toBeNull(); // die Zahlungsbuchung bleibt, ist aber storniert
    expect((await entriesOf("REVERSAL")).some((e) => e.reversesId === pays[0]!.id)).toBe(true);
    await markCustomerInvoicePaid(c.fin!, { id: saleId, paidOn: today });
    pays = (await entriesOf("CUSTOMER_PAYMENT")).filter((e) => e.sourceId?.startsWith(saleId));
    expect(pays).toHaveLength(2);
    expect(pays[1]!.reversedBy).toBeNull();
    expect(pays[1]!.sourceId).toBe(`${saleId}:2`);

    // Lieferantenzahlung: Kreditor an Bank
    await markSupplierInvoicePaid(c.fin2!, { id: inv.id, paidOn: today });
    const sp = (await entriesOf("SUPPLIER_PAYMENT")).find((e) => e.sourceId === inv.id)!;
    expect(sp.lines.map((l) => [l.accountId === A.bank ? "bank" : "kred", String(l.debit), String(l.credit)]).sort()).toEqual([["bank", "0", "60"], ["kred", "60", "0"]]);

    // Gutschrift kehrt die Seiten um
    const cn = await createCreditNoteDraft(c.fin!, saleId);
    await issueCustomerInvoice(c.fin!, cn.id);
    const [credit] = (await entriesOf("CUSTOMER_INVOICE")).filter((e) => e.sourceId === cn.id);
    expect(credit!.lines.find((l) => l.accountId === A.deb)).toMatchObject({ credit: expect.anything() });
    expect(String(credit!.lines.find((l) => l.accountId === A.deb)!.credit)).toBe("120");
  });

  it("fehlendes Steuerkonto verhindert das Ausstellen (nichts halb gebucht)", async () => {
    // Beleg mit Steuerkennzeichen ohne Steuerkonto → Ausstellen scheitert, nichts wird ausgestellt oder gebucht
    const noAcc = (await createTaxCode(c.fin!, { key: "ust10", name: "USt 10 %", rate: "10", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    const inv = await createCustomerInvoice(c.fin!, { customerId: A.customer, invoiceDate: today, lines: [{ description: "x", quantity: "1", unitPrice: "10", taxCodeId: noAcc }] });
    await expect(issueCustomerInvoice(c.fin!, inv.id)).rejects.toThrow(/kein Steuerkonto/);
    expect((await db.customerInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("DRAFT");
    expect(await db.journalEntry.count({ where: { organizationId: orgA, sourceId: inv.id } })).toBe(0);
    await setTaxGlMapping(c.fin!, noAcc, { vatAccountId: A.ust! });
    await issueCustomerInvoice(c.fin!, inv.id);
    expect(await db.journalEntry.count({ where: { organizationId: orgA, source: "CUSTOMER_INVOICE", sourceId: inv.id } })).toBe(1);
  });

  it("Nachbuchen: vor dem Einschalten ausgestellte Belege ab dem Startdatum werden gebucht", async () => {
    expect(await db.journalEntry.count({ where: { organizationId: orgA, sourceId: A.early } })).toBe(0);
    await expect(postMissingDocuments(c.emp!)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await postMissingDocuments(c.fin!);
    expect(r.posted).toBeGreaterThanOrEqual(1);
    expect(await db.journalEntry.count({ where: { organizationId: orgA, source: "CUSTOMER_INVOICE", sourceId: A.early } })).toBe(1);
    expect((await postMissingDocuments(c.fin!)).posted).toBe(0); // wiederholbar
  });

  it("Auswertungen: Saldenliste, Kontoblatt, GuV, Bilanz (Aktiva = Passiva), nicht eingeordnete Konten", async () => {
    const tb = await trialBalance(c.fin!, { to: today });
    expect(tb.totals.debit.toString()).toBe(tb.totals.credit.toString()); // Soll = Haben über alle Konten
    expect(tb.totals.closing.toString()).toBe("0");

    const gl = await accountLedger(c.fin!, A.bank!, { from: `${year}-01-01`, to: today });
    expect(gl.rows[0]!.entry.text).toBe("Eröffnungsbilanz");
    expect(gl.rows[gl.rows.length - 1]!.balance.toString()).toBe(gl.closing.toString());
    await expect(accountLedger(c.finB!, A.bank!, { to: today })).rejects.toBeInstanceOf(NotFoundError);

    const g = await incomeStatementReport(c.fin!, { from: `${year}-01-01`, to: today });
    expect(g.result.toString()).toBe(g.income.total.minus(g.expense.total).toString());
    expect(g.expense.total.toString()).toBe("50");

    const b = await balanceSheetReport(c.fin!, today);
    expect(b.difference.toString()).toBe("0");
    expect(b.assets.total.gt(0)).toBe(true);
    expect(b.unclassified).toEqual([]);
    // Buchung auf ein nicht eingeordnetes Konto fällt auf
    await createManualEntry(c.fin!, { date: today, text: "unklar", lines: [line("unklar", "7", ""), line("ek", "", "7")] });
    const b2 = await balanceSheetReport(c.fin!, today);
    expect(b2.unclassified.map((u) => u.number)).toEqual(["9999"]);
    expect(b2.difference.toString()).not.toBe("0");
    await expect(balanceSheetReport(c.emp!, today)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Umsatzsteuer-Voranmeldung: Bemessungsgrundlage und Steuer je Kennzahl, Zahllast; Gutschriften mindern", async () => {
    const v = await vatReturn(c.fin!, { from: `${year}-01-01`, to: today });
    const out = v.lines.find((l) => l.code === "ust20")!, inn = v.lines.find((l) => l.code === "vst20")!;
    // Ausgang: Rechnungen (40 früh, 100) abzüglich Gutschrift (100) – die Rechnung über 10 (10 %) trägt ein eigenes Kennzeichen
    expect(out.base.toString()).toBe("40");
    expect(out.tax.toString()).toBe("8");
    expect(inn.base.toString()).toBe("50");
    expect(inn.tax.toString()).toBe("10");
    expect(v.byKz.find((k) => k.kz === "022" && k.kind === "Bemessungsgrundlage")!.amount.toString()).toBe("40");
    expect(v.byKz.find((k) => k.kz === "060")!.amount.toString()).toBe("10");
    expect(v.outputTax.minus(v.inputTax).toString()).toBe(v.payable.toString());
    expect(v.unmapped).toContain("ust10"); // Steuerkennzeichen ohne Kennzahl wird gemeldet
    // ein Zeitraum ohne Buchungen ist leer; fremde Organisation sieht nichts
    expect((await vatReturn(c.fin!, { from: "2000-01-01", to: "2000-12-31" })).lines).toEqual([]);
    expect((await vatReturn(c.finB!, { to: today })).lines).toEqual([]);
    await expect(vatReturn(c.emp!, { to: today })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Periodenabschluss: geschlossene Periode nimmt nichts mehr an; Öffnen nur mit Berechtigung und Begründung", async () => {
    const m = Number(today.slice(5, 7));
    await expect(closePeriod(c.emp!, { year, month: m })).rejects.toBeInstanceOf(ForbiddenError);
    await closePeriod(c.fin!, { year, month: m });
    await expect(closePeriod(c.fin!, { year, month: m })).rejects.toBeInstanceOf(ConflictError);
    await expect(createManualEntry(c.fin!, { date: today, text: "zu spät", lines: [line("bank", "1", ""), line("ek", "", "1")] })).rejects.toThrow(/abgeschlossen/);
    const inv = await createCustomerInvoice(c.fin!, { customerId: A.customer, invoiceDate: today, lines: [{ description: "x", quantity: "1", unitPrice: "5", taxCodeId: A.ust20 }] });
    await expect(issueCustomerInvoice(c.fin!, inv.id)).rejects.toThrow(/abgeschlossen/); // Ausstellen scheitert, nichts halb gebucht
    expect((await db.customerInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("DRAFT");
    await expect(reopenPeriod(c.fin!, { year, month: m }, "Nachbuchung nötig")).rejects.toBeInstanceOf(ForbiddenError); // nur Inhaber
    await expect(reopenPeriod(c.owner!, { year, month: m }, "kurz")).rejects.toThrow(/Begründung/);
    await reopenPeriod(c.owner!, { year, month: m }, "Nachbuchung nötig");
    await issueCustomerInvoice(c.fin!, inv.id);
    expect((await db.customerInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("ISSUED");
    expect(await db.auditLog.count({ where: { organizationId: orgA, action: { in: ["gl.period_close", "gl.period_reopen"] } } })).toBe(2);
  });
});

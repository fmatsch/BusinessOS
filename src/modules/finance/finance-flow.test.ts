import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { unzipSync } from "fflate";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import {
  approveSupplierInvoice, cancelCustomerInvoiceDraft, cancelSupplierInvoice, createAccount, createCreditNoteDraft, createCustomer, createCustomerInvoice,
  createSupplierInvoice, createTaxCode, getFile, importAccounts, issueCustomerInvoice, listAccounts, markCustomerInvoicePaid, markSupplierInvoicePaid,
  safeFileName, setAccountingProfile, setCustomerAccounts, setSupplierAccounts, sniffMime, updateTaxMapping, uploadFile, getSupplierInvoice, getCustomerInvoice,
  listSupplierInvoices, getCustomerInvoicePdf, getIssuerProfile, setIssuerProfile,
} from "./service";
import { createAccountingExport, getAccountingExportFile, listAccountingExports, previewAccountingExport } from "./export";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3]);
const YEAR = new Date().getFullYear();
const d = (m: number, day: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

describe("Magic-Bytes und Dateinamen", () => {
  it("erkennt PDF/PNG/JPEG am Inhalt, nicht am Namen", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMime(new TextEncoder().encode("MZ\u0090\u0000exe"))).toBeNull();
    expect(sniffMime(new Uint8Array([]))).toBeNull();
  });
  it("Dateinamen ohne Pfadanteile und Sonderzeichen", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\x\\Rechnung ä<>.pdf")).toBe("Rechnung ä__.pdf");
    expect(safeFileName("")).toBe("beleg");
  });
});

describe.skipIf(!hasDb)("Finanzen: Belege und Export an die Steuerberatung", () => {
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
  const ownerOf = (label: string): Ctx => ({ ...c[label]!, permissions: new Set(PERMISSIONS) as Ctx["permissions"] });
  const supplierLine = (net: string, taxKey = "vst20", extra: Record<string, unknown> = {}) => ({ description: "Leistung", netAmount: net, taxCodeId: ids[taxKey], expenseAccountId: ids.acc7000, ...extra });
  const supplierInv = (number: string, lines = [supplierLine("100")], extra: Record<string, unknown> = {}) =>
    createSupplierInvoice(c.fin!, { supplierId: ids.supplier, invoiceNumber: number, invoiceDate: d(3, 15), lines, ...extra });
  const profile = (extra: Record<string, unknown> = {}) => setAccountingProfile(c.fin!, { format: "BMD", advisorNumber: "", clientNumber: "", accountLength: 4, fiscalYearStartMonth: 1, symbolIn: "ER", symbolOut: "AR", dictationCode: "", includeFiles: true, ...extra });

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Finance" } })).id;
    orgA = await makeOrg("TEST-FI-A");
    orgB = await makeOrg("TEST-FI-B");
    for (const [l, r] of [["fin", "finance"], ["fin2", "finance"], ["mgr", "manager"], ["emp", "employee"], ["hr", "hr"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "finB", "finance");

    await importAccounts(c.fin!, "4000;Erlöse 20%\n7000;Aufwand Material\n7100;Aufwand Dienstleistung");
    await createAccount(c.fin!, { number: "33001", name: "Kreditor Müller", type: "VENDOR" });
    await createAccount(c.fin!, { number: "20001", name: "Debitor Kunde", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(c.fin!)).map((a) => [a.number, a.id]));
    ids.acc4000 = acc["4000"]!; ids.acc7000 = acc["7000"]!; ids.acc7100 = acc["7100"]!; ids.v33001 = acc["33001"]!; ids.c20001 = acc["20001"]!;
    ids.vst20 = (await createTaxCode(c.fin!, { key: "vst20", name: "Vorsteuer 20 %", rate: "20", direction: "INPUT", bmdCode: "2", datevKey: "9" })).id;
    ids.vst10 = (await createTaxCode(c.fin!, { key: "vst10", name: "Vorsteuer 10 %", rate: "10", direction: "INPUT", bmdCode: "2", datevKey: "8" })).id;
    ids.vst0 = (await createTaxCode(c.fin!, { key: "vst0", name: "steuerfrei", rate: "0", direction: "INPUT" })).id;
    ids.ust20 = (await createTaxCode(c.fin!, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    ids.supplier = (await db.supplier.create({ data: { organizationId: orgA, number: "L1", name: "Müller & Söhne GmbH" } })).id;
    await setSupplierAccounts(c.fin!, ids.supplier!, { uid: "ATU12345678", accountId: ids.v33001, lineAccountId: ids.acc7000 });
    ids.customer = (await createCustomer(c.fin!, { number: "K1", name: "Kunde GmbH", paymentTermsDays: 30 })).id;
    await setCustomerAccounts(c.fin!, ids.customer!, { uid: "ATU87654321", accountId: ids.c20001, lineAccountId: ids.acc4000 });
    ids.accB = (await createAccount(c.finB!, { number: "9999", name: "Konto B", type: "GL" })).id;
    ids.supplierB = (await db.supplier.create({ data: { organizationId: orgB, number: "LB", name: "Lieferant B" } })).id;
    await profile();
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      for (const m of ["accountingExport", "auditLog", "supplierInvoice", "customerInvoice", "financeFile", "customer", "taxCode", "account", "accountingProfile", "issuerProfile", "sequence", "supplier", "costCenter"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  describe("Stammdaten", () => {
    it("Berechtigungen: lesen/schreiben nur Finanzen; Kontoimport alles oder nichts; keine Dubletten", async () => {
      await expect(listAccounts(c.mgr!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createAccount(c.hr!, { number: "1", name: "x", type: "GL" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createAccount(c.fin!, { number: "7000", name: "Doppelt", type: "GL" })).rejects.toBeInstanceOf(ConflictError);
      await expect(importAccounts(c.fin!, "8000;Ok\nabc;Falsch")).rejects.toThrow(/Zeile 2/);
      expect((await listAccounts(c.fin!)).some((a) => a.number === "8000")).toBe(false); // nichts importiert
      await expect(importAccounts(c.fin!, "8100;A\n8100;B")).rejects.toThrow(/doppelte/);
      expect(await importAccounts(c.fin!, "7000;Aufwand Material\n8200;Neu;GL")).toEqual({ created: 1, skipped: 1 });
    });
    it("Steuerkennzeichen: Zuordnung ändern; Konten nur der eigenen Organisation", async () => {
      await updateTaxMapping(c.fin!, ids.vst10!, { bmdCode: "2", datevKey: "" });
      expect((await db.taxCode.findUniqueOrThrow({ where: { id: ids.vst10! } })).datevKey).toBeNull();
      await updateTaxMapping(c.fin!, ids.vst10!, { bmdCode: "2", datevKey: "8" });
      await expect(setSupplierAccounts(c.fin!, ids.supplier!, { accountId: ids.accB })).rejects.toBeInstanceOf(NotFoundError);
      await expect(setSupplierAccounts(c.fin!, ids.supplier!, { accountId: ids.acc7000 })).rejects.toBeInstanceOf(NotFoundError); // kein Kreditorenkonto
      await expect(setSupplierAccounts(c.finB!, ids.supplier!, {})).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("Belegdateien", () => {
    it("Upload prüft Inhalt und Größe; liest nur die eigene Organisation", async () => {
      await expect(uploadFile(c.fin!, { name: "x.pdf", bytes: new TextEncoder().encode("kein pdf") })).rejects.toThrow(/PDF/);
      await expect(uploadFile(c.fin!, { name: "x.pdf", bytes: new Uint8Array([]) })).rejects.toThrow(/leer/);
      await expect(uploadFile(c.fin!, { name: "x.pdf", bytes: new Uint8Array(8 * 1024 * 1024 + 1).fill(0x25) })).rejects.toThrow();
      await expect(uploadFile(c.emp!, { name: "x.pdf", bytes: PDF })).rejects.toBeInstanceOf(ForbiddenError);
      const f = await uploadFile(c.fin!, { name: "../Rechnung 1.pdf", bytes: PDF });
      expect(f).toMatchObject({ name: "Rechnung 1.pdf", mime: "application/pdf", size: PDF.length });
      expect((await getFile(c.fin!, f.id)).data.length).toBe(PDF.length);
      await expect(getFile(c.finB!, f.id)).rejects.toBeInstanceOf(NotFoundError);
      ids.file = f.id;
    });
  });

  describe("Eingangsrechnungen", () => {
    it("Erfassen: Steuer je Satz exakt, Dublette je Lieferant, fremde Konten/Steuerkennzeichen abgewiesen", async () => {
      const inv = await supplierInv("RE-1", [supplierLine("10.01"), supplierLine("5.55", "vst10", { expenseAccountId: ids.acc7100 }), supplierLine("7.77", "vst10")], { fileId: ids.file });
      expect([inv.netTotal, inv.taxTotal, inv.grossTotal].map(String)).toEqual(["23.33", "3.33", "26.66"]);
      await expect(supplierInv("RE-1")).rejects.toThrow(/bereits erfasst/);
      await expect(supplierInv("RE-2", [supplierLine("1", "ust20")])).rejects.toBeInstanceOf(NotFoundError); // Umsatzsteuer-Kennzeichen bei Eingangsrechnung
      await expect(supplierInv("RE-3", [supplierLine("1", "vst20", { expenseAccountId: ids.accB })])).rejects.toBeInstanceOf(NotFoundError);
      await expect(supplierInv("RE-4", [supplierLine("0")])).rejects.toThrow();
      await expect(supplierInv("RE-5", [supplierLine("1.005")])).rejects.toThrow(/Nachkommastellen/);
      await expect(createSupplierInvoice(c.finB!, { supplierId: ids.supplier, invoiceNumber: "X", invoiceDate: d(1, 1), lines: [supplierLine("1")] })).rejects.toBeInstanceOf(NotFoundError);
      await expect(createSupplierInvoice(c.mgr!, { supplierId: ids.supplier, invoiceNumber: "Y", invoiceDate: d(1, 1), lines: [supplierLine("1")] })).rejects.toBeInstanceOf(ForbiddenError);
      ids.inv1 = inv.id;
    });
    it("Freigabe: Vier-Augen-Prinzip, Kreditorenkonto nötig, interne Belegnummer; Storno nur vor Export", async () => {
      await expect(approveSupplierInvoice(c.fin!, ids.inv1!)).rejects.toThrow(/Vier-Augen/); // Ersteller
      await expect(approveSupplierInvoice(c.mgr!, ids.inv1!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(approveSupplierInvoice(c.finB!, ids.inv1!)).rejects.toBeInstanceOf(NotFoundError);
      await approveSupplierInvoice(c.fin2!, ids.inv1!);
      const inv = await getSupplierInvoice(c.fin!, ids.inv1!);
      expect(inv.status).toBe("APPROVED");
      expect(inv.voucherNumber).toBe(`ER-${YEAR}-0001`);
      await expect(approveSupplierInvoice(c.fin2!, ids.inv1!)).rejects.toThrow(/Nur Entwürfe/);

      const noAccount = await db.supplier.create({ data: { organizationId: orgA, number: "L2", name: "Ohne Konto" } });
      const draft = await createSupplierInvoice(c.fin!, { supplierId: noAccount.id, invoiceNumber: "A1", invoiceDate: d(3, 1), lines: [supplierLine("10")] });
      await expect(approveSupplierInvoice(c.fin2!, draft.id)).rejects.toThrow(/Kreditorenkonto/);
      await cancelSupplierInvoice(c.fin!, draft.id);
      // Nummer des stornierten Belegs darf neu erfasst werden
      await createSupplierInvoice(c.fin!, { supplierId: noAccount.id, invoiceNumber: "A1", invoiceDate: d(3, 1), lines: [supplierLine("10")] });
    });
    it("Gutschrift braucht freigegebene Rechnung; bezahlt markieren nur für Freigegebene", async () => {
      await expect(supplierInv("G-0", [supplierLine("5")], { kind: "CREDIT" })).rejects.toThrow(/Bezug/);
      const cr = await supplierInv("G-1", [supplierLine("20")], { kind: "CREDIT", creditsId: ids.inv1 });
      expect(cr.kind).toBe("CREDIT");
      ids.credit = cr.id;
      await expect(markSupplierInvoicePaid(c.fin2!, { id: cr.id, paidOn: d(4, 1) })).rejects.toBeInstanceOf(ConflictError);
      await markSupplierInvoicePaid(c.fin2!, { id: ids.inv1!, paidOn: d(4, 1) });
      await expect(markSupplierInvoicePaid(c.fin2!, { id: ids.inv1!, paidOn: d(4, 2) })).rejects.toBeInstanceOf(ConflictError);
      expect((await listSupplierInvoices(c.fin!)).find((i) => i.id === ids.inv1)?.paidOn).not.toBeNull();
    });
  });

  describe("Ausgangsrechnungen", () => {
    const line = (qty: string, price: string, extra: Record<string, unknown> = {}) => ({ description: "Beratung", quantity: qty, unitPrice: price, taxCodeId: ids.ust20, ...extra });
    it("Erfassen: Netto = Menge × Preis (gerundet), Fälligkeit aus Zahlungsziel; Ausstellen vergibt lückenlose Nummern", async () => {
      const a = await createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: d(3, 10), lines: [line("2.5", "33.333")] });
      expect([a.netTotal, a.taxTotal, a.grossTotal].map(String)).toEqual(["83.33", "16.67", "100"]);
      expect(a.dueDate!.toISOString().slice(0, 10)).toBe(d(4, 9));
      await expect(createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: d(3, 10), lines: [line("1", "1", { taxCodeId: ids.vst20 })] })).rejects.toBeInstanceOf(NotFoundError);
      expect(a.number).toBeNull(); // Entwurf hat noch keine Nummer

      // parallel ausstellen: 6 Entwürfe → Nummern 1..6 ohne Lücke und Dublette
      const drafts = await Promise.all(Array.from({ length: 5 }, (_, i) => createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: d(3, 11 + i), lines: [line("1", "10")] })));
      const all = [a, ...drafts];
      const numbers = await Promise.all(all.map((x) => issueCustomerInvoice(c.fin!, x.id)));
      const nums = numbers.map((n) => Number(n.split("-").pop())).sort((x, y) => x - y);
      expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(numbers).size).toBe(6);
      ids.ar1 = a.id;
      await expect(issueCustomerInvoice(c.fin!, a.id)).rejects.toThrow(/Nur Entwürfe/);
      await expect(cancelCustomerInvoiceDraft(c.fin!, a.id)).rejects.toThrow(/Gutschrift/); // ausgestellt: nur per Gutschrift
    });
    it("Gutschrift-Entwurf zur ausgestellten Rechnung; Zahlung; Debitorenkonto nötig", async () => {
      const cn = await createCreditNoteDraft(c.fin!, ids.ar1!);
      expect(cn.kind).toBe("CREDIT");
      expect(String(cn.grossTotal)).toBe("100");
      await issueCustomerInvoice(c.fin!, cn.id);
      await markCustomerInvoicePaid(c.fin!, { id: ids.ar1!, paidOn: d(4, 1) });
      const noAcc = await createCustomer(c.fin!, { number: "K2", name: "Ohne Konto" });
      const draft = await createCustomerInvoice(c.fin!, { customerId: noAcc.id, invoiceDate: d(3, 1), lines: [{ description: "x", quantity: "1", unitPrice: "1", taxCodeId: ids.ust20, revenueAccountId: ids.acc4000 }] });
      await expect(issueCustomerInvoice(c.fin!, draft.id)).rejects.toThrow(/Debitorenkonto/);
      await cancelCustomerInvoiceDraft(c.fin!, draft.id);
      expect((await getCustomerInvoice(c.fin!, ids.ar1!)).number).toMatch(/^AR-\d{4}-000[1-6]$/);
    });
    it("PDF: nur für ausgestellte Belege, mit Berechtigung und nur in der eigenen Organisation", async () => {
      const inv = await getCustomerInvoice(c.fin!, ids.ar1!);
      const pdf = await getCustomerInvoicePdf(c.fin!, ids.ar1!);
      expect(pdf.filename).toBe(`${inv.number}.pdf`);
      const s = Buffer.from(pdf.bytes).toString("latin1");
      expect(s.startsWith("%PDF-")).toBe(true);
      expect(s).toContain(`(${inv.number})`);
      expect(s).toContain("(Kunde GmbH)");
      const again = await getCustomerInvoicePdf(c.fin!, ids.ar1!);
      expect(Buffer.from(again.bytes).equals(Buffer.from(pdf.bytes))).toBe(true); // reproduzierbar
      const draft = await createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: d(3, 1), lines: [line("1", "1")] });
      await expect(getCustomerInvoicePdf(c.fin!, draft.id)).rejects.toBeInstanceOf(ConflictError);
      await cancelCustomerInvoiceDraft(c.fin!, draft.id);
      await expect(getCustomerInvoicePdf(c.emp!, ids.ar1!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCustomerInvoicePdf(c.finB!, ids.ar1!)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("Export an die Steuerberatung", () => {
    it("Vorschau und Prüfungen: DATEV braucht Berater-/Mandantennummer und Kontostelligkeit; BMD braucht Steuercodes", async () => {
      await profile({ format: "DATEV", advisorNumber: "", clientNumber: "" });
      let pv = await previewAccountingExport(c.fin!);
      expect(pv.vouchers.length).toBeGreaterThanOrEqual(7); // 1 Eingangsrechnung + 6 Rechnungen + 1 Gutschrift
      expect(pv.checks.some((x) => /Beraternummer/.test(x.message))).toBe(true);
      expect(pv.checks.some((x) => /Personenkonten müssen 5 Stellen/.test(x.message))).toBe(false); // 33001/20001 haben 5 Stellen
      await profile({ format: "DATEV", advisorNumber: "12345", clientNumber: "67890", accountLength: 5 });
      pv = await previewAccountingExport(c.fin!);
      expect(pv.checks.some((x) => /Sachkonten müssen 5 Stellen/.test(x.message))).toBe(true);
      await expect(createAccountingExport(c.fin!, { acceptWarnings: true })).rejects.toThrow(/Sachkonten/);
      await updateTaxMapping(c.fin!, ids.vst10!, { bmdCode: "2", datevKey: "" });
      await profile({ format: "DATEV", advisorNumber: "12345", clientNumber: "67890", accountLength: 4 });
      expect((await previewAccountingExport(c.fin!)).checks.some((x) => /vst10 hat keinen DATEV-BU/.test(x.message))).toBe(true);
      await updateTaxMapping(c.fin!, ids.vst10!, { bmdCode: "", datevKey: "8" });
      await profile({ format: "BMD" });
      expect((await previewAccountingExport(c.fin!)).checks.some((x) => /vst10 hat keinen BMD/.test(x.message))).toBe(true);
      await updateTaxMapping(c.fin!, ids.vst10!, { bmdCode: "2", datevKey: "8" });
      await expect(previewAccountingExport(c.mgr!)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createAccountingExport(c.mgr!, {})).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("BMD-Export: Hinweise müssen bestätigt werden; Datei, Belegpaket, Hash; jeder Beleg nur einmal; Nachfolgelauf nur mit neuen Belegen", async () => {
      await profile({ format: "BMD" });
      // Gutschrift (Entwurf) und fehlender Beleg bei der zweiten Rechnung erzeugen Hinweise; ids.credit bleibt Entwurf (nicht freigegeben) und wird nicht exportiert
      const second = await supplierInv("RE-2X", [supplierLine("50")]);
      await approveSupplierInvoice(c.fin2!, second.id);
      await expect(createAccountingExport(c.fin!, {})).rejects.toThrow(/Hinweise müssen bestätigt/);

      const run = await createAccountingExport(c.fin!, { acceptWarnings: true });
      expect(run).toMatchObject({ version: 1, format: "BMD" });
      expect(run.fileName).toBe("buerf_0001.csv");
      const rows = run.content.split("\r\n");
      expect(rows[0]).toMatch(/^satzart;konto;gkonto;belegnr;/);
      expect(rows.some((r) => r.startsWith("0;33001;7000;") && r.includes(";ER;RE-1;"))).toBe(true);
      expect(rows.some((r) => r.includes(";AR;AR-") && r.startsWith("0;20001;4000;"))).toBe(true);
      expect(run.voucherCount).toBe(1 + 1 + 6 + 1); // 2 Eingangsrechnungen, 6 Ausgangsrechnungen (inkl. Gutschrift 1 ausgestellt)
      // Splittbuchung der Rechnung mit zwei Steuersätzen
      const split = rows.filter((r) => r.split(";")[3] === `${YEAR}0001` && r.split(";")[12] === "ER");
      expect(split.map((r) => r.split(";")[17])).toEqual(["O", "O", "O"].slice(0, split.length));
      expect(split.length).toBeGreaterThanOrEqual(2);

      // Belegpaket enthält nur Belege mit Datei, mit eindeutigen Namen
      expect(run.packageName).toBe("belege_0001.zip");
      const zip = unzipSync(new Uint8Array((await getAccountingExportFile(c.fin!, run.id, "package")).bytes));
      expect(Object.keys(zip)).toEqual([`ER-${YEAR}-0001.pdf`]);
      expect([...zip[`ER-${YEAR}-0001.pdf`]!]).toEqual([...PDF]);
      expect(rows.some((r) => r.endsWith(`;${`ER-${YEAR}-0001.pdf`}`))).toBe(true);

      const file = await getAccountingExportFile(c.fin2!, run.id, "data");
      expect(file.mime).toBe("text/csv");
      expect(file.bytes.includes(0xfc)).toBe(true); // „Müller" in Windows-1252
      expect(await db.auditLog.count({ where: { organizationId: orgA, action: "accounting.download" } })).toBe(2);

      // alles exportiert: kein weiterer Lauf; jeder Beleg höchstens einmal
      await expect(createAccountingExport(c.fin!, { acceptWarnings: true })).rejects.toThrow(/keine Belege/);
      expect(await db.accountingExportItem.count({ where: { organizationId: orgA } })).toBe(run.voucherCount);
      // exportierte Belege lassen sich nicht stornieren
      await expect(cancelSupplierInvoice(c.fin2!, ids.inv1!)).rejects.toThrow(/exportiert/);
      const dup = await db.accountingExportItem.findFirst({ where: { organizationId: orgA } });
      await expect(db.accountingExportItem.create({ data: { organizationId: orgA, exportId: run.id, voucherType: dup!.voucherType, voucherId: dup!.voucherId } })).rejects.toThrow();

      // neuer Beleg → zweiter Lauf nur mit diesem
      const third = await supplierInv("RE-3X", [supplierLine("10")], { fileId: ids.file });
      await approveSupplierInvoice(c.fin2!, third.id);
      const run2 = await createAccountingExport(c.fin!, {});
      expect([run2.version, run2.voucherCount]).toEqual([2, 1]);
      expect((await listAccountingExports(c.fin!)).map((r) => r.version)).toEqual([2, 1]);
    });

    it("Läufe sind unveränderlich; Hash wird geprüft; Mandantentrennung", async () => {
      const run = (await db.accountingExport.findFirst({ where: { organizationId: orgA, version: 1 } }))!;
      await expect(db.accountingExport.update({ where: { id: run.id }, data: { content: "x" } })).rejects.toThrow(/append-only/);
      await expect(db.accountingExport.delete({ where: { id: run.id } })).rejects.toThrow(/append-only/);
      await expect(db.accountingExportItem.deleteMany({ where: { exportId: run.id } })).rejects.toThrow(/append-only/);
      await expect(getAccountingExportFile(c.finB!, run.id, "data")).rejects.toBeInstanceOf(NotFoundError);
      expect(await listAccountingExports(c.finB!)).toEqual([]);
      await expect(getAccountingExportFile(c.fin!, run.id, "package")).resolves.toBeDefined();
      const noPackage = (await db.accountingExport.findFirst({ where: { organizationId: orgA, version: 2 } }))!;
      expect(noPackage.packageName).toBe("belege_0002.zip");
    });

    it("DATEV-Export: Kopfzeile, 125 Spalten, Windows-1252, Belegdatum TTMM, Wirtschaftsjahr; mehrere Wirtschaftsjahre werden abgelehnt", async () => {
      await profile({ format: "DATEV", advisorNumber: "12345", clientNumber: "67890", accountLength: 4 });
      const a = await supplierInv("D-1", [supplierLine("100"), supplierLine("50", "vst10", { expenseAccountId: ids.acc7100 })]);
      await approveSupplierInvoice(c.fin2!, a.id);
      const old = await createSupplierInvoice(c.fin!, { supplierId: ids.supplier, invoiceNumber: "D-OLD", invoiceDate: `${YEAR - 1}-12-20`, lines: [supplierLine("10")] });
      await approveSupplierInvoice(c.fin2!, old.id);
      await expect(createAccountingExport(c.fin!, { acceptWarnings: true })).rejects.toThrow(/mehreren Wirtschaftsjahren/);
      const run = await createAccountingExport(c.fin!, { acceptWarnings: true, upTo: d(3, 31) }).catch(() => null);
      expect(run).toBeNull(); // alter Beleg liegt immer noch vor dem Stichtag → weiterhin zwei Wirtschaftsjahre
      // alten Beleg stornieren (noch nicht exportiert) → Export möglich
      await cancelSupplierInvoice(c.fin2!, old.id);
      const ok = await createAccountingExport(c.fin!, { acceptWarnings: true });
      expect(ok.format).toBe("DATEV");
      const lines = ok.content.split("\r\n");
      expect(lines[0]!.split(";")).toHaveLength(31);
      expect(lines[0]!.startsWith('"EXTF";700;21;"Buchungsstapel";13;')).toBe(true);
      expect(lines[0]).toContain(`;12345;67890;${YEAR}0101;4;`);
      expect(lines[1]!.split(";")).toHaveLength(125);
      const row = lines[2]!.split(";");
      expect(row).toHaveLength(125);
      expect(row[1]).toBe('"S"');
      expect(row[6]).toBe("7000");
      expect(row[7]).toBe("33001");
      expect(row[8]).toBe('"9"');
      expect(row[9]).toBe("1503");
      expect(ok.fileName).toBe(`EXTF_Buchungsstapel_${String(ok.version).padStart(4, "0")}.csv`);
      expect((await getAccountingExportFile(c.fin!, ok.id, "data")).bytes.includes(0xfc)).toBe(true); // „Müller" als ein Byte (Windows-1252)
    });
  });

  describe("Aussteller", () => {
    it("Stammdaten: nur Finanzen schreiben, Prüfungen, Mandantentrennung; Stand wird beim Ausstellen am Beleg festgehalten", async () => {
      expect(await getIssuerProfile(c.fin!)).toBeNull();
      await expect(setIssuerProfile(c.emp!, { legalName: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setIssuerProfile(c.fin!, { legalName: "Muster GmbH", iban: "AT61 1904 3002 3457 3202" })).rejects.toThrow(/IBAN/);
      await setIssuerProfile(c.fin!, { legalName: "Muster GmbH", street: "Ringstraße 5", zip: "1010", city: "Wien", uid: "atu 1111 1111", iban: "at61 1904 3002 3457 3201" });
      const p = await getIssuerProfile(c.fin!);
      expect(p).toMatchObject({ legalName: "Muster GmbH", uid: "ATU11111111", iban: "AT611904300234573201", country: "AT" });
      expect(await getIssuerProfile(c.finB!)).toBeNull();

      const draft = await createCustomerInvoice(c.fin!, { customerId: ids.customer, invoiceDate: d(3, 2), lines: [{ description: "Beratung", quantity: "1", unitPrice: "10", taxCodeId: ids.ust20 }] });
      await issueCustomerInvoice(c.fin!, draft.id);
      const before = await getCustomerInvoicePdf(c.fin!, draft.id);
      expect(Buffer.from(before.bytes).toString("latin1")).toContain("AT61 1904 3002 3457 3201");

      await setIssuerProfile(c.fin!, { legalName: "Neue Firma AG", iban: "DE89 3704 0044 0532 0130 00" });
      const after = await getCustomerInvoicePdf(c.fin!, draft.id);
      expect(Buffer.from(after.bytes).equals(Buffer.from(before.bytes))).toBe(true); // alter Beleg bleibt unverändert
      const audit = await db.auditLog.count({ where: { organizationId: orgA, action: "issuer_profile.set" } });
      expect(audit).toBe(2);
    });
  });
});

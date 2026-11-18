import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, isoFromDate, addDays } from "@/modules/hr/queries";
import { receivingOf } from "@/modules/procurement/queries";
import { allocateTax } from "./tax";
import { matchInvoice } from "./match";
import { renderInvoicePdf, type IssuerDetails } from "./invoice-pdf";
import { sha256Hex } from "./formats/encoding";
import {
  accountInput, customerInput, issuerInput, customerInvoiceInput, paidInput, partnerAccountsInput, profileInput, supplierInvoiceInput, taxCodeInput,
} from "./schema";

type Tx = Prisma.TransactionClient;

const d = (v: Decimal.Value) => new Decimal(v);

async function nextNumber(tx: Tx, organizationId: string, prefix: string, year: number) {
  const key = `${prefix}-${year}`;
  const seq = await tx.sequence.upsert({ where: { organizationId_key: { organizationId, key } }, create: { organizationId, key, value: 1 }, update: { value: { increment: 1 } } });
  return `${key}-${String(seq.value).padStart(4, "0")}`;
}

// ───────────────────────── Stammdaten ─────────────────────────

export async function listAccounts(ctx: Ctx) {
  authorize(ctx, "finance.master.read");
  return db.account.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ type: "asc" }, { number: "asc" }] });
}

export async function createAccount(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = accountInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (await tx.account.findFirst({ where: { organizationId: ctx.organizationId, number: input.number } })) throw new ConflictError("Diese Kontonummer gibt es bereits");
    const created = await tx.account.create({ data: { organizationId: ctx.organizationId, ...input } });
    await writeAudit(tx, ctx, { action: "account.create", entityType: "Account", entityId: created.id, after: { number: created.number, type: created.type } });
    return created;
  });
}

/** Kontenplan importieren: Zeilen „Nummer;Bezeichnung[;Art]" (Art GL, VENDOR oder CUSTOMER; Standard GL). Alles oder nichts. */
export async function importAccounts(ctx: Ctx, text: string) {
  authorize(ctx, "finance.master.write");
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !/^(konto|nummer|number)\b/i.test(l));
  if (rows.length === 0) throw new ConflictError("Keine Zeilen zum Importieren");
  if (rows.length > 5000) throw new ConflictError("Höchstens 5000 Konten je Import");
  const parsed: { number: string; name: string; type: "GL" | "VENDOR" | "CUSTOMER" }[] = [];
  const errors: string[] = [];
  rows.forEach((line, i) => {
    const [number = "", name = "", type = "GL"] = line.split(";").map((x) => x.trim());
    const r = accountInput.safeParse({ number, name, type: type.toUpperCase() || "GL" });
    if (r.success) parsed.push(r.data);
    else errors.push(`Zeile ${i + 1}: ${r.error.issues[0]?.message ?? "ungültig"}`);
  });
  if (errors.length > 0) throw new ConflictError(`${errors.length} fehlerhafte Zeilen, nichts importiert: ${errors.slice(0, 5).join(" | ")}`);
  if (new Set(parsed.map((p) => p.number)).size !== parsed.length) throw new ConflictError("Die Datei enthält doppelte Kontonummern");
  return db.$transaction(async (tx) => {
    const r = await tx.account.createMany({ data: parsed.map((p) => ({ organizationId: ctx.organizationId, ...p })), skipDuplicates: true });
    await writeAudit(tx, ctx, { action: "account.import", entityType: "Account", entityId: ctx.organizationId, after: { rows: parsed.length, created: r.count } });
    return { created: r.count, skipped: parsed.length - r.count };
  });
}

export async function listTaxCodes(ctx: Ctx) {
  authorize(ctx, "finance.master.read");
  return db.taxCode.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ direction: "asc" }, { rate: "asc" }, { key: "asc" }] });
}

export async function createTaxCode(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = taxCodeInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (await tx.taxCode.findFirst({ where: { organizationId: ctx.organizationId, key: input.key } })) throw new ConflictError("Dieser Schlüssel existiert bereits");
    const created = await tx.taxCode.create({ data: { organizationId: ctx.organizationId, key: input.key, name: input.name, rate: input.rate, direction: input.direction, bmdCode: input.bmdCode ?? null, datevKey: input.datevKey ?? null } });
    await writeAudit(tx, ctx, { action: "tax_code.create", entityType: "TaxCode", entityId: created.id, after: { key: created.key, rate: input.rate.toString() } });
    return created;
  });
}

export async function updateTaxMapping(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = taxCodeInput.pick({ bmdCode: true, datevKey: true }).parse(raw);
  return db.$transaction(async (tx) => {
    const t = await tx.taxCode.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!t) throw new NotFoundError("Steuerkennzeichen");
    await tx.taxCode.update({ where: { id }, data: { bmdCode: input.bmdCode ?? null, datevKey: input.datevKey ?? null } });
    await writeAudit(tx, ctx, { action: "tax_code.map", entityType: "TaxCode", entityId: id, before: { bmdCode: t.bmdCode, datevKey: t.datevKey }, after: { bmdCode: input.bmdCode ?? null, datevKey: input.datevKey ?? null } });
  });
}

async function accountOfType(tx: Tx, organizationId: string, id: string | null | undefined, type: "GL" | "VENDOR" | "CUSTOMER", what: string) {
  if (!id) return null;
  const a = await tx.account.findFirst({ where: { id, organizationId, type, active: true } });
  if (!a) throw new NotFoundError(what);
  return a;
}

/** Kreditorenkonto und Standard-Aufwandskonto eines Lieferanten (und dessen UID) festlegen. */
export async function setSupplierAccounts(ctx: Ctx, supplierId: string, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = partnerAccountsInput.parse(raw);
  return db.$transaction(async (tx) => {
    const s = await tx.supplier.findFirst({ where: { id: supplierId, organizationId: ctx.organizationId } });
    if (!s) throw new NotFoundError("Lieferant");
    await accountOfType(tx, ctx.organizationId, input.accountId, "VENDOR", "Kreditorenkonto");
    await accountOfType(tx, ctx.organizationId, input.lineAccountId, "GL", "Aufwandskonto");
    await tx.supplier.update({ where: { id: supplierId }, data: { uid: input.uid ?? null, payableAccountId: input.accountId ?? null, expenseAccountId: input.lineAccountId ?? null } });
    await writeAudit(tx, ctx, { action: "supplier.accounts", entityType: "Supplier", entityId: supplierId, after: { payable: input.accountId ?? null, expense: input.lineAccountId ?? null } });
  });
}

export async function listCustomers(ctx: Ctx) {
  authorize(ctx, "finance.master.read");
  return db.customer.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { number: "asc" } });
}

export async function createCustomer(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = customerInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (await tx.customer.findFirst({ where: { organizationId: ctx.organizationId, number: input.number } })) throw new ConflictError("Diese Kundennummer gibt es bereits");
    const created = await tx.customer.create({
      data: { organizationId: ctx.organizationId, number: input.number, name: input.name, street: input.street ?? null, zip: input.zip ?? null, city: input.city ?? null, country: input.country, uid: input.uid ?? null, paymentTermsDays: input.paymentTermsDays },
    });
    await writeAudit(tx, ctx, { action: "customer.create", entityType: "Customer", entityId: created.id, after: { number: created.number } });
    return created;
  });
}

export async function setCustomerAccounts(ctx: Ctx, customerId: string, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = partnerAccountsInput.parse(raw);
  return db.$transaction(async (tx) => {
    const c = await tx.customer.findFirst({ where: { id: customerId, organizationId: ctx.organizationId } });
    if (!c) throw new NotFoundError("Kunde");
    await accountOfType(tx, ctx.organizationId, input.accountId, "CUSTOMER", "Debitorenkonto");
    await accountOfType(tx, ctx.organizationId, input.lineAccountId, "GL", "Erlöskonto");
    await tx.customer.update({ where: { id: customerId }, data: { uid: input.uid ?? null, receivableAccountId: input.accountId ?? null, revenueAccountId: input.lineAccountId ?? null } });
    await writeAudit(tx, ctx, { action: "customer.accounts", entityType: "Customer", entityId: customerId, after: { receivable: input.accountId ?? null, revenue: input.lineAccountId ?? null } });
  });
}

export const DEFAULT_ACCOUNTING_PROFILE = { format: "BMD", advisorNumber: null, clientNumber: null, accountLength: 4, fiscalYearStartMonth: 1, symbolIn: "ER", symbolOut: "AR", dictationCode: "", includeFiles: true } as const;

export async function getAccountingProfile(ctx: Ctx, tx: Tx | typeof db = db) {
  if (tx === db) authorize(ctx, "finance.export.read");
  return (await tx.accountingProfile.findUnique({ where: { organizationId: ctx.organizationId } })) ?? { organizationId: ctx.organizationId, ...DEFAULT_ACCOUNTING_PROFILE };
}

export async function setAccountingProfile(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const input = profileInput.parse(raw);
  return db.$transaction(async (tx) => {
    const data = { ...input, advisorNumber: input.advisorNumber ?? null, clientNumber: input.clientNumber ?? null };
    const before = await getAccountingProfile(ctx, tx);
    await tx.accountingProfile.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
    await writeAudit(tx, ctx, { action: "accounting_profile.set", entityType: "AccountingProfile", entityId: ctx.organizationId, before: before as unknown as Prisma.InputJsonValue, after: data });
  });
}

// ───────────────────────── Aussteller ─────────────────────────

export type IssuerProfileData = z.infer<typeof issuerInput>;

/** Aussteller-Stammdaten (Briefkopf, Bankverbindung). null, solange nichts hinterlegt ist. */
export async function getIssuerProfile(ctx: Ctx, tx: Tx | typeof db = db) {
  if (tx === db) authorize(ctx, "finance.master.read");
  const { organizationId: _o, ...rest } = (await tx.issuerProfile.findUnique({ where: { organizationId: ctx.organizationId } })) ?? { organizationId: "" };
  return "legalName" in rest ? (rest as IssuerProfileData) : null;
}

export async function setIssuerProfile(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const data = issuerInput.parse(raw);
  const clean = { ...data, uid: data.uid?.replace(/\s+/g, "").toUpperCase() ?? null, iban: data.iban?.replace(/\s+/g, "").toUpperCase() ?? null, bic: data.bic?.toUpperCase() ?? null };
  const row = { street: null, zip: null, city: null, companyRegister: null, bankName: null, email: null, phone: null, ...clean };
  return db.$transaction(async (tx) => {
    const before = await getIssuerProfile(ctx, tx);
    await tx.issuerProfile.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...row }, update: row });
    await writeAudit(tx, ctx, { action: "issuer_profile.set", entityType: "IssuerProfile", entityId: ctx.organizationId, before: (before ?? undefined) as unknown as Prisma.InputJsonValue, after: row as unknown as Prisma.InputJsonValue });
  });
}

// ───────────────────────── Belegdateien ─────────────────────────

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Erkennt den Dateityp an den ersten Bytes (der vom Client gemeldete Typ wird ignoriert). */
export function sniffMime(b: Uint8Array): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

export const safeFileName = (name: string) => (name.split(/[\\/]/).pop() ?? "beleg").replace(/[^\w.\- ()äöüÄÖÜß]/g, "_").slice(0, 120) || "beleg";

export async function uploadFile(ctx: Ctx, input: { name: string; bytes: Uint8Array }) {
  authorize(ctx, "finance.invoice.in.create");
  if (input.bytes.length === 0) throw new ConflictError("Die Datei ist leer");
  if (input.bytes.length > MAX_FILE_BYTES) throw new ConflictError("Die Datei ist größer als 8 MB");
  const mime = sniffMime(input.bytes);
  if (!mime) throw new ConflictError("Nur PDF-, PNG- und JPEG-Dateien sind erlaubt");
  return db.$transaction(async (tx) => {
    const created = await tx.financeFile.create({
      data: { organizationId: ctx.organizationId, name: safeFileName(input.name), mime, size: input.bytes.length, sha256: sha256Hex(input.bytes), data: Buffer.from(input.bytes), uploadedById: ctx.userId },
      select: { id: true, name: true, mime: true, size: true, sha256: true },
    });
    await writeAudit(tx, ctx, { action: "finance_file.upload", entityType: "FinanceFile", entityId: created.id, after: { name: created.name, size: created.size, sha256: created.sha256 } });
    return created;
  });
}

export async function getFile(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.read");
  const f = await db.financeFile.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!f) throw new NotFoundError("Beleg");
  if (sha256Hex(f.data) !== f.sha256) throw new Error("Integritätsprüfung fehlgeschlagen: Belegdatei weicht vom Upload ab");
  return f;
}

// ───────────────────────── Eingangsrechnungen ─────────────────────────

async function priceLines<T extends { taxCodeId: string; net: Decimal }>(tx: Tx, organizationId: string, direction: "INPUT" | "OUTPUT", lines: T[]) {
  const codes = await tx.taxCode.findMany({ where: { organizationId, id: { in: [...new Set(lines.map((l) => l.taxCodeId))] }, active: true, direction } });
  const byId = new Map(codes.map((c) => [c.id, c]));
  for (const l of lines) if (!byId.has(l.taxCodeId)) throw new NotFoundError(direction === "INPUT" ? "Steuerkennzeichen (Vorsteuer)" : "Steuerkennzeichen (Umsatzsteuer)");
  const tax = allocateTax(lines.map((l) => ({ net: l.net, rate: byId.get(l.taxCodeId)!.rate.toString(), group: l.taxCodeId })));
  return { tax, byId };
}

export async function createSupplierInvoice(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.invoice.in.create");
  const input = supplierInvoiceInput.parse(raw);
  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, organizationId: ctx.organizationId, active: true } });
    if (!supplier) throw new NotFoundError("Lieferant");
    if (await tx.supplierInvoice.findFirst({ where: { organizationId: ctx.organizationId, supplierId: supplier.id, invoiceNumber: input.invoiceNumber, status: { not: "CANCELLED" } } }))
      throw new ConflictError(`Die Rechnungsnummer ${input.invoiceNumber} ist für diesen Lieferanten bereits erfasst`);
    if (input.fileId && !(await tx.financeFile.findFirst({ where: { id: input.fileId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Beleg");
    if (input.purchaseOrderId && !(await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, organizationId: ctx.organizationId, supplierId: supplier.id }, select: { id: true } }))) throw new NotFoundError("Bestellung dieses Lieferanten");
    if (input.kind === "CREDIT") {
      const orig = input.creditsId ? await tx.supplierInvoice.findFirst({ where: { id: input.creditsId, organizationId: ctx.organizationId, supplierId: supplier.id, kind: "INVOICE", status: "APPROVED" } }) : null;
      if (!orig) throw new ConflictError("Eine Gutschrift braucht eine freigegebene Rechnung desselben Lieferanten als Bezug");
    }
    for (const l of input.lines) {
      const acc = l.expenseAccountId ?? supplier.expenseAccountId;
      if (acc && !(await tx.account.findFirst({ where: { id: acc, organizationId: ctx.organizationId, type: "GL", active: true } }))) throw new NotFoundError("Aufwandskonto");
      if (l.costCenterId && !(await tx.costCenter.findFirst({ where: { id: l.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    }
    const { tax } = await priceLines(tx, ctx.organizationId, "INPUT", input.lines.map((l) => ({ taxCodeId: l.taxCodeId, net: l.netAmount })));
    const created = await tx.supplierInvoice.create({
      data: {
        organizationId: ctx.organizationId, supplierId: supplier.id, invoiceNumber: input.invoiceNumber, invoiceDate: dateFromIso(input.invoiceDate),
        dueDate: input.dueDate ? dateFromIso(input.dueDate) : null, kind: input.kind, creditsId: input.creditsId ?? null, purchaseOrderId: input.purchaseOrderId ?? null,
        fileId: input.fileId ?? null, note: input.note ?? null, netTotal: tax.netTotal, taxTotal: tax.taxTotal, grossTotal: tax.grossTotal, createdById: ctx.userId,
        lines: { create: input.lines.map((l) => ({ description: l.description, netAmount: l.netAmount, taxCodeId: l.taxCodeId, expenseAccountId: l.expenseAccountId ?? supplier.expenseAccountId ?? "", costCenterId: l.costCenterId ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "supplier_invoice.create", entityType: "SupplierInvoice", entityId: created.id, after: { supplierId: supplier.id, number: input.invoiceNumber, gross: tax.grossTotal.toString(), kind: input.kind } });
    return created;
  });
}


/** Drei-Wege-Abgleich einer Eingangsrechnung mit Bestellung und Wareneingang. Nur Rechnungen mit Bestellbezug werden abgeglichen; Gutschriften nicht. */
async function computeMatch(tx: Tx, organizationId: string, inv: { id: string; kind: string; purchaseOrderId: string | null; netTotal: Prisma.Decimal }) {
  if (!inv.purchaseOrderId || inv.kind !== "INVOICE") return { applicable: false as const };
  const rec = await receivingOf(tx, organizationId, inv.purchaseOrderId);
  if (!rec) throw new NotFoundError("Bestellung");
  const approved = await tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", id: { not: inv.id }, OR: [{ purchaseOrderId: inv.purchaseOrderId }] }, select: { id: true, kind: true, netTotal: true } });
  const invoiceIds = approved.filter((a) => a.kind === "INVOICE").map((a) => a.id);
  const credits = await tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", kind: "CREDIT", creditsId: { in: invoiceIds } }, select: { netTotal: true } });
  const already = approved.filter((a) => a.kind === "INVOICE").reduce((a, x) => a.plus(x.netTotal.toString()), d(0)).minus(credits.reduce((a, x) => a.plus(x.netTotal.toString()), d(0)));
  const result = matchInvoice({ orderedNet: rec.orderedNet, receivedNet: rec.receivedNet, alreadyInvoicedNet: already, invoiceNet: inv.netTotal.toString() });
  return { applicable: true as const, ...result, orderedNet: rec.orderedNet, receivedNet: rec.receivedNet, alreadyInvoicedNet: already, deliveryStatus: rec.status, orderNumber: rec.order.number };
}

export async function getInvoiceMatch(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.read");
  const inv = await db.supplierInvoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!inv) throw new NotFoundError("Eingangsrechnung");
  return computeMatch(db as unknown as Tx, ctx.organizationId, inv);
}

/** Abweichung vom Abgleich ausdrücklich akzeptieren (eigene Berechtigung, Begründung, nicht durch die erfassende Person). */
export async function acceptInvoiceVariance(ctx: Ctx, id: string, reason: string) {
  authorize(ctx, "finance.invoice.in.accept_variance");
  const why = reason.trim();
  if (why.length < 5) throw new ConflictError("Bitte eine Begründung (mind. 5 Zeichen) angeben");
  return db.$transaction(async (tx) => {
    const inv = await tx.supplierInvoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!inv) throw new NotFoundError("Eingangsrechnung");
    if (inv.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können akzeptiert werden");
    if (inv.createdById === ctx.userId) throw new ConflictError("Eigene Erfassungen dürfen nicht selbst akzeptiert werden (Vier-Augen-Prinzip)");
    if (inv.varianceAcceptedAt) throw new ConflictError("Die Abweichung wurde bereits akzeptiert");
    const m = await computeMatch(tx, ctx.organizationId, inv);
    if (!m.applicable || m.status !== "VARIANCE") throw new ConflictError("Es gibt keine Abweichung, die akzeptiert werden müsste");
    await tx.supplierInvoice.update({ where: { id }, data: { varianceAcceptedById: ctx.userId, varianceAcceptedAt: new Date(), varianceReason: why } });
    await writeAudit(tx, ctx, { action: "supplier_invoice.accept_variance", entityType: "SupplierInvoice", entityId: id, after: { reason: why, variances: m.variances.map((v) => ({ code: v.code, excess: v.excess.toString() })) } });
  });
}

/** Freigabe nach dem Vier-Augen-Prinzip: nicht durch die Person, die den Beleg erfasst hat. Vergibt die interne Belegnummer. */
export async function approveSupplierInvoice(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.in.approve");
  return db.$transaction(async (tx) => {
    const inv = await tx.supplierInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { supplier: true, lines: true } });
    if (!inv) throw new NotFoundError("Eingangsrechnung");
    if (inv.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können freigegeben werden");
    if (inv.createdById === ctx.userId) throw new ConflictError("Eigene Erfassungen dürfen nicht selbst freigegeben werden (Vier-Augen-Prinzip)");
    if (!inv.supplier.payableAccountId) throw new ConflictError("Für den Lieferanten ist kein Kreditorenkonto hinterlegt");
    if (inv.purchaseOrderId) {
      // parallele Freigaben zur selben Bestellung dürfen den Abgleich nicht gemeinsam umgehen
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${inv.purchaseOrderId} FOR UPDATE`;
      const m = await computeMatch(tx, ctx.organizationId, inv);
      if (m.applicable && m.status === "VARIANCE" && !inv.varianceAcceptedAt)
        throw new ConflictError(`Abgleich mit Bestellung und Wareneingang: ${m.variances.map((v) => v.message).join(" ")} Die Abweichung muss zuerst mit Begründung akzeptiert werden.`);
    }
    if (inv.lines.some((l) => !l.expenseAccountId)) throw new ConflictError("Nicht jede Position hat ein Aufwandskonto");
    const claimed = await tx.supplierInvoice.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date(), voucherNumber: await nextNumber(tx, ctx.organizationId, "ER", inv.invoiceDate.getUTCFullYear()) } });
    if (claimed.count !== 1) throw new ConflictError("Der Beleg wurde bereits bearbeitet");
    await writeAudit(tx, ctx, { action: "supplier_invoice.approve", entityType: "SupplierInvoice", entityId: id });
  });
}

async function exportedIds(tx: Tx, organizationId: string, type: "SUPPLIER" | "CUSTOMER", ids: string[]) {
  const rows = await tx.accountingExportItem.findMany({ where: { organizationId, voucherType: type, voucherId: { in: ids } }, select: { voucherId: true } });
  return new Set(rows.map((r) => r.voucherId));
}

export async function cancelSupplierInvoice(ctx: Ctx, id: string) {
  return db.$transaction(async (tx) => {
    const inv = await tx.supplierInvoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!inv) throw new NotFoundError("Eingangsrechnung");
    authorize(ctx, inv.status === "DRAFT" ? "finance.invoice.in.create" : "finance.invoice.in.approve");
    if (inv.status === "CANCELLED") throw new ConflictError("Der Beleg ist bereits storniert");
    if ((await exportedIds(tx, ctx.organizationId, "SUPPLIER", [id])).has(id)) throw new ConflictError("Der Beleg wurde bereits an die Steuerberatung exportiert. Bitte eine Gutschrift erfassen");
    await tx.supplierInvoice.update({ where: { id }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "supplier_invoice.cancel", entityType: "SupplierInvoice", entityId: id, before: { status: inv.status } });
  });
}

export async function markSupplierInvoicePaid(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.invoice.in.approve");
  const input = paidInput.parse(raw);
  return db.$transaction(async (tx) => {
    const r = await tx.supplierInvoice.updateMany({ where: { id: input.id, organizationId: ctx.organizationId, status: "APPROVED", paidOn: null }, data: { paidOn: dateFromIso(input.paidOn) } });
    if (r.count !== 1) throw new ConflictError("Nur freigegebene, noch nicht bezahlte Belege können als bezahlt markiert werden");
    await writeAudit(tx, ctx, { action: "supplier_invoice.paid", entityType: "SupplierInvoice", entityId: input.id, after: { paidOn: input.paidOn } });
  });
}

export async function listSupplierInvoices(ctx: Ctx) {
  authorize(ctx, "finance.invoice.read");
  const rows = await db.supplierInvoice.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 200, include: { supplier: { select: { number: true, name: true } } } });
  const exported = await exportedIds(db as unknown as Tx, ctx.organizationId, "SUPPLIER", rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, exported: exported.has(r.id) }));
}

export async function getSupplierInvoice(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.read");
  const inv = await db.supplierInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { supplier: true, lines: true } });
  if (!inv) throw new NotFoundError("Eingangsrechnung");
  const exported = (await exportedIds(db as unknown as Tx, ctx.organizationId, "SUPPLIER", [id])).has(id);
  const [taxCodes, accounts] = await Promise.all([
    db.taxCode.findMany({ where: { organizationId: ctx.organizationId, id: { in: inv.lines.map((l) => l.taxCodeId) } } }),
    db.account.findMany({ where: { organizationId: ctx.organizationId, id: { in: inv.lines.map((l) => l.expenseAccountId) } } }),
  ]);
  return { ...inv, exported, taxCodes, accounts };
}

// ───────────────────────── Ausgangsrechnungen ─────────────────────────

export async function createCustomerInvoice(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.invoice.out.create");
  const input = customerInvoiceInput.parse(raw);
  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, organizationId: ctx.organizationId, active: true } });
    if (!customer) throw new NotFoundError("Kunde");
    if (input.kind === "CREDIT") {
      const orig = input.creditsId ? await tx.customerInvoice.findFirst({ where: { id: input.creditsId, organizationId: ctx.organizationId, customerId: customer.id, kind: "INVOICE", status: "ISSUED" } }) : null;
      if (!orig) throw new ConflictError("Eine Gutschrift braucht eine ausgestellte Rechnung desselben Kunden als Bezug");
    }
    for (const l of input.lines) {
      const acc = l.revenueAccountId ?? customer.revenueAccountId;
      if (acc && !(await tx.account.findFirst({ where: { id: acc, organizationId: ctx.organizationId, type: "GL", active: true } }))) throw new NotFoundError("Erlöskonto");
      if (l.costCenterId && !(await tx.costCenter.findFirst({ where: { id: l.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    }
    const lines = input.lines.map((l) => ({ ...l, net: l.quantity.times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) }));
    const { tax } = await priceLines(tx, ctx.organizationId, "OUTPUT", lines);
    const due = input.dueDate ?? addDays(input.invoiceDate, customer.paymentTermsDays);
    const created = await tx.customerInvoice.create({
      data: {
        organizationId: ctx.organizationId, customerId: customer.id, invoiceDate: dateFromIso(input.invoiceDate), dueDate: dateFromIso(due), kind: input.kind, creditsId: input.creditsId ?? null,
        note: input.note ?? null, netTotal: tax.netTotal, taxTotal: tax.taxTotal, grossTotal: tax.grossTotal, createdById: ctx.userId,
        lines: { create: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, netAmount: l.net, taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId ?? customer.revenueAccountId ?? "", costCenterId: l.costCenterId ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "customer_invoice.create", entityType: "CustomerInvoice", entityId: created.id, after: { customerId: customer.id, gross: tax.grossTotal.toString(), kind: input.kind } });
    return created;
  });
}

/** Ausstellen vergibt die lückenlose Nummer und friert den Beleg ein. Korrekturen erfolgen nur noch per Gutschrift. */
export async function issueCustomerInvoice(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.out.issue");
  return db.$transaction(async (tx) => {
    const inv = await tx.customerInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { customer: true, lines: true } });
    if (!inv) throw new NotFoundError("Ausgangsrechnung");
    if (inv.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können ausgestellt werden");
    if (!inv.customer.receivableAccountId) throw new ConflictError("Für den Kunden ist kein Debitorenkonto hinterlegt");
    if (inv.lines.some((l) => !l.revenueAccountId)) throw new ConflictError("Nicht jede Position hat ein Erlöskonto");
    // Zeilensperre auf den Entwurf: gleichzeitiges Ausstellen vergibt genau eine Nummer
    const claimed = await tx.customerInvoice.updateMany({ where: { id, status: "DRAFT" }, data: { status: "ISSUED", issuedById: ctx.userId, issuedAt: new Date() } });
    if (claimed.count !== 1) throw new ConflictError("Der Beleg wurde bereits ausgestellt");
    const number = await nextNumber(tx, ctx.organizationId, "AR", inv.invoiceDate.getUTCFullYear());
    const issuer = await getIssuerProfile(ctx, tx);
    await tx.customerInvoice.update({ where: { id }, data: { number, issuerSnapshot: (issuer ?? undefined) as unknown as Prisma.InputJsonValue | undefined } });
    await writeAudit(tx, ctx, { action: "customer_invoice.issue", entityType: "CustomerInvoice", entityId: id, after: { number, gross: inv.grossTotal.toString() } });
    return number;
  });
}

export async function cancelCustomerInvoiceDraft(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.out.create");
  return db.$transaction(async (tx) => {
    const r = await tx.customerInvoice.updateMany({ where: { id, organizationId: ctx.organizationId, status: "DRAFT" }, data: { status: "CANCELLED" } });
    if (r.count !== 1) throw new ConflictError("Nur Entwürfe können verworfen werden; ausgestellte Rechnungen werden per Gutschrift korrigiert");
    await writeAudit(tx, ctx, { action: "customer_invoice.cancel_draft", entityType: "CustomerInvoice", entityId: id });
  });
}

/** Legt zu einer ausgestellten Rechnung eine Gutschrift (Entwurf) mit denselben Positionen an. */
export async function createCreditNoteDraft(ctx: Ctx, invoiceId: string) {
  authorize(ctx, "finance.invoice.out.create");
  const inv = await db.customerInvoice.findFirst({ where: { id: invoiceId, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!inv || inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw new ConflictError("Gutschriften sind nur zu ausgestellten Rechnungen möglich");
  return createCustomerInvoice(ctx, {
    customerId: inv.customerId, invoiceDate: isoFromDate(new Date()), kind: "CREDIT", creditsId: inv.id, note: `Gutschrift zu ${inv.number}`,
    lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId, costCenterId: l.costCenterId })),
  });
}

export async function markCustomerInvoicePaid(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.invoice.out.issue");
  const input = paidInput.parse(raw);
  return db.$transaction(async (tx) => {
    const r = await tx.customerInvoice.updateMany({ where: { id: input.id, organizationId: ctx.organizationId, status: "ISSUED", paidOn: null }, data: { paidOn: dateFromIso(input.paidOn) } });
    if (r.count !== 1) throw new ConflictError("Nur ausgestellte, noch nicht bezahlte Rechnungen können als bezahlt markiert werden");
    await writeAudit(tx, ctx, { action: "customer_invoice.paid", entityType: "CustomerInvoice", entityId: input.id, after: { paidOn: input.paidOn } });
  });
}

export async function listCustomerInvoices(ctx: Ctx) {
  authorize(ctx, "finance.invoice.read");
  const rows = await db.customerInvoice.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 200, include: { customer: { select: { number: true, name: true } } } });
  const exported = await exportedIds(db as unknown as Tx, ctx.organizationId, "CUSTOMER", rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, exported: exported.has(r.id) }));
}

export async function getCustomerInvoice(ctx: Ctx, id: string) {
  authorize(ctx, "finance.invoice.read");
  const inv = await db.customerInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { customer: true, lines: true } });
  if (!inv) throw new NotFoundError("Ausgangsrechnung");
  const exported = (await exportedIds(db as unknown as Tx, ctx.organizationId, "CUSTOMER", [id])).has(id);
  const [taxCodes, accounts] = await Promise.all([
    db.taxCode.findMany({ where: { organizationId: ctx.organizationId, id: { in: inv.lines.map((l) => l.taxCodeId) } } }),
    db.account.findMany({ where: { organizationId: ctx.organizationId, id: { in: inv.lines.map((l) => l.revenueAccountId) } } }),
  ]);
  return { ...inv, exported, taxCodes, accounts };
}

/** PDF einer ausgestellten Ausgangsrechnung oder Gutschrift (Entwürfe haben keine Nummer und kein PDF). */
export async function getCustomerInvoicePdf(ctx: Ctx, id: string) {
  const inv = await getCustomerInvoice(ctx, id); // prüft finance.invoice.read und Mandant
  if (inv.status !== "ISSUED" || !inv.number) throw new ConflictError("Ein PDF gibt es erst für ausgestellte Belege");
  const [org, orig] = await Promise.all([
    db.organization.findFirst({ where: { id: ctx.organizationId }, select: { name: true } }),
    inv.creditsId ? db.customerInvoice.findFirst({ where: { id: inv.creditsId, organizationId: ctx.organizationId }, select: { number: true } }) : Promise.resolve(null),
  ]);
  const snap = (inv.issuerSnapshot ?? null) as IssuerDetails | null; // Stand zum Zeitpunkt des Ausstellens
  const rate = new Map(inv.taxCodes.map((t) => [t.id, t.rate.toString()]));
  const bytes = renderInvoicePdf({
    issuer: snap?.legalName ?? org?.name ?? "",
    issuerDetails: snap ?? null,
    customer: inv.customer,
    number: inv.number,
    kind: inv.kind === "CREDIT" ? "CREDIT" : "INVOICE",
    creditsNumber: orig?.number ?? null,
    invoiceDate: isoFromDate(inv.invoiceDate),
    dueDate: inv.dueDate ? isoFromDate(inv.dueDate) : null,
    currency: inv.currency,
    lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), netAmount: l.netAmount.toString(), taxRate: rate.get(l.taxCodeId) ?? "0" })),
    netTotal: inv.netTotal.toString(), taxTotal: inv.taxTotal.toString(), grossTotal: inv.grossTotal.toString(),
    note: inv.kind === "CREDIT" ? null : inv.note,
  });
  return { filename: `${inv.number}.pdf`, bytes };
}

/** Kennzahlen für die Übersichtsseite (nur Zähler, keine Beträge). */
export async function financeOverview(ctx: Ctx) {
  authorize(ctx, "finance.invoice.read");
  const org = ctx.organizationId;
  const [draftIn, approvedIn, draftOut, issuedOut, exports] = await Promise.all([
    db.supplierInvoice.count({ where: { organizationId: org, status: "DRAFT" } }),
    db.supplierInvoice.count({ where: { organizationId: org, status: "APPROVED", paidOn: null } }),
    db.customerInvoice.count({ where: { organizationId: org, status: "DRAFT" } }),
    db.customerInvoice.count({ where: { organizationId: org, status: "ISSUED", paidOn: null } }),
    db.accountingExport.count({ where: { organizationId: org } }),
  ]);
  return { draftIn, approvedIn, draftOut, issuedOut, exports };
}

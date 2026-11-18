import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { isoFromDate } from "@/modules/hr/queries";
import { allocateTax } from "./tax";
import { buildBmd } from "./formats/bmd";
import { buildDatev } from "./formats/datev";
import { encodeCp1252, sha256Hex } from "./formats/encoding";
import { buildPackage, packageFileName } from "./formats/package";
import type { ExportLine, ExportVoucher, FormatResult } from "./formats/types";
import { getAccountingProfile } from "./service";
import { exportInput } from "./schema";

type Tx = Prisma.TransactionClient;

export interface Check { severity: "ERROR" | "WARNING" | "INFO"; message: string }

export interface ExportCandidate {
  type: "SUPPLIER" | "CUSTOMER";
  id: string;
  voucher: ExportVoucher;
  fileId: string | null;
}

function fiscalYearStart(date: string, startMonth: number) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}-01`;
}

/** Sammelt alle freigegebenen/ausgestellten, noch nicht exportierten Belege und prüft sie gegen das Zielformat. */
async function collect(tx: Tx, organizationId: string, upTo: string | null) {
  const profile = await getAccountingProfile({ organizationId } as Ctx, tx);
  const [accounts, taxCodes, costCenters] = await Promise.all([
    tx.account.findMany({ where: { organizationId } }),
    tx.taxCode.findMany({ where: { organizationId } }),
    tx.costCenter.findMany({ where: { organizationId }, select: { id: true, code: true } }),
  ]);
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const tax = new Map(taxCodes.map((t) => [t.id, t]));
  const cc = new Map(costCenters.map((c) => [c.id, c.code]));
  const done = await tx.accountingExportItem.findMany({ where: { organizationId }, select: { voucherId: true } });
  const exported = new Set(done.map((x) => x.voucherId));
  const dateFilter = upTo ? { invoiceDate: { lte: new Date(`${upTo}T00:00:00Z`) } } : {};

  const [supplierInvoices, customerInvoices] = await Promise.all([
    tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", ...dateFilter }, include: { supplier: true, lines: true }, orderBy: [{ invoiceDate: "asc" }, { voucherNumber: "asc" }] }),
    tx.customerInvoice.findMany({ where: { organizationId, status: "ISSUED", ...dateFilter }, include: { customer: true, lines: true }, orderBy: [{ invoiceDate: "asc" }, { number: "asc" }] }),
  ]);
  const fileIds = supplierInvoices.map((i) => i.fileId).filter((x): x is string => !!x);
  const files = new Map((await tx.financeFile.findMany({ where: { organizationId, id: { in: fileIds } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));

  const checks: Check[] = [];
  const candidates: ExportCandidate[] = [];
  const err = (m: string) => checks.push({ severity: "ERROR", message: m });
  const warn = (m: string) => checks.push({ severity: "WARNING", message: m });
  const taxProblems = new Set<string>();

  const lineOf = (invoiceLines: { taxCodeId: string; netAmount: Decimal.Value; accountId: string; costCenterId: string | null }[], label: string): ExportLine[] | null => {
    const priced = allocateTax(invoiceLines.map((l) => ({ net: l.netAmount, rate: tax.get(l.taxCodeId)?.rate.toString() ?? "0", group: l.taxCodeId })));
    const merged = new Map<string, ExportLine>();
    let ok = true;
    invoiceLines.forEach((l, i) => {
      const a = acc.get(l.accountId), t = tax.get(l.taxCodeId);
      if (!a || !a.active) { err(`${label}: Sachkonto fehlt oder ist inaktiv`); ok = false; return; }
      if (!t) { err(`${label}: Steuerkennzeichen fehlt`); ok = false; return; }
      if (t.rate.greaterThan(0)) {
        if (profile.format === "BMD" && !t.bmdCode && !taxProblems.has(`b${t.id}`)) { taxProblems.add(`b${t.id}`); err(`Steuerkennzeichen ${t.key} hat keinen BMD-Steuercode`); }
        if (profile.format === "DATEV" && !t.datevKey && !taxProblems.has(`d${t.id}`)) { taxProblems.add(`d${t.id}`); err(`Steuerkennzeichen ${t.key} hat keinen DATEV-BU-Schlüssel`); }
      }
      const key = `${a.id}|${t.id}|${l.costCenterId ?? ""}`;
      const net = new Decimal(l.netAmount), tx_ = priced.tax[i]!;
      const prev = merged.get(key);
      if (prev) { prev.net = prev.net.plus(net); prev.tax = prev.tax.plus(tx_); prev.gross = prev.net.plus(prev.tax); }
      else merged.set(key, { account: a.number, rate: new Decimal(t.rate.toString()), bmdCode: t.bmdCode, datevKey: t.datevKey, net, tax: tx_, gross: net.plus(tx_), costCenter: l.costCenterId ? cc.get(l.costCenterId) ?? null : null });
    });
    return ok ? [...merged.values()] : null;
  };

  for (const i of supplierInvoices) {
    if (exported.has(i.id)) continue;
    const label = `Eingangsrechnung ${i.voucherNumber ?? i.invoiceNumber}`;
    const person = i.supplier.payableAccountId ? acc.get(i.supplier.payableAccountId) : undefined;
    if (!person || !person.active) { err(`${label}: Kreditorenkonto des Lieferanten fehlt oder ist inaktiv`); continue; }
    const lines = lineOf(i.lines.map((l) => ({ taxCodeId: l.taxCodeId, netAmount: l.netAmount.toString(), accountId: l.expenseAccountId, costCenterId: l.costCenterId })), label);
    if (!lines) continue;
    const fileName = profile.includeFiles && i.fileId && files.has(i.fileId) ? packageFileName(i.voucherNumber!, files.get(i.fileId)!) : null;
    if (profile.includeFiles && !i.fileId) warn(`${label}: keine Belegdatei hinterlegt`);
    candidates.push({
      type: "SUPPLIER", id: i.id, fileId: fileName ? i.fileId : null,
      voucher: { type: "SUPPLIER", kind: i.kind as "INVOICE" | "CREDIT", date: isoFromDate(i.invoiceDate), dueDate: i.dueDate ? isoFromDate(i.dueDate) : null, documentNumber: i.invoiceNumber, voucherNumber: i.voucherNumber!, personAccount: person.number, partnerName: i.supplier.name, uid: i.supplier.uid, paymentTermsDays: null, lines, fileName },
    });
  }
  for (const i of customerInvoices) {
    if (exported.has(i.id)) continue;
    const label = `Ausgangsrechnung ${i.number}`;
    const person = i.customer.receivableAccountId ? acc.get(i.customer.receivableAccountId) : undefined;
    if (!person || !person.active) { err(`${label}: Debitorenkonto des Kunden fehlt oder ist inaktiv`); continue; }
    const lines = lineOf(i.lines.map((l) => ({ taxCodeId: l.taxCodeId, netAmount: l.netAmount.toString(), accountId: l.revenueAccountId, costCenterId: l.costCenterId })), label);
    if (!lines) continue;
    candidates.push({
      type: "CUSTOMER", id: i.id, fileId: null,
      voucher: { type: "CUSTOMER", kind: i.kind as "INVOICE" | "CREDIT", date: isoFromDate(i.invoiceDate), dueDate: i.dueDate ? isoFromDate(i.dueDate) : null, documentNumber: i.number!, voucherNumber: i.number!, personAccount: person.number, partnerName: i.customer.name, uid: i.customer.uid, paymentTermsDays: i.customer.paymentTermsDays, lines, fileName: null },
    });
  }

  // Formatspezifische Prüfungen
  const all = candidates.flatMap((c) => c.voucher.lines.map((l) => ({ v: c.voucher, l })));
  if (profile.format === "DATEV") {
    if (!profile.advisorNumber || !profile.clientNumber) err("DATEV: Beraternummer und Mandantennummer fehlen im Profil");
    const len = profile.accountLength;
    const badGl = new Set(all.filter(({ l }) => l.account.length !== len).map(({ l }) => l.account));
    const badPerson = new Set(candidates.map((c) => c.voucher).filter((v) => v.personAccount.length !== len + 1).map((v) => v.personAccount));
    if (badGl.size > 0) err(`DATEV: Sachkonten müssen ${len} Stellen haben (abweichend: ${[...badGl].slice(0, 5).join(", ")})`);
    if (badPerson.size > 0) err(`DATEV: Personenkonten müssen ${len + 1} Stellen haben (abweichend: ${[...badPerson].slice(0, 5).join(", ")})`);
    const years = new Set(candidates.map((c) => fiscalYearStart(c.voucher.date, profile.fiscalYearStartMonth)));
    if (years.size > 1) err("DATEV: Die Belege liegen in mehreren Wirtschaftsjahren. Bitte getrennt exportieren (Feld Belege bis Datum).");
  } else {
    const bad = new Set(all.filter(({ l }) => !/^\d{1,9}$/.test(l.account)).map(({ l }) => l.account));
    if (bad.size > 0) err(`BMD: Kontonummern müssen aus 1–9 Ziffern bestehen (${[...bad].slice(0, 5).join(", ")})`);
    const nonNumeric = new Set(all.filter(({ l }) => l.costCenter && !/^\d+$/.test(l.costCenter)).map(({ l }) => l.costCenter));
    if (nonNumeric.size > 0) warn(`BMD erwartet numerische Kostenstellen; nicht übernommen: ${[...nonNumeric].slice(0, 5).join(", ")}`);
  }
  if (candidates.length === 0 && checks.every((c) => c.severity !== "ERROR")) checks.push({ severity: "INFO", message: "Keine freigegebenen Belege zum Export vorhanden." });
  return { profile, candidates, checks };
}

export async function previewAccountingExport(ctx: Ctx, raw: unknown = {}) {
  authorize(ctx, "finance.export.read");
  const input = exportInput.parse(raw);
  return db.$transaction(async (tx) => {
    const { profile, candidates, checks } = await collect(tx, ctx.organizationId, input.upTo ?? null);
    const last = await tx.accountingExport.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { version: "desc" }, select: { version: true } });
    return {
      profile, checks, nextVersion: (last?.version ?? 0) + 1,
      vouchers: candidates.map((c) => ({ type: c.type, id: c.id, number: c.voucher.voucherNumber, documentNumber: c.voucher.documentNumber, partner: c.voucher.partnerName, date: c.voucher.date, kind: c.voucher.kind, gross: c.voucher.lines.reduce((s, l) => s.plus(l.gross), new Decimal(0)), hasFile: !!c.voucher.fileName })),
    };
  });
}

export async function createAccountingExport(ctx: Ctx, raw: unknown, now = new Date()) {
  authorize(ctx, "finance.export.create");
  const input = exportInput.parse(raw);
  return db.$transaction(async (tx) => {
    // Läufe je Organisation serialisieren: keine doppelten Versionen, kein Beleg in zwei Läufen
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fin-export:${ctx.organizationId}`}))`;
    const { profile, candidates, checks } = await collect(tx, ctx.organizationId, input.upTo ?? null);
    const errors = checks.filter((c) => c.severity === "ERROR");
    if (errors.length > 0) throw new ConflictError(errors.map((e) => e.message).join("; "));
    const warnings = checks.filter((c) => c.severity === "WARNING");
    if (warnings.length > 0 && !input.acceptWarnings) throw new ConflictError(`${warnings.length} Hinweise müssen bestätigt werden: ${warnings.slice(0, 3).map((w) => w.message).join("; ")}`);
    if (candidates.length === 0) throw new ConflictError("Es gibt keine Belege, die exportiert werden müssten");

    const last = await tx.accountingExport.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;
    const vouchers = candidates.map((c) => c.voucher);
    const dates = vouchers.map((v) => v.date).sort();
    let result: FormatResult;
    if (profile.format === "DATEV") {
      result = buildDatev(vouchers, {
        advisorNumber: profile.advisorNumber!, clientNumber: profile.clientNumber!, accountLength: profile.accountLength, fiscalYearStart: fiscalYearStart(dates[0]!, profile.fiscalYearStartMonth),
        dictationCode: profile.dictationCode, currency: "EUR",
      }, { version, now, label: `Belege ${dates[0]!.slice(0, 7)}` });
    } else {
      result = buildBmd(vouchers, { symbolIn: profile.symbolIn, symbolOut: profile.symbolOut }, { version });
    }
    // Belegpaket
    let packageData: Buffer | null = null;
    const withFile = candidates.filter((c) => c.fileId);
    if (profile.includeFiles && withFile.length > 0) {
      const stored = await tx.financeFile.findMany({ where: { organizationId: ctx.organizationId, id: { in: withFile.map((c) => c.fileId!) } } });
      const byId = new Map(stored.map((f) => [f.id, f]));
      const entries = withFile.map((c) => {
        const f = byId.get(c.fileId!)!;
        if (sha256Hex(f.data) !== f.sha256) throw new Error(`Integritätsprüfung fehlgeschlagen für Beleg ${c.voucher.voucherNumber}`);
        return { name: c.voucher.fileName!, data: new Uint8Array(f.data) };
      });
      packageData = Buffer.from(buildPackage(entries));
    }
    const created = await tx.accountingExport.create({
      data: {
        organizationId: ctx.organizationId, version, format: profile.format, fileName: result.fileName, content: result.content, contentHash: sha256Hex(result.bytes),
        packageName: packageData ? `belege_${String(version).padStart(4, "0")}.zip` : null, packageData: packageData ? new Uint8Array(packageData) : null, packageHash: packageData ? sha256Hex(packageData) : null,
        profile: profile as unknown as Prisma.InputJsonValue, checks: checks as unknown as Prisma.InputJsonValue, voucherCount: candidates.length, lineCount: result.lineCount,
        fromDate: new Date(`${dates[0]}T00:00:00Z`), toDate: new Date(`${dates.at(-1)}T00:00:00Z`), createdById: ctx.userId,
        items: { create: candidates.map((c) => ({ organizationId: ctx.organizationId, voucherType: c.type, voucherId: c.id })) },
      },
    });
    await writeAudit(tx, ctx, { action: "accounting.export", entityType: "AccountingExport", entityId: created.id, after: { version, format: profile.format, vouchers: candidates.length, lines: result.lineCount, hash: created.contentHash } });
    return created;
  });
}

export async function listAccountingExports(ctx: Ctx) {
  authorize(ctx, "finance.export.read");
  return db.accountingExport.findMany({
    where: { organizationId: ctx.organizationId }, orderBy: { version: "desc" }, take: 100,
    select: { id: true, version: true, format: true, fileName: true, packageName: true, voucherCount: true, lineCount: true, contentHash: true, createdAt: true, fromDate: true, toDate: true },
  });
}

/** Liefert Buchungsdatei oder Belegpaket nach Integritätsprüfung (Hash) und protokolliert den Abruf. */
export async function getAccountingExportFile(ctx: Ctx, id: string, part: "data" | "package") {
  authorize(ctx, "finance.export.read");
  return db.$transaction(async (tx) => {
    const e = await tx.accountingExport.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!e) throw new NotFoundError("Exportlauf");
    let name: string, bytes: Buffer, mime: string;
    if (part === "package") {
      if (!e.packageData || !e.packageName) throw new NotFoundError("Belegpaket");
      bytes = Buffer.from(e.packageData);
      if (sha256Hex(bytes) !== e.packageHash) throw new Error("Integritätsprüfung fehlgeschlagen: Belegpaket weicht vom Export ab");
      name = e.packageName; mime = "application/zip";
    } else {
      bytes = encodeCp1252(e.content); // beide Formate werden in Windows-1252 („ANSI") ausgeliefert
      if (sha256Hex(bytes) !== e.contentHash) throw new Error("Integritätsprüfung fehlgeschlagen: Buchungsdatei weicht vom Export ab");
      name = e.fileName; mime = "text/csv";
    }
    await writeAudit(tx, ctx, { action: "accounting.download", entityType: "AccountingExport", entityId: e.id, after: { part, fileName: name } });
    return { name, bytes, mime };
  });
}

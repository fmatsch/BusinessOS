import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, isoFromDate } from "@/modules/hr/queries";
import { BankParseError, dedupeKeys, parseBankFile, suggestMatch, type Candidate, type MatchKind, type Suggestion } from "./bank";
import { payCustomerInvoiceTx, paySupplierInvoiceTx, unpayCustomerInvoiceTx, unpaySupplierInvoiceTx } from "./service";

type Tx = Prisma.TransactionClient;
const REQUIRED = { CUSTOMER_INVOICE: "finance.invoice.out.issue", SUPPLIER_INVOICE: "finance.invoice.in.approve" } as const;

/** Offene Belege, denen Zahlungen zugeordnet werden können: Betrag = offener Bruttobetrag nach Gutschriften. */
async function candidates(tx: Tx | typeof db, organizationId: string): Promise<Candidate[]> {
  const [cust, sup] = await Promise.all([
    tx.customerInvoice.findMany({ where: { organizationId, status: "ISSUED", kind: "INVOICE", paidOn: null }, include: { customer: { select: { name: true } } }, take: 2000 }),
    tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", kind: "INVOICE", paidOn: null }, include: { supplier: { select: { name: true } } }, take: 2000 }),
  ]);
  const [custCredits, supCredits] = await Promise.all([
    tx.customerInvoice.findMany({ where: { organizationId, status: "ISSUED", kind: "CREDIT", creditsId: { in: cust.map((c) => c.id) } }, select: { creditsId: true, grossTotal: true } }),
    tx.supplierInvoice.findMany({ where: { organizationId, status: "APPROVED", kind: "CREDIT", creditsId: { in: sup.map((c) => c.id) } }, select: { creditsId: true, grossTotal: true } }),
  ]);
  const net = (gross: Prisma.Decimal, credits: { creditsId: string | null; grossTotal: Prisma.Decimal }[], id: string) =>
    credits.filter((c) => c.creditsId === id).reduce((a, c) => a.minus(c.grossTotal.toString()), new Decimal(gross.toString()));
  return [
    ...cust.map((i): Candidate => ({ kind: "CUSTOMER_INVOICE", id: i.id, numbers: i.number ? [i.number] : [], amount: net(i.grossTotal, custCredits, i.id).toFixed(2), party: i.customer.name })),
    ...sup.map((i): Candidate => ({ kind: "SUPPLIER_INVOICE", id: i.id, numbers: [i.invoiceNumber, ...(i.voucherNumber ? [i.voucherNumber] : [])], amount: net(i.grossTotal, supCredits, i.id).toFixed(2), party: i.supplier.name })),
  ].filter((c) => new Decimal(c.amount).gt(0));
}

/** Kontoauszug importieren (CAMT.053 oder CSV). Dieselbe Datei zweimal wird abgewiesen, überlappende Auszüge übernehmen nur neue Zahlungen. */
export async function importBankStatement(ctx: Ctx, input: { filename: string; content: string }) {
  authorize(ctx, "finance.bank.manage");
  let parsed;
  try { parsed = parseBankFile(input.filename, input.content); } catch (e) {
    if (e instanceof BankParseError) throw new ConflictError(e.message);
    throw e;
  }
  const sha = createHash("sha256").update(input.content).digest("hex");
  const keys = dedupeKeys(parsed.lines);
  return db.$transaction(async (tx) => {
    if (await tx.bankImport.findFirst({ where: { organizationId: ctx.organizationId, sha256: sha }, select: { id: true } })) throw new ConflictError("Diese Datei wurde bereits importiert");
    const imp = await tx.bankImport.create({ data: { organizationId: ctx.organizationId, filename: input.filename.replace(/[^\w.\- ]/g, "_").slice(0, 120), format: parsed.format, sha256: sha, lineCount: parsed.lines.length, newCount: 0, createdById: ctx.userId } });
    const created = await tx.bankLine.createMany({
      data: parsed.lines.map((l, i) => ({
        organizationId: ctx.organizationId, importId: imp.id, bookingDate: dateFromIso(l.bookingDate), amount: l.amount, currency: l.currency, counterpartyName: l.counterpartyName, counterpartyIban: l.counterpartyIban,
        reference: l.reference, endToEndId: l.endToEndId, dedupeKey: keys[i]!,
      })),
      skipDuplicates: true,
    });
    await tx.bankImport.update({ where: { id: imp.id }, data: { newCount: created.count } });
    await writeAudit(tx, ctx, { action: "bank.import", entityType: "BankImport", entityId: imp.id, after: { format: parsed.format, lines: parsed.lines.length, new: created.count } });
    return { importId: imp.id, format: parsed.format, lines: parsed.lines.length, created: created.count, skipped: parsed.lines.length - created.count };
  });
}

export type BankFilter = "OPEN" | "MATCHED" | "IGNORED";

/** Zahlungen mit Vorschlägen (nur für offene Zeilen). */
export async function listBankLines(ctx: Ctx, status: BankFilter = "OPEN") {
  authorize(ctx, "finance.bank.manage");
  const lines = await db.bankLine.findMany({ where: { organizationId: ctx.organizationId, status }, orderBy: [{ bookingDate: "desc" }, { createdAt: "desc" }], take: 500 });
  const cands = status === "OPEN" ? await candidates(db, ctx.organizationId) : [];
  return lines.map((l) => ({ ...l, suggestion: status === "OPEN" ? suggestMatch({ amount: l.amount.toString(), reference: l.reference, counterpartyName: l.counterpartyName }, cands) : (null as Suggestion | null) }));
}

/** Alle Belege, die zu einer offenen Zahlung passen könnten (gleiche Richtung, gleicher Betrag) – für die manuelle Zuordnung. */
export async function candidatesForLine(ctx: Ctx, lineId: string) {
  authorize(ctx, "finance.bank.manage");
  const line = await db.bankLine.findFirst({ where: { id: lineId, organizationId: ctx.organizationId } });
  if (!line) throw new NotFoundError("Zahlung");
  const amount = new Decimal(line.amount.toString());
  const kind: MatchKind = amount.gt(0) ? "CUSTOMER_INVOICE" : "SUPPLIER_INVOICE";
  return (await candidates(db, ctx.organizationId)).filter((c) => c.kind === kind && new Decimal(c.amount).eq(amount.abs()));
}

async function lockLine(tx: Tx, ctx: Ctx, id: string) {
  await tx.$queryRaw`SELECT id FROM "BankLine" WHERE id = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const line = await tx.bankLine.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!line) throw new NotFoundError("Zahlung");
  return line;
}

/** Zahlung einem Beleg zuordnen: der Betrag muss genau stimmen; der Beleg wird mit dem Buchungsdatum als bezahlt vermerkt (eine Transaktion). */
export async function matchBankLine(ctx: Ctx, lineId: string, documentId: string) {
  authorize(ctx, "finance.bank.manage");
  return db.$transaction(async (tx) => {
    const line = await lockLine(tx, ctx, lineId);
    if (line.status !== "OPEN") throw new ConflictError("Die Zahlung ist bereits zugeordnet oder ignoriert");
    const amount = new Decimal(line.amount.toString());
    const kind: MatchKind = amount.gt(0) ? "CUSTOMER_INVOICE" : "SUPPLIER_INVOICE";
    authorize(ctx, REQUIRED[kind]);
    const cand = (await candidates(tx, ctx.organizationId)).find((c) => c.kind === kind && c.id === documentId);
    if (!cand) throw new NotFoundError("Offener Beleg");
    if (!new Decimal(cand.amount).eq(amount.abs())) throw new ConflictError(`Der Betrag stimmt nicht: Zahlung ${amount.abs().toFixed(2)}, Beleg ${cand.amount}`);
    const paidOn = isoFromDate(line.bookingDate);
    const via = { bankLineId: line.id };
    if (kind === "CUSTOMER_INVOICE") await payCustomerInvoiceTx(tx, ctx, documentId, paidOn, via); else await paySupplierInvoiceTx(tx, ctx, documentId, paidOn, via);
    await tx.bankLine.update({ where: { id: line.id }, data: { status: "MATCHED", matchKind: kind, matchedId: documentId, decidedById: ctx.userId, decidedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "bank.match", entityType: "BankLine", entityId: line.id, after: { kind, documentId, amount: amount.toFixed(2) } });
  });
}

/** Zuordnung lösen: Zahlung wird wieder offen, der Beleg wieder unbezahlt. */
export async function unmatchBankLine(ctx: Ctx, lineId: string) {
  authorize(ctx, "finance.bank.manage");
  return db.$transaction(async (tx) => {
    const line = await lockLine(tx, ctx, lineId);
    if (line.status !== "MATCHED" || !line.matchKind || !line.matchedId) throw new ConflictError("Die Zahlung ist keinem Beleg zugeordnet");
    authorize(ctx, REQUIRED[line.matchKind as MatchKind]);
    const via = { bankLineId: line.id };
    if (line.matchKind === "CUSTOMER_INVOICE") await unpayCustomerInvoiceTx(tx, ctx, line.matchedId, via); else await unpaySupplierInvoiceTx(tx, ctx, line.matchedId, via);
    await tx.bankLine.update({ where: { id: line.id }, data: { status: "OPEN", matchKind: null, matchedId: null, decidedById: ctx.userId, decidedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "bank.unmatch", entityType: "BankLine", entityId: line.id, after: { kind: line.matchKind, documentId: line.matchedId } });
  });
}

export async function ignoreBankLine(ctx: Ctx, lineId: string, note: string) {
  authorize(ctx, "finance.bank.manage");
  const why = note.trim();
  if (why.length < 3) throw new ConflictError("Bitte einen Grund angeben");
  return db.$transaction(async (tx) => {
    const line = await lockLine(tx, ctx, lineId);
    if (line.status !== "OPEN") throw new ConflictError("Nur offene Zahlungen können ignoriert werden");
    await tx.bankLine.update({ where: { id: line.id }, data: { status: "IGNORED", note: why.slice(0, 200), decidedById: ctx.userId, decidedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "bank.ignore", entityType: "BankLine", entityId: line.id, after: { reason: why.slice(0, 200) } });
  });
}

export async function reopenBankLine(ctx: Ctx, lineId: string) {
  authorize(ctx, "finance.bank.manage");
  return db.$transaction(async (tx) => {
    const line = await lockLine(tx, ctx, lineId);
    if (line.status !== "IGNORED") throw new ConflictError("Nur ignorierte Zahlungen können wieder geöffnet werden");
    await tx.bankLine.update({ where: { id: line.id }, data: { status: "OPEN", note: null, decidedById: ctx.userId, decidedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "bank.reopen", entityType: "BankLine", entityId: line.id });
  });
}

/** Übernimmt alle sicheren Vorschläge (Belegnummer und Betrag stimmen). Unsichere bleiben offen; Fehler einzelner Zeilen stoppen den Rest nicht. */
export async function acceptExactSuggestions(ctx: Ctx) {
  authorize(ctx, "finance.bank.manage");
  const lines = (await listBankLines(ctx, "OPEN")).filter((l) => l.suggestion?.strength === "EXACT");
  let matched = 0;
  const failed: { lineId: string; error: string }[] = [];
  for (const l of lines) {
    try { await matchBankLine(ctx, l.id, l.suggestion!.candidate.id); matched++; } catch (e) { failed.push({ lineId: l.id, error: e instanceof Error ? e.message : "Fehler" }); }
  }
  return { matched, failed };
}

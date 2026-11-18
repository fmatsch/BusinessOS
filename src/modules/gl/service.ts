import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, isoFromDate } from "@/modules/hr/queries";
import { documentsSince, fiscalYearStartMonth, payableAmount, postingDoc, taxInfoMap, type PostingDoc } from "@/modules/finance/queries";
import { entryInput, periodInput, rangeInput, settingsInput } from "./schema";
import {
  balanceSheet, balanceOf, fiscalYearStart, incomeStatement, kindOf, paymentPosting, postingProblem, purchasePosting, reversalLines, salesPosting, validateEntry,
  type AccountSums, type PostingLine,
} from "./rules";

type Tx = Prisma.TransactionClient;
const todayIso = () => isoFromDate(new Date());
const d = (v: Decimal.Value) => new Decimal(v);

// ───────────────────────── Einstellungen und Perioden ─────────────────────────

export async function getGlSettings(ctx: Ctx, tx: Tx | typeof db = db) {
  if (tx === db) authorize(ctx, "gl.read");
  return tx.glSettings.findUnique({ where: { organizationId: ctx.organizationId } });
}

/** Hauptbuch einschalten: ab dem Startdatum werden Belege und Zahlungen automatisch gebucht. Das Startdatum lässt sich später nicht ändern. */
export async function activateGl(ctx: Ctx, raw: unknown) {
  authorize(ctx, "gl.settings");
  const input = settingsInput.parse(raw);
  return db.$transaction(async (tx) => {
    const existing = await tx.glSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    if (input.bankAccountId && !(await tx.account.findFirst({ where: { id: input.bankAccountId, organizationId: ctx.organizationId, type: "GL", active: true }, select: { id: true } }))) throw new NotFoundError("Bankkonto");
    if (existing) {
      if (isoFromDate(existing.startDate) !== input.startDate) throw new ConflictError("Das Startdatum des Hauptbuchs kann nicht mehr geändert werden");
      await tx.glSettings.update({ where: { organizationId: ctx.organizationId }, data: { bankAccountId: input.bankAccountId ?? null } });
      await writeAudit(tx, ctx, { action: "gl.settings", entityType: "GlSettings", entityId: ctx.organizationId, after: { bankAccountId: input.bankAccountId ?? null } });
      return;
    }
    await tx.glSettings.create({ data: { organizationId: ctx.organizationId, startDate: dateFromIso(input.startDate), bankAccountId: input.bankAccountId ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "gl.activate", entityType: "GlSettings", entityId: ctx.organizationId, after: { startDate: input.startDate } });
  });
}

async function openPeriod(tx: Tx, organizationId: string, date: string) {
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
  const p = await tx.accountingPeriod.upsert({ where: { organizationId_year_month: { organizationId, year, month } }, create: { organizationId, year, month }, update: {} });
  if (p.status === "CLOSED") throw new ConflictError(`Die Periode ${String(month).padStart(2, "0")}/${year} ist abgeschlossen – es kann nicht mehr gebucht werden`);
}

export async function listPeriods(ctx: Ctx, year: number) {
  authorize(ctx, "gl.read");
  const rows = await db.accountingPeriod.findMany({ where: { organizationId: ctx.organizationId, year } });
  return Array.from({ length: 12 }, (_, i) => rows.find((r) => r.month === i + 1) ?? { id: "", organizationId: ctx.organizationId, year, month: i + 1, status: "OPEN", closedAt: null, closedById: null, note: null });
}

export async function closePeriod(ctx: Ctx, raw: unknown) {
  authorize(ctx, "gl.close");
  const { year, month } = periodInput.parse(raw);
  return db.$transaction(async (tx) => {
    const p = await tx.accountingPeriod.upsert({ where: { organizationId_year_month: { organizationId: ctx.organizationId, year, month } }, create: { organizationId: ctx.organizationId, year, month }, update: {} });
    if (p.status === "CLOSED") throw new ConflictError("Die Periode ist bereits abgeschlossen");
    await tx.accountingPeriod.update({ where: { id: p.id }, data: { status: "CLOSED", closedAt: new Date(), closedById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "gl.period_close", entityType: "AccountingPeriod", entityId: p.id, after: { year, month } });
  });
}

export async function reopenPeriod(ctx: Ctx, raw: unknown, reason: string) {
  authorize(ctx, "gl.reopen");
  const { year, month } = periodInput.parse(raw);
  const why = reason.trim();
  if (why.length < 5) throw new ConflictError("Bitte eine Begründung (mind. 5 Zeichen) angeben");
  return db.$transaction(async (tx) => {
    const p = await tx.accountingPeriod.findUnique({ where: { organizationId_year_month: { organizationId: ctx.organizationId, year, month } } });
    if (!p || p.status !== "CLOSED") throw new ConflictError("Die Periode ist nicht abgeschlossen");
    await tx.accountingPeriod.update({ where: { id: p.id }, data: { status: "OPEN", closedAt: null, closedById: null, note: why } });
    await writeAudit(tx, ctx, { action: "gl.period_reopen", entityType: "AccountingPeriod", entityId: p.id, after: { year, month, reason: why } });
  });
}

// ───────────────────────── Buchen ─────────────────────────

async function nextEntryNumber(tx: Tx, organizationId: string, year: number) {
  const key = `BU-${year}`;
  const seq = await tx.sequence.upsert({ where: { organizationId_key: { organizationId, key } }, create: { organizationId, key, value: 1 }, update: { value: { increment: 1 } } });
  return `${key}-${String(seq.value).padStart(5, "0")}`;
}

interface NewEntry { date: string; text: string; source: string; sourceId?: string | null; lines: PostingLine[]; reversesId?: string | null }

/** Schreibt einen geprüften Buchungssatz: Konten der Organisation, offene Periode, lückenlose Nummer. Soll = Haben prüft zusätzlich die Datenbank. */
async function writeEntry(tx: Tx, ctx: Ctx, e: NewEntry) {
  const problem = validateEntry(e.lines);
  if (problem) throw new ConflictError(problem);
  const ids = [...new Set(e.lines.map((l) => l.accountId))];
  const accounts = await tx.account.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, active: true } });
  if (accounts.length !== ids.length) throw new NotFoundError("Konto");
  if (accounts.some((a) => !a.active)) throw new ConflictError("Auf inaktive Konten kann nicht gebucht werden");
  await openPeriod(tx, ctx.organizationId, e.date);
  const number = await nextEntryNumber(tx, ctx.organizationId, Number(e.date.slice(0, 4)));
  const entry = await tx.journalEntry.create({
    data: { organizationId: ctx.organizationId, number, entryDate: dateFromIso(e.date), text: e.text.slice(0, 200), source: e.source, sourceId: e.sourceId ?? null, reversesId: e.reversesId ?? null, createdById: ctx.userId },
  });
  await tx.journalLine.createMany({
    data: e.lines.map((l) => ({ entryId: entry.id, accountId: l.accountId, debit: l.debit.toString(), credit: l.credit.toString(), costCenterId: l.costCenterId ?? null, taxCodeId: l.taxCodeId ?? null, taxRole: l.taxRole ?? null, text: l.text ?? null })),
  });
  return entry;
}

/** Manuelle Buchung (oder Eröffnungsbuchung). */
export async function createManualEntry(ctx: Ctx, raw: unknown) {
  authorize(ctx, "gl.post");
  const input = entryInput.parse(raw);
  const lines: PostingLine[] = input.lines.map((l) => ({ accountId: l.accountId, debit: d(l.debit?.toString() ?? 0), credit: d(l.credit?.toString() ?? 0), costCenterId: l.costCenterId ?? null, text: l.text ?? null }));
  return db.$transaction(async (tx) => {
    if (!(await tx.glSettings.findUnique({ where: { organizationId: ctx.organizationId } }))) throw new ConflictError("Das Hauptbuch ist noch nicht eingeschaltet");
    const costCenterIds = [...new Set(lines.map((l) => l.costCenterId).filter((x): x is string => !!x))];
    if (costCenterIds.length && (await tx.costCenter.count({ where: { organizationId: ctx.organizationId, id: { in: costCenterIds } } })) !== costCenterIds.length) throw new NotFoundError("Kostenstelle");
    const e = await writeEntry(tx, ctx, { date: input.date, text: input.text, source: input.opening ? "OPENING" : "MANUAL", lines });
    await writeAudit(tx, ctx, { action: "gl.entry", entityType: "JournalEntry", entityId: e.id, after: { number: e.number, source: e.source, text: input.text } });
    return e;
  });
}

/** Storno: ein neuer Satz mit vertauschten Seiten; der ursprüngliche bleibt unverändert. Jeder Satz höchstens einmal. */
export async function reverseEntry(ctx: Ctx, entryId: string, reason: string, date = todayIso()) {
  authorize(ctx, "gl.post");
  const why = reason.trim();
  if (why.length < 3) throw new ConflictError("Bitte eine Begründung angeben");
  return db.$transaction(async (tx) => {
    const orig = await tx.journalEntry.findFirst({ where: { id: entryId, organizationId: ctx.organizationId }, include: { lines: true, reversedBy: true } });
    if (!orig) throw new NotFoundError("Buchungssatz");
    if (orig.source === "REVERSAL") throw new ConflictError("Stornobuchungen können nicht storniert werden");
    if (orig.reversedBy) throw new ConflictError("Der Buchungssatz wurde bereits storniert");
    const lines = reversalLines(orig.lines.map((l) => ({ accountId: l.accountId, debit: d(l.debit.toString()), credit: d(l.credit.toString()), costCenterId: l.costCenterId, taxCodeId: l.taxCodeId, taxRole: l.taxRole as "BASE" | "TAX" | null, text: l.text })));
    const e = await writeEntry(tx, ctx, { date, text: `Storno ${orig.number}: ${why}`, source: "REVERSAL", sourceId: orig.id, reversesId: orig.id, lines });
    await writeAudit(tx, ctx, { action: "gl.reverse", entityType: "JournalEntry", entityId: e.id, after: { reverses: orig.number, reason: why } });
    return e;
  });
}

// ───────────────────────── Automatische Buchungen aus Belegen ─────────────────────────

async function activeSettings(tx: Tx, ctx: Ctx) {
  return tx.glSettings.findUnique({ where: { organizationId: ctx.organizationId } });
}

async function alreadyPosted(tx: Tx, ctx: Ctx, source: string, sourceId: string) {
  return !!(await tx.journalEntry.findFirst({ where: { organizationId: ctx.organizationId, source, sourceId }, select: { id: true } }));
}

function docPosting(doc: PostingDoc, tax: Awaited<ReturnType<typeof taxInfoMap>>) {
  if (!doc.partyAccountId) throw new ConflictError(`Für ${doc.partyName} ist kein ${doc.type === "CUSTOMER" ? "Debitoren" : "Kreditoren"}konto hinterlegt – Buchung im Hauptbuch nicht möglich`);
  const problem = postingProblem(doc.lines, tax);
  if (problem) throw new ConflictError(`Hauptbuch: ${problem}`);
  const text = `${doc.type === "CUSTOMER" ? (doc.credit ? "Gutschrift" : "Rechnung") : (doc.credit ? "Eingangsgutschrift" : "Eingangsrechnung")} ${doc.number} ${doc.partyName}`;
  return doc.type === "CUSTOMER"
    ? salesPosting({ receivableAccountId: doc.partyAccountId, lines: doc.lines, tax, credit: doc.credit, text })
    : purchasePosting({ payableAccountId: doc.partyAccountId, lines: doc.lines, tax, credit: doc.credit, text });
}

/** Bucht einen ausgestellten bzw. freigegebenen Beleg, sofern das Hauptbuch eingeschaltet und das Belegdatum ab dem Startdatum liegt. Idempotent. */
export async function postDocument(tx: Tx, ctx: Ctx, type: "CUSTOMER" | "SUPPLIER", id: string) {
  const s = await activeSettings(tx, ctx);
  if (!s) return null;
  const doc = await postingDoc(tx, ctx.organizationId, type, id);
  if (!doc || doc.date < isoFromDate(s.startDate)) return null;
  const source = type === "CUSTOMER" ? "CUSTOMER_INVOICE" : "SUPPLIER_INVOICE";
  if (await alreadyPosted(tx, ctx, source, id)) return null;
  const lines = docPosting(doc, await taxInfoMap(tx, ctx.organizationId));
  return writeEntry(tx, ctx, { date: doc.date, text: lines[0]!.text ?? doc.number, source, sourceId: id, lines });
}

/** Zahlungsvermerk → Zahlungsbuchung (Bank an Debitor bzw. Kreditor an Bank). */
export async function postPayment(tx: Tx, ctx: Ctx, type: "CUSTOMER" | "SUPPLIER", id: string, paidOn: string) {
  const s = await activeSettings(tx, ctx);
  if (!s) return null;
  const doc = await postingDoc(tx, ctx.organizationId, type, id);
  if (!doc || doc.date < isoFromDate(s.startDate)) return null; // der Beleg selbst wurde nicht im Hauptbuch gebucht
  if (!s.bankAccountId) throw new ConflictError("Hauptbuch: Bitte zuerst ein Bankkonto festlegen (Finanzen → Hauptbuch)");
  if (!doc.partyAccountId) throw new ConflictError("Hauptbuch: Konto der Gegenseite fehlt");
  const source = type === "CUSTOMER" ? "CUSTOMER_PAYMENT" : "SUPPLIER_PAYMENT";
  // je Zahlungsvermerk ein Satz; nach Rücknahme und erneutem Vermerk entsteht ein neuer (Kennung mit Zähler)
  const previous = await tx.journalEntry.findMany({ where: { organizationId: ctx.organizationId, source, sourceId: { startsWith: id } }, include: { reversedBy: { select: { id: true } } }, orderBy: { createdAt: "asc" } });
  if (previous.some((e) => !e.reversedBy)) return null;
  const amount = (await payableAmount(tx, ctx.organizationId, type, id)) ?? doc.gross;
  if (amount.lte(0)) return null;
  const text = `Zahlung ${doc.number} ${doc.partyName}`;
  const lines = paymentPosting({ bankAccountId: s.bankAccountId, partyAccountId: doc.partyAccountId, amount, incoming: type === "CUSTOMER", text });
  return writeEntry(tx, ctx, { date: paidOn, text, source, sourceId: previous.length === 0 ? id : `${id}:${previous.length + 1}`, lines });
}

/** Zahlungsvermerk zurückgenommen → die Zahlungsbuchung wird storniert (die Buchung selbst bleibt erhalten). */
export async function reversePayment(tx: Tx, ctx: Ctx, type: "CUSTOMER" | "SUPPLIER", id: string, date = todayIso()) {
  const source = type === "CUSTOMER" ? "CUSTOMER_PAYMENT" : "SUPPLIER_PAYMENT";
  const entries = await tx.journalEntry.findMany({ where: { organizationId: ctx.organizationId, source, sourceId: { startsWith: id } }, include: { lines: true, reversedBy: true }, orderBy: { createdAt: "desc" } });
  const orig = entries.find((e) => !e.reversedBy);
  if (!orig) return null;
  const lines = reversalLines(orig.lines.map((l) => ({ accountId: l.accountId, debit: d(l.debit.toString()), credit: d(l.credit.toString()), text: l.text })));
  return writeEntry(tx, ctx, { date, text: `Storno ${orig.number}: Zahlungsvermerk zurückgenommen`, source: "REVERSAL", sourceId: orig.id, reversesId: orig.id, lines });
}

/** Bucht alle Belege und Zahlungen ab dem Startdatum nach, die noch nicht gebucht sind (z. B. vor dem Einschalten ausgestellt oder bei fehlendem Konto übersprungen). */
export async function postMissingDocuments(ctx: Ctx) {
  authorize(ctx, "gl.settings");
  const s = await db.glSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  if (!s) throw new ConflictError("Das Hauptbuch ist noch nicht eingeschaltet");
  const docs = await documentsSince(db, ctx.organizationId, isoFromDate(s.startDate));
  let posted = 0;
  const failed: { id: string; error: string }[] = [];
  for (const doc of docs) {
    try {
      await db.$transaction(async (tx) => {
        if (await postDocument(tx, ctx, doc.type, doc.id)) posted++;
        if (doc.paidOn && (await postPayment(tx, ctx, doc.type, doc.id, doc.paidOn))) posted++;
      });
    } catch (e) { failed.push({ id: doc.id, error: e instanceof Error ? e.message : "Fehler" }); }
  }
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "gl.backfill", entityType: "GlSettings", entityId: ctx.organizationId, after: { posted, failed: failed.length } }));
  return { posted, failed };
}

// ───────────────────────── Lesen und Auswertungen ─────────────────────────

export async function listEntries(ctx: Ctx, opts: { from?: string; to?: string; accountId?: string; take?: number } = {}) {
  authorize(ctx, "gl.read");
  const where: Prisma.JournalEntryWhereInput = {
    organizationId: ctx.organizationId,
    ...(opts.from || opts.to ? { entryDate: { ...(opts.from ? { gte: dateFromIso(opts.from) } : {}), ...(opts.to ? { lte: dateFromIso(opts.to) } : {}) } } : {}),
    ...(opts.accountId ? { lines: { some: { accountId: opts.accountId } } } : {}),
  };
  return db.journalEntry.findMany({ where, orderBy: [{ entryDate: "desc" }, { number: "desc" }], take: Math.min(opts.take ?? 100, 500), include: { lines: true, reversedBy: { select: { id: true, number: true } } } });
}

export async function getEntry(ctx: Ctx, id: string) {
  authorize(ctx, "gl.read");
  const e = await db.journalEntry.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true, reversedBy: { select: { id: true, number: true } }, reverses: { select: { id: true, number: true } } } });
  if (!e) throw new NotFoundError("Buchungssatz");
  return e;
}

async function sums(tx: Tx | typeof db, organizationId: string, from: string | null, to: string): Promise<AccountSums[]> {
  const rows = await tx.$queryRaw<{ accountId: string; number: string; name: string; type: string; kind: string | null; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
    SELECT a."id" AS "accountId", a."number", a."name", a."type", a."kind",
           COALESCE(SUM(l."debit"), 0) AS debit, COALESCE(SUM(l."credit"), 0) AS credit
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    JOIN "Account" a ON a."id" = l."accountId"
    WHERE e."organizationId" = ${organizationId} AND a."organizationId" = ${organizationId}
      AND (${from}::date IS NULL OR e."entryDate" >= ${from}::date) AND e."entryDate" <= ${to}::date
    GROUP BY a."id", a."number", a."name", a."type", a."kind"
    ORDER BY a."number"`;
  return rows.map((r) => ({ accountId: r.accountId, number: r.number, name: r.name, kind: kindOf({ type: r.type, kind: r.kind }), debit: d(r.debit.toString()), credit: d(r.credit.toString()) }));
}

/** Saldenliste: je Konto Eröffnungssaldo (vor dem Zeitraum), Bewegung im Zeitraum und Schlusssaldo (Soll minus Haben). */
export async function trialBalance(ctx: Ctx, raw: unknown) {
  authorize(ctx, "gl.read");
  const r = rangeInput.parse(raw);
  const [opening, period] = await Promise.all([
    r.from ? sums(db, ctx.organizationId, null, new Date(Date.parse(`${r.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)) : Promise.resolve([] as AccountSums[]),
    sums(db, ctx.organizationId, r.from ?? null, r.to),
  ]);
  const byId = new Map<string, { number: string; name: string; kind: AccountSums["kind"]; open: Decimal; debit: Decimal; credit: Decimal }>();
  for (const o of opening) byId.set(o.accountId, { number: o.number, name: o.name, kind: o.kind, open: o.debit.minus(o.credit), debit: d(0), credit: d(0) });
  for (const p of period) { const e = byId.get(p.accountId) ?? { number: p.number, name: p.name, kind: p.kind, open: d(0), debit: d(0), credit: d(0) }; e.debit = p.debit; e.credit = p.credit; byId.set(p.accountId, e); }
  const rows = [...byId.entries()].map(([accountId, e]) => ({ accountId, ...e, closing: e.open.plus(e.debit).minus(e.credit) })).sort((a, b) => a.number.localeCompare(b.number, "de", { numeric: true }));
  const totals = rows.reduce((t, x) => ({ debit: t.debit.plus(x.debit), credit: t.credit.plus(x.credit), closing: t.closing.plus(x.closing) }), { debit: d(0), credit: d(0), closing: d(0) });
  return { rows, totals };
}

/** Kontoblatt: Buchungen eines Kontos im Zeitraum mit laufendem Saldo (Soll minus Haben), beginnend mit dem Saldo vor dem Zeitraum. */
export async function accountLedger(ctx: Ctx, accountId: string, raw: unknown) {
  authorize(ctx, "gl.read");
  const r = rangeInput.parse(raw);
  const account = await db.account.findFirst({ where: { id: accountId, organizationId: ctx.organizationId } });
  if (!account) throw new NotFoundError("Konto");
  const before = r.from ? (await sums(db, ctx.organizationId, null, new Date(Date.parse(`${r.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10))).find((s) => s.accountId === accountId) : undefined;
  let running = before ? before.debit.minus(before.credit) : d(0);
  const opening = running;
  const lines = await db.journalLine.findMany({
    where: { accountId, entry: { organizationId: ctx.organizationId, entryDate: { ...(r.from ? { gte: dateFromIso(r.from) } : {}), lte: dateFromIso(r.to) } } },
    include: { entry: { select: { id: true, number: true, entryDate: true, text: true } } }, orderBy: [{ entry: { entryDate: "asc" } }, { entry: { number: "asc" } }, { id: "asc" }],
  });
  const rows = lines.map((l) => { running = running.plus(l.debit.toString()).minus(l.credit.toString()); return { entry: l.entry, debit: d(l.debit.toString()), credit: d(l.credit.toString()), balance: running }; });
  return { account, opening, rows, closing: running };
}

/** Gewinn- und Verlustrechnung für einen Zeitraum. */
export async function incomeStatementReport(ctx: Ctx, raw: unknown) {
  authorize(ctx, "gl.read");
  const r = rangeInput.parse(raw);
  const rows = (await sums(db, ctx.organizationId, r.from ?? null, r.to)).filter((x) => x.kind === "INCOME" || x.kind === "EXPENSE");
  return incomeStatement(rows);
}

/** Bilanz zum Stichtag mit Ergebnisvortrag (frühere Geschäftsjahre) und laufendem Ergebnis; nicht eingeordnete Konten mit Buchungen werden gemeldet. */
export async function balanceSheetReport(ctx: Ctx, asOf: string) {
  authorize(ctx, "gl.read");
  rangeInput.parse({ to: asOf });
  const fyStart = fiscalYearStart(asOf, await fiscalYearStartMonth(db, ctx.organizationId));
  const dayBefore = new Date(Date.parse(`${fyStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [all, previous, current] = await Promise.all([sums(db, ctx.organizationId, null, asOf), sums(db, ctx.organizationId, null, dayBefore), sums(db, ctx.organizationId, fyStart, asOf)]);
  const pl = (rows: AccountSums[]) => incomeStatement(rows.filter((x) => x.kind === "INCOME" || x.kind === "EXPENSE")).result;
  const sheet = balanceSheet(all.filter((x) => x.kind === "ASSET" || x.kind === "LIABILITY" || x.kind === "EQUITY"), pl(previous), pl(current));
  const unclassified = all.filter((x) => x.kind === null && !balanceOf(x).isZero());
  return { asOf, fiscalYearStart: fyStart, ...sheet, unclassified };
}

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import type { Permission } from "@/platform/authz/permissions";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { stepsFor } from "@/platform/approvals/engine";
import { getActivePolicy, QUOTE } from "@/platform/approvals/policy";
import { dateFromIso, isoFromDate } from "@/modules/hr/queries";
import { createCustomerInvoiceDraftTx, getIssuerProfile, nextSequenceNumber, priceOutputLines, renderInvoicePdf, type IssuerDetails } from "@/modules/finance/service";
import { crmCustomer, crmCustomers, customerInvoiceSummary, taxRatesById } from "@/modules/finance/queries";
import { activityInput, contactInput, quoteDecisionInput, quoteInput } from "./schema";
import { canTransition, isExpired, type QuoteStatus } from "./quote-rules";

type Tx = Prisma.TransactionClient;
const todayIso = () => isoFromDate(new Date());
const lockQuote = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "Quote" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

// ───────────────────────── Kunden, Kontakte, Aktivitäten ─────────────────────────

/** Kundenliste mit Kontaktzahl, letzter Aktivität und offenen Angeboten. */
export async function listCrmCustomers(ctx: Ctx) {
  authorize(ctx, "crm.read");
  const customers = await crmCustomers(db, ctx.organizationId);
  const ids = customers.map((c) => c.id);
  const [contacts, acts, quotes] = await Promise.all([
    db.contact.groupBy({ by: ["customerId"], where: { organizationId: ctx.organizationId, customerId: { in: ids }, active: true }, _count: { _all: true } }),
    db.activity.groupBy({ by: ["customerId"], where: { organizationId: ctx.organizationId, customerId: { in: ids } }, _max: { occurredOn: true } }),
    db.quote.groupBy({ by: ["customerId"], where: { organizationId: ctx.organizationId, customerId: { in: ids }, status: { in: ["DRAFT", "PENDING", "APPROVED", "SENT"] } }, _count: { _all: true } }),
  ]);
  return customers.map((c) => ({
    ...c,
    contactCount: contacts.find((x) => x.customerId === c.id)?._count._all ?? 0,
    lastActivity: acts.find((x) => x.customerId === c.id)?._max.occurredOn ?? null,
    openQuotes: quotes.find((x) => x.customerId === c.id)?._count._all ?? 0,
  }));
}

/** Kundenakte: Stammdaten, Kontakte, letzte Aktivitäten, Angebote und letzte Rechnungen (Rechnungen nur mit Finanzberechtigung). */
export async function getCrmCustomer(ctx: Ctx, id: string) {
  authorize(ctx, "crm.read");
  const customer = await crmCustomer(db, ctx.organizationId, id);
  if (!customer) throw new NotFoundError("Kunde");
  const [contacts, activities, quotes, invoices] = await Promise.all([
    db.contact.findMany({ where: { organizationId: ctx.organizationId, customerId: id }, orderBy: [{ active: "desc" }, { name: "asc" }] }),
    db.activity.findMany({ where: { organizationId: ctx.organizationId, customerId: id }, orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }], take: 100, include: { contact: { select: { name: true } } } }),
    db.quote.findMany({ where: { organizationId: ctx.organizationId, customerId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ctx.permissions.has("finance.invoice.read") ? customerInvoiceSummary(db, ctx.organizationId, id) : Promise.resolve(null),
  ]);
  return { customer, contacts, activities, quotes, invoices };
}

export async function createContact(ctx: Ctx, raw: unknown) {
  authorize(ctx, "crm.write");
  const input = contactInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (!(await crmCustomer(tx, ctx.organizationId, input.customerId))) throw new NotFoundError("Kunde");
    const created = await tx.contact.create({ data: { organizationId: ctx.organizationId, customerId: input.customerId, name: input.name, position: input.position ?? null, email: input.email ?? null, phone: input.phone ?? null, note: input.note ?? null, createdById: ctx.userId } });
    // Personenbezogene Werte stehen nicht im Audit-Log, nur die Kennung
    await writeAudit(tx, ctx, { action: "contact.create", entityType: "Contact", entityId: created.id, after: { customerId: input.customerId } });
    return created;
  });
}

/**
 * Löschwunsch (DSGVO): Name, Funktion, E-Mail, Telefon und Notiz werden entfernt, der Kontakt wird deaktiviert.
 * Der Datensatz bleibt, damit Aktivitäten und Verweise nicht ins Leere zeigen. Freitext in Aktivitäten ist davon nicht erfasst.
 */
export async function anonymizeContact(ctx: Ctx, contactId: string) {
  authorize(ctx, "crm.contact.erase");
  return db.$transaction(async (tx) => {
    const r = await tx.contact.updateMany({
      where: { id: contactId, organizationId: ctx.organizationId, anonymizedAt: null },
      data: { name: "Gelöschter Kontakt", position: null, email: null, phone: null, note: null, active: false, anonymizedAt: new Date() },
    });
    if (r.count !== 1) throw new NotFoundError("Kontakt");
    await writeAudit(tx, ctx, { action: "contact.anonymize", entityType: "Contact", entityId: contactId });
  });
}

export async function addActivity(ctx: Ctx, raw: unknown) {
  authorize(ctx, "crm.write");
  const input = activityInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (!(await crmCustomer(tx, ctx.organizationId, input.customerId))) throw new NotFoundError("Kunde");
    if (input.contactId && !(await tx.contact.findFirst({ where: { id: input.contactId, organizationId: ctx.organizationId, customerId: input.customerId }, select: { id: true } }))) throw new NotFoundError("Kontakt");
    if (input.occurredOn > todayIso()) throw new ConflictError("Aktivitäten können nicht in der Zukunft liegen");
    const created = await tx.activity.create({ data: { organizationId: ctx.organizationId, customerId: input.customerId, contactId: input.contactId ?? null, type: input.type, occurredOn: dateFromIso(input.occurredOn), subject: input.subject, body: input.body ?? null, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "activity.create", entityType: "Activity", entityId: created.id, after: { customerId: input.customerId, type: input.type } });
    return created;
  });
}

// ───────────────────────── Angebote ─────────────────────────

export async function createQuote(ctx: Ctx, raw: unknown) {
  authorize(ctx, "crm.quote.create");
  const input = quoteInput.parse(raw);
  if (input.validUntil < todayIso()) throw new ConflictError("Das Ablaufdatum liegt in der Vergangenheit");
  return db.$transaction(async (tx) => {
    if (!(await crmCustomer(tx, ctx.organizationId, input.customerId))) throw new NotFoundError("Kunde");
    const lines = input.lines.map((l) => ({ ...l, net: l.quantity.times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) }));
    const tax = await priceOutputLines(tx, ctx.organizationId, lines);
    const created = await tx.quote.create({
      data: {
        organizationId: ctx.organizationId, customerId: input.customerId, title: input.title, validUntil: dateFromIso(input.validUntil), note: input.note ?? null,
        netTotal: tax.netTotal, taxTotal: tax.taxTotal, grossTotal: tax.grossTotal, createdById: ctx.userId,
        lines: { create: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, netAmount: l.net, taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "quote.create", entityType: "Quote", entityId: created.id, after: { customerId: input.customerId, gross: tax.grossTotal.toString() } });
    return created;
  });
}

/** Neuer Entwurf mit den Positionen eines vorhandenen Angebots (Angebote werden nicht bearbeitet, sondern neu angelegt). */
export async function duplicateQuote(ctx: Ctx, id: string, validUntil: string) {
  authorize(ctx, "crm.quote.create");
  const q = await db.quote.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!q) throw new NotFoundError("Angebot");
  return createQuote(ctx, {
    customerId: q.customerId, title: q.title, validUntil, note: q.note,
    lines: q.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId })),
  });
}

async function loadForUpdate(tx: Tx, ctx: Ctx, id: string) {
  await lockQuote(tx, ctx.organizationId, id);
  const q = await tx.quote.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true, approvals: { orderBy: { sequence: "asc" } } } });
  if (!q) throw new NotFoundError("Angebot");
  return q;
}

/** Zur Freigabe einreichen: die Schritte kommen aus der Freigaberegel (Objektart QUOTE), nie aus festen Schwellen im Code. */
export async function submitQuote(ctx: Ctx, id: string) {
  authorize(ctx, "crm.quote.create");
  return db.$transaction(async (tx) => {
    const q = await loadForUpdate(tx, ctx, id);
    if (!canTransition(q.status as QuoteStatus, "PENDING")) throw new ConflictError("Nur Entwürfe können zur Freigabe eingereicht werden");
    const policy = await getActivePolicy(tx, ctx.organizationId, QUOTE);
    const steps = stepsFor(policy.steps, q.netTotal.toString());
    await tx.quote.update({
      where: { id },
      data: { status: "PENDING", policyVersion: policy.version, approvals: { create: steps.map((s, i) => ({ organizationId: ctx.organizationId, stepKey: s.key, label: s.label, requiredPermission: s.permission, sequence: i + 1 })) } },
    });
    await writeAudit(tx, ctx, { action: "quote.submit", entityType: "Quote", entityId: id, after: { steps: steps.map((s) => s.key), policyVersion: policy.version } });
  });
}

/** Freigabeschritt entscheiden (Vier-Augen: nicht die erfassende Person; Reihenfolge der Schritte wird eingehalten). */
export async function decideQuote(ctx: Ctx, raw: unknown) {
  const input = quoteDecisionInput.parse(raw);
  return db.$transaction(async (tx) => {
    const q = await loadForUpdate(tx, ctx, input.quoteId);
    if (q.status !== "PENDING") throw new ConflictError("Das Angebot wartet nicht auf eine Freigabe");
    const step = q.approvals.find((a) => a.status === "PENDING");
    if (!step) throw new ConflictError("Kein offener Freigabeschritt");
    authorize(ctx, step.requiredPermission as Permission);
    if (q.createdById === ctx.userId) throw new ConflictError("Eigene Angebote dürfen nicht selbst freigegeben werden (Vier-Augen-Prinzip)");
    if (input.decision === "REJECT" && (input.comment ?? "").trim().length < 3) throw new ConflictError("Bitte eine Begründung für die Ablehnung angeben");
    const approve = input.decision === "APPROVE";
    await tx.approval.update({ where: { id: step.id }, data: { status: approve ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), comment: input.comment ?? null } });
    const remaining = q.approvals.filter((a) => a.id !== step.id && a.status === "PENDING").length;
    const next: QuoteStatus = !approve ? "REJECTED" : remaining === 0 ? "APPROVED" : "PENDING";
    if (next !== "PENDING") await tx.quote.update({ where: { id: q.id }, data: { status: next } });
    await writeAudit(tx, ctx, { action: approve ? "quote.approve_step" : "quote.reject", entityType: "Quote", entityId: q.id, after: { step: step.stepKey, status: next, comment: input.comment ?? null } });
    return { status: next };
  });
}

/** Versenden: vergibt die lückenlose Angebotsnummer und hält den Briefkopf fest. Danach ist das Angebot unveränderlich. */
export async function sendQuote(ctx: Ctx, id: string) {
  authorize(ctx, "crm.quote.create");
  return db.$transaction(async (tx) => {
    const q = await loadForUpdate(tx, ctx, id);
    if (!canTransition(q.status as QuoteStatus, "SENT")) throw new ConflictError("Nur freigegebene Angebote können versendet werden");
    const today = todayIso();
    if (isExpired(isoFromDate(q.validUntil), today)) throw new ConflictError("Das Angebot ist bereits abgelaufen – bitte als Kopie neu anlegen");
    const number = await nextSequenceNumber(tx, ctx.organizationId, "AN", Number(today.slice(0, 4)));
    const issuer = await getIssuerProfile(ctx, tx);
    await tx.quote.update({ where: { id }, data: { status: "SENT", number, sentAt: new Date(), issuerSnapshot: (issuer ?? undefined) as unknown as Prisma.InputJsonValue | undefined } });
    await writeAudit(tx, ctx, { action: "quote.send", entityType: "Quote", entityId: id, after: { number, gross: q.grossTotal.toString() } });
    await emitEvent(tx, ctx, "quote.sent", { quoteId: id, number, gross: q.grossTotal.toString(), href: `/crm/quotes/${id}` });
    return number;
  });
}

/** Kunde nimmt an: das Angebot wird angenommen und daraus ein Rechnungsentwurf erzeugt (ausgestellt wird er in den Finanzen). */
export async function acceptQuote(ctx: Ctx, id: string) {
  authorize(ctx, "crm.quote.create");
  authorize(ctx, "finance.invoice.out.create");
  return db.$transaction(async (tx) => {
    const q = await loadForUpdate(tx, ctx, id);
    if (!canTransition(q.status as QuoteStatus, "ACCEPTED")) throw new ConflictError("Nur versendete Angebote können angenommen werden");
    const today = todayIso();
    if (isExpired(isoFromDate(q.validUntil), today)) throw new ConflictError("Das Angebot ist abgelaufen");
    const inv = await createCustomerInvoiceDraftTx(tx, ctx, {
      customerId: q.customerId, invoiceDate: today, note: `Angebot ${q.number}: ${q.title}`,
      lines: q.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId })),
    });
    await tx.quote.update({ where: { id }, data: { status: "ACCEPTED", decidedAt: new Date(), decidedById: ctx.userId, invoiceId: inv.id } });
    await writeAudit(tx, ctx, { action: "quote.accept", entityType: "Quote", entityId: id, after: { number: q.number, invoiceId: inv.id } });
    await emitEvent(tx, ctx, "quote.accepted", { quoteId: id, number: q.number ?? "", gross: q.grossTotal.toString(), href: `/crm/quotes/${id}` });
    return { invoiceId: inv.id };
  });
}

export async function declineQuote(ctx: Ctx, id: string, reason?: string) {
  authorize(ctx, "crm.quote.create");
  return db.$transaction(async (tx) => {
    const q = await loadForUpdate(tx, ctx, id);
    if (!canTransition(q.status as QuoteStatus, "DECLINED")) throw new ConflictError("Nur versendete Angebote können abgelehnt werden");
    await tx.quote.update({ where: { id }, data: { status: "DECLINED", decidedAt: new Date(), decidedById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "quote.decline", entityType: "Quote", entityId: id, after: { number: q.number, reason: reason?.trim() || null } });
  });
}

export async function cancelQuote(ctx: Ctx, id: string) {
  authorize(ctx, "crm.quote.create");
  return db.$transaction(async (tx) => {
    const q = await loadForUpdate(tx, ctx, id);
    if (!canTransition(q.status as QuoteStatus, "CANCELLED")) throw new ConflictError("Dieses Angebot kann nicht mehr verworfen werden");
    await tx.quote.update({ where: { id }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "quote.cancel", entityType: "Quote", entityId: id });
  });
}

export async function listQuotes(ctx: Ctx) {
  authorize(ctx, "crm.read");
  return db.quote.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 200, include: { customer: { select: { number: true, name: true } } } });
}

export async function getQuote(ctx: Ctx, id: string) {
  authorize(ctx, "crm.read");
  const q = await db.quote.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { customer: { select: { id: true, number: true, name: true } }, lines: true, approvals: { orderBy: { sequence: "asc" } } } });
  if (!q) throw new NotFoundError("Angebot");
  return q;
}

/** Angebote, deren nächsten Freigabeschritt die Person jetzt entscheiden darf (Berechtigung, Reihenfolge, nicht eigene). */
export async function listPendingQuoteApprovals(ctx: Ctx) {
  authorize(ctx, "crm.read");
  const mine = [...ctx.permissions];
  const pending = await db.approval.findMany({
    where: { organizationId: ctx.organizationId, status: "PENDING", requiredPermission: { in: mine }, quote: { status: "PENDING", createdById: { not: ctx.userId } } },
    include: { quote: { include: { customer: { select: { name: true } } } } },
    orderBy: { sequence: "asc" },
  });
  const result = [];
  for (const a of pending) {
    if (!a.quoteId || !a.quote) continue;
    const earlier = await db.approval.count({ where: { quoteId: a.quoteId, sequence: { lt: a.sequence }, status: { not: "APPROVED" } } });
    if (earlier === 0) result.push({ ...a, quote: a.quote });
  }
  return result;
}

/** PDF eines versendeten Angebots (Briefkopf wie beim Versenden festgehalten). */
export async function getQuotePdf(ctx: Ctx, id: string) {
  authorize(ctx, "crm.read");
  const q = await db.quote.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!q) throw new NotFoundError("Angebot");
  if (!q.number) throw new ConflictError("Ein PDF gibt es erst für versendete Angebote");
  const [customer, org, rates] = await Promise.all([
    crmCustomer(db, ctx.organizationId, q.customerId),
    db.organization.findFirst({ where: { id: ctx.organizationId }, select: { name: true } }),
    taxRatesById(db, ctx.organizationId, q.lines.map((l) => l.taxCodeId)),
  ]);
  if (!customer) throw new NotFoundError("Kunde");
  const snap = (q.issuerSnapshot ?? null) as IssuerDetails | null;
  const bytes = renderInvoicePdf({
    issuer: snap?.legalName ?? org?.name ?? "", issuerDetails: snap, customer, number: q.number, kind: "QUOTE", validUntil: isoFromDate(q.validUntil),
    invoiceDate: isoFromDate(q.sentAt ?? q.createdAt), dueDate: null, currency: q.currency,
    lines: q.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), netAmount: l.netAmount.toString(), taxRate: rates.get(l.taxCodeId) ?? "0" })),
    netTotal: q.netTotal.toString(), taxTotal: q.taxTotal.toString(), grossTotal: q.grossTotal.toString(), note: q.note,
  });
  return { filename: `${q.number}.pdf`, bytes };
}

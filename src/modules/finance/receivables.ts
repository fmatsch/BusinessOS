import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { isoFromDate } from "@/modules/hr/queries";
import { addDaysIso, bucketOf, daysBetween, nextDunning, PAYMENT_DAYS, type AgeBucket } from "./dunning";
import { renderDunningPdf } from "./dunning-pdf";
import type { IssuerDetails } from "./invoice-pdf";
import { dunningInput } from "./schema";

const todayIso = () => isoFromDate(new Date());

/** Offene Posten der Debitoren: ausgestellte, unbezahlte Rechnungen abzüglich ausgestellter Gutschriften. */
export async function listOpenItems(ctx: Ctx, today = todayIso()) {
  authorize(ctx, "finance.invoice.read");
  const invoices = await db.customerInvoice.findMany({
    where: { organizationId: ctx.organizationId, status: "ISSUED", kind: "INVOICE", paidOn: null },
    include: { customer: { select: { number: true, name: true } } },
    orderBy: { dueDate: "asc" },
    take: 500,
  });
  const ids = invoices.map((i) => i.id);
  const [credits, notices] = await Promise.all([
    db.customerInvoice.findMany({ where: { organizationId: ctx.organizationId, status: "ISSUED", kind: "CREDIT", creditsId: { in: ids } }, select: { creditsId: true, grossTotal: true } }),
    db.dunningNotice.findMany({ where: { organizationId: ctx.organizationId, invoiceId: { in: ids } }, orderBy: { level: "asc" } }),
  ]);
  const rows = invoices.flatMap((inv) => {
    const credited = credits.filter((c) => c.creditsId === inv.id).reduce((a, c) => a.plus(c.grossTotal.toString()), new Decimal(0));
    const open = new Decimal(inv.grossTotal.toString()).minus(credited);
    if (open.lte(0)) return [];
    const due = isoFromDate(inv.dueDate ?? inv.invoiceDate);
    const mine = notices.filter((n) => n.invoiceId === inv.id);
    const last = mine[mine.length - 1];
    const daysOverdue = daysBetween(due, today);
    return [{
      id: inv.id, number: inv.number ?? "", customer: inv.customer, currency: inv.currency, dueDate: due, open, daysOverdue, bucket: bucketOf(daysOverdue),
      notices: mine.map((n) => ({ id: n.id, level: n.level, issuedOn: isoFromDate(n.issuedOn) })), lastLevel: last?.level ?? 0,
      next: nextDunning({ dueDate: due, today, lastLevel: last?.level ?? 0, lastNoticeOn: last ? isoFromDate(last.issuedOn) : null }),
    }];
  });
  const summary = {} as Record<AgeBucket, Decimal>;
  for (const b of ["NOT_DUE", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const) summary[b] = rows.filter((r) => r.bucket === b).reduce((a, r) => a.plus(r.open), new Decimal(0));
  return { rows, summary };
}

/** Legt die nächste Mahnstufe zu einer überfälligen Rechnung an. Jede Stufe gibt es höchstens einmal. */
export async function createDunningNotice(ctx: Ctx, raw: unknown, today = todayIso()) {
  authorize(ctx, "finance.dunning.create");
  const input = dunningInput.parse(raw);
  return db.$transaction(async (tx) => {
    // Zeilensperre: gleichzeitige Mahnläufe zur selben Rechnung laufen nacheinander
    await tx.$queryRaw`SELECT id FROM "CustomerInvoice" WHERE id = ${input.invoiceId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const inv = await tx.customerInvoice.findFirst({ where: { id: input.invoiceId, organizationId: ctx.organizationId } });
    if (!inv) throw new NotFoundError("Ausgangsrechnung");
    if (inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw new ConflictError("Gemahnt werden nur ausgestellte Rechnungen");
    if (inv.paidOn) throw new ConflictError("Die Rechnung ist bereits bezahlt");
    const credits = await tx.customerInvoice.findMany({ where: { organizationId: ctx.organizationId, status: "ISSUED", kind: "CREDIT", creditsId: inv.id }, select: { grossTotal: true } });
    const open = new Decimal(inv.grossTotal.toString()).minus(credits.reduce((a, c) => a.plus(c.grossTotal.toString()), new Decimal(0)));
    if (open.lte(0)) throw new ConflictError("Die Rechnung ist durch Gutschriften ausgeglichen");
    const last = await tx.dunningNotice.findFirst({ where: { organizationId: ctx.organizationId, invoiceId: inv.id }, orderBy: { level: "desc" } });
    const next = nextDunning({ dueDate: isoFromDate(inv.dueDate ?? inv.invoiceDate), today, lastLevel: last?.level ?? 0, lastNoticeOn: last ? isoFromDate(last.issuedOn) : null });
    if (!next.allowed) throw new ConflictError(next.reason);
    const payBy = addDaysIso(today, PAYMENT_DAYS);
    const created = await tx.dunningNotice.create({
      data: { organizationId: ctx.organizationId, invoiceId: inv.id, level: next.level, issuedOn: new Date(`${today}T00:00:00Z`), openAmount: open.toFixed(4), feeAmount: input.feeAmount.toString(), payByDate: new Date(`${payBy}T00:00:00Z`), note: input.note ?? null, createdById: ctx.userId },
    });
    await writeAudit(tx, ctx, { action: "dunning.create", entityType: "DunningNotice", entityId: created.id, after: { invoice: inv.number, level: next.level, open: open.toString(), fee: input.feeAmount.toString() } as unknown as Prisma.InputJsonValue });
    await emitEvent(tx, ctx, "dunning.created", { invoiceId: inv.id, invoiceNumber: inv.number ?? "", level: next.level, open: open.toFixed(2), href: `/finance/out/${inv.id}` });
    return created;
  });
}

export async function getDunningPdf(ctx: Ctx, noticeId: string) {
  authorize(ctx, "finance.invoice.read");
  const n = await db.dunningNotice.findFirst({ where: { id: noticeId, organizationId: ctx.organizationId } });
  if (!n) throw new NotFoundError("Mahnung");
  const inv = await db.customerInvoice.findFirst({ where: { id: n.invoiceId, organizationId: ctx.organizationId }, include: { customer: true } });
  if (!inv || !inv.number) throw new NotFoundError("Ausgangsrechnung");
  const org = await db.organization.findFirst({ where: { id: ctx.organizationId }, select: { name: true } });
  const snap = (inv.issuerSnapshot ?? null) as IssuerDetails | null; // Briefkopf wie auf der Rechnung
  const bytes = renderDunningPdf({
    issuer: snap?.legalName ?? org?.name ?? "", issuerDetails: snap, customer: inv.customer, level: n.level, issuedOn: isoFromDate(n.issuedOn),
    invoiceNumber: inv.number, invoiceDate: isoFromDate(inv.invoiceDate), dueDate: isoFromDate(inv.dueDate ?? inv.invoiceDate), currency: inv.currency,
    openAmount: n.openAmount.toString(), feeAmount: n.feeAmount.toString(), payByDate: isoFromDate(n.payByDate), note: n.note,
  });
  return { filename: `Mahnung-${n.level}-${inv.number}.pdf`, bytes };
}

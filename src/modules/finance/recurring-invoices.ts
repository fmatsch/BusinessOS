import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { NotFoundError } from "@/platform/errors";
import { dateFromIso, isoFromDate } from "@/modules/hr/queries";
import { dueRuns, nextRun, type Interval } from "./recurring";
import { customerInvoiceInput, recurringInput } from "./schema";
import { createCustomerInvoiceTx } from "./service";

const todayIso = () => isoFromDate(new Date());

export async function createRecurring(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.recurring.manage");
  const input = recurringInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (!(await tx.customer.findFirst({ where: { id: input.customerId, organizationId: ctx.organizationId, active: true }, select: { id: true } }))) throw new NotFoundError("Kunde");
    const taxIds = [...new Set(input.lines.map((l) => l.taxCodeId))];
    if ((await tx.taxCode.count({ where: { organizationId: ctx.organizationId, id: { in: taxIds }, direction: "OUTPUT", active: true } })) !== taxIds.length) throw new NotFoundError("Steuerkennzeichen");
    for (const l of input.lines) {
      if (l.revenueAccountId && !(await tx.account.findFirst({ where: { id: l.revenueAccountId, organizationId: ctx.organizationId, type: "GL", active: true }, select: { id: true } }))) throw new NotFoundError("Erlöskonto");
      if (l.costCenterId && !(await tx.costCenter.findFirst({ where: { id: l.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    }
    const created = await tx.recurringInvoice.create({
      data: {
        organizationId: ctx.organizationId, customerId: input.customerId, title: input.title, interval: input.interval, anchorDay: Number(input.firstRunOn.slice(8, 10)),
        nextRunOn: dateFromIso(input.firstRunOn), endsOn: input.endsOn ? dateFromIso(input.endsOn) : null, note: input.note ?? null, createdById: ctx.userId,
        lines: { create: input.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId ?? null, costCenterId: l.costCenterId ?? null })) },
      },
    });
    await writeAudit(tx, ctx, { action: "recurring_invoice.create", entityType: "RecurringInvoice", entityId: created.id, after: { title: input.title, interval: input.interval, firstRunOn: input.firstRunOn } });
    return created;
  });
}

export async function listRecurring(ctx: Ctx) {
  authorize(ctx, "finance.invoice.read");
  return db.recurringInvoice.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ active: "desc" }, { nextRunOn: "asc" }], include: { customer: { select: { number: true, name: true } }, lines: true }, take: 200 });
}

export async function setRecurringActive(ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "finance.recurring.manage");
  return db.$transaction(async (tx) => {
    const r = await tx.recurringInvoice.updateMany({ where: { id, organizationId: ctx.organizationId }, data: { active } });
    if (r.count !== 1) throw new NotFoundError("Vorlage");
    await writeAudit(tx, ctx, { action: active ? "recurring_invoice.resume" : "recurring_invoice.pause", entityType: "RecurringInvoice", entityId: id });
  });
}

export type RecurringRunResult = { created: { invoiceId: string; templateId: string; date: string }[]; failed: { templateId: string; title: string; error: string }[] };

/**
 * Erzeugt für alle fälligen Vorlagen Rechnungsentwürfe (nachgeholt höchstens je Vorlage 12). Ausgestellt wird nichts.
 * Idempotent: jede Vorlage und jedes Datum ergeben höchstens einen Entwurf; paralleles Ausführen ist unschädlich.
 */
export async function runRecurringInvoices(ctx: Ctx, today = todayIso()): Promise<RecurringRunResult> {
  authorize(ctx, "finance.recurring.manage");
  authorize(ctx, "finance.invoice.out.create");
  const templates = await db.recurringInvoice.findMany({ where: { organizationId: ctx.organizationId, active: true, nextRunOn: { lte: dateFromIso(today) } }, select: { id: true, title: true } });
  const result: RecurringRunResult = { created: [], failed: [] };
  for (const t of templates) {
    try {
      // Läufe nacheinander, je Lauf eine eigene Transaktion: ein Fehler stoppt nur diese Vorlage, bereits erzeugte Entwürfe bleiben
      for (let i = 0; i < 12; i++) {
        const made = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "RecurringInvoice" WHERE id = ${t.id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
          const tpl = await tx.recurringInvoice.findFirst({ where: { id: t.id, organizationId: ctx.organizationId }, include: { lines: true } });
          if (!tpl || !tpl.active) return null;
          const [date] = dueRuns({ nextRunOn: isoFromDate(tpl.nextRunOn), interval: tpl.interval as Interval, anchorDay: tpl.anchorDay, endsOn: tpl.endsOn ? isoFromDate(tpl.endsOn) : null, today, max: 1 });
          if (!date) return null;
          const input = customerInvoiceInput.parse({
            customerId: tpl.customerId, invoiceDate: date, note: tpl.note,
            lines: tpl.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), taxCodeId: l.taxCodeId, revenueAccountId: l.revenueAccountId, costCenterId: l.costCenterId })),
          });
          const inv = await createCustomerInvoiceTx(tx, ctx, input, { recurringId: tpl.id, recurringDate: date });
          const upcoming = nextRun(date, tpl.interval as Interval, tpl.anchorDay);
          await tx.recurringInvoice.update({ where: { id: tpl.id }, data: { lastRunOn: dateFromIso(date), nextRunOn: dateFromIso(upcoming) } });
          await writeAudit(tx, ctx, { action: "recurring_invoice.run", entityType: "RecurringInvoice", entityId: tpl.id, after: { invoiceId: inv.id, date } as unknown as Prisma.InputJsonValue });
          return { invoiceId: inv.id, templateId: tpl.id, date };
        });
        if (!made) break;
        result.created.push(made);
      }
    } catch (e) {
      result.failed.push({ templateId: t.id, title: t.title, error: e instanceof Error ? e.message : "Unbekannter Fehler" });
    }
  }
  return result;
}

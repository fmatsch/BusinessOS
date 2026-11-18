import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { NotFoundError } from "@/platform/errors";
import { budgetInput } from "./schema";
import { invoicedNetByCostCenter } from "@/modules/finance/queries";
import { committedOf, fiscalYearRange } from "./queries";

export interface BudgetRow {
  costCenterId: string;
  code: string;
  name: string;
  budget: Decimal | null;
  committed: Decimal;
  /** Ist: Netto der freigegebenen Eingangsrechnungen im Jahr (Gutschriften abgezogen) */
  actual: Decimal;
  remaining: Decimal | null;
}

export async function budgetOverview(ctx: Ctx, year: number): Promise<BudgetRow[]> {
  authorize(ctx, "finance.budget.read");
  const range = fiscalYearRange(year);
  const centers = await db.costCenter.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    orderBy: { code: "asc" },
    include: { budgets: { where: { fiscalYear: year } } },
  });
  const invoiced = await invoicedNetByCostCenter(db, ctx.organizationId, range);
  return Promise.all(
    centers.map(async (c) => {
      const committed = await committedOf(db, ctx.organizationId, c.id, range);
      const budget = c.budgets[0] ? new Decimal(c.budgets[0].amount.toString()) : null;
      return {
        costCenterId: c.id, code: c.code, name: c.name, budget, committed, actual: invoiced.get(c.id) ?? new Decimal(0),
        remaining: budget ? budget.minus(committed) : null,
      };
    }),
  );
}

export async function setBudget(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.budget.write");
  const input = budgetInput.parse(raw);
  return db.$transaction(async (tx) => {
    const cc = await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId } });
    if (!cc) throw new NotFoundError("Kostenstelle");
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
    const before = await tx.budget.findUnique({ where: { costCenterId_fiscalYear: { costCenterId: cc.id, fiscalYear: input.fiscalYear } } });
    const saved = await tx.budget.upsert({
      where: { costCenterId_fiscalYear: { costCenterId: cc.id, fiscalYear: input.fiscalYear } },
      create: { organizationId: ctx.organizationId, costCenterId: cc.id, fiscalYear: input.fiscalYear, amount: input.amount, currency: org.currency },
      update: { amount: input.amount },
    });
    await writeAudit(tx, ctx, {
      action: "budget.set", entityType: "Budget", entityId: saved.id,
      before: before ? { amount: before.amount.toString() } : undefined,
      after: { costCenterId: cc.id, fiscalYear: input.fiscalYear, amount: saved.amount.toString() },
    });
    return saved;
  });
}

export interface DepartmentSpend {
  departmentId: string | null;
  department: string;
  committed: Decimal;
  orderCount: number;
}

/** Gebundene Beträge je Abteilung (über die Kostenstelle der Bestellung), absteigend sortiert. */
export async function committedByDepartment(ctx: Ctx, year: number): Promise<DepartmentSpend[]> {
  authorize(ctx, "finance.budget.read");
  const range = fiscalYearRange(year);
  const orders = await db.purchaseOrder.findMany({
    where: { organizationId: ctx.organizationId, status: { not: "CANCELLED" }, createdAt: { gte: range.from, lt: range.to } },
    select: { totalAmount: true, costCenter: { select: { department: { select: { id: true, name: true } } } } },
  });
  const map = new Map<string, DepartmentSpend>();
  for (const o of orders) {
    const d = o.costCenter.department;
    const key = d?.id ?? "none";
    const row = map.get(key) ?? { departmentId: d?.id ?? null, department: d?.name ?? "(ohne Abteilung)", committed: new Decimal(0), orderCount: 0 };
    row.committed = row.committed.plus(o.totalAmount.toString());
    row.orderCount += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.committed.comparedTo(a.committed));
}

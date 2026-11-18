import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

export function fiscalYearRange(year: number) {
  return { year, from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) };
}

export function budgetOf(tx: Prisma.TransactionClient, organizationId: string, costCenterId: string, year: number) {
  return tx.budget.findFirst({ where: { organizationId, costCenterId, fiscalYear: year } });
}

/** Gebundenes Budget = Summe aller nicht stornierten Bestellungen der Kostenstelle im Geschäftsjahr (abgeleitet, nie manuell gepflegt). */
export async function committedOf(
  tx: Prisma.TransactionClient,
  organizationId: string,
  costCenterId: string,
  range: { from: Date; to: Date },
): Promise<Decimal> {
  const agg = await tx.purchaseOrder.aggregate({
    where: { organizationId, costCenterId, status: { not: "CANCELLED" }, createdAt: { gte: range.from, lt: range.to } },
    _sum: { totalAmount: true },
  });
  return new Decimal(agg._sum.totalAmount?.toString() ?? "0");
}

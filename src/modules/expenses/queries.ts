import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

/** Freigegebene und ausbezahlte Spesen je Monat der Einreichung (Kalenderjahr). Monate 1–12. Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst. */
export async function approvedExpensesByMonth(tx: Prisma.TransactionClient, organizationId: string, year: number): Promise<{ total: Decimal; count: number }[]> {
  const rows = await tx.expenseReport.findMany({
    where: { organizationId, status: { in: ["APPROVED", "PAID"] }, submittedAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
    select: { submittedAt: true, totalAmount: true },
  });
  const out = Array.from({ length: 12 }, () => ({ total: new Decimal(0), count: 0 }));
  for (const r of rows) { const m = r.submittedAt!.getUTCMonth(); out[m]!.total = out[m]!.total.plus(r.totalAmount.toString()); out[m]!.count++; }
  return out;
}

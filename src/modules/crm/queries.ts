import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

/** Angebote des Kalenderjahres (Anlagedatum) je Status mit Anzahl und Bruttosumme. Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst. */
export async function quoteFunnel(tx: Prisma.TransactionClient, organizationId: string, year: number) {
  const rows = await tx.quote.groupBy({
    by: ["status"], where: { organizationId, createdAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
    _count: { _all: true }, _sum: { grossTotal: true },
  });
  return rows.map((r) => ({ status: r.status, count: r._count._all, gross: new Decimal((r._sum.grossTotal ?? 0).toString()) }));
}

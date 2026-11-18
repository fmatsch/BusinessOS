import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

/**
 * Für andere Module (Bedarfsplanung): noch nicht gelieferte Menge je Lagerartikel aus bestätigten Kundenaufträgen.
 * Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst.
 */
export async function openDemandByItem(tx: Prisma.TransactionClient, organizationId: string): Promise<Map<string, Decimal>> {
  const lines = await tx.salesOrderLine.findMany({
    where: { itemId: { not: null }, order: { organizationId, status: "CONFIRMED" } },
    select: { id: true, itemId: true, quantity: true },
  });
  const shipped = await tx.deliveryLine.groupBy({ by: ["orderLineId"], where: { orderLineId: { in: lines.map((l) => l.id) }, delivery: { status: "SHIPPED" } }, _sum: { quantity: true } });
  const shippedBy = new Map(shipped.map((s) => [s.orderLineId, new Decimal(s._sum.quantity?.toString() ?? 0)]));
  const out = new Map<string, Decimal>();
  for (const l of lines) {
    const open = Decimal.max(0, new Decimal(l.quantity.toString()).minus(shippedBy.get(l.id) ?? 0));
    if (open.gt(0)) out.set(l.itemId!, (out.get(l.itemId!) ?? new Decimal(0)).plus(open));
  }
  return out;
}

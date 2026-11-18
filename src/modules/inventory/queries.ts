import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/money";

/** Für andere Module (Vertrieb, Fertigung): Artikel-Grunddaten innerhalb der Organisation. Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst. */
export function itemsByIds(tx: Prisma.TransactionClient, organizationId: string, ids: string[]) {
  return tx.item.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, number: true, name: true, unit: true, tracking: true, active: true } });
}

/** Aktive Artikel mit Gesamtbestand (Summe des Journals) und Mindestbestand – für die Bedarfsplanung. Ohne Berechtigungsprüfung. */
export async function activeItemsWithStock(tx: Prisma.TransactionClient, organizationId: string) {
  const items = await tx.item.findMany({ where: { organizationId, active: true }, orderBy: { number: "asc" }, select: { id: true, number: true, name: true, unit: true, reorderLevel: true } });
  const sums = await tx.stockMovement.groupBy({ by: ["itemId"], where: { organizationId }, _sum: { quantity: true } });
  const by = new Map(sums.map((s) => [s.itemId, new Decimal(s._sum.quantity?.toString() ?? 0)]));
  return items.map((i) => ({ ...i, onHand: by.get(i.id) ?? new Decimal(0), reorderLevel: i.reorderLevel ? new Decimal(i.reorderLevel.toString()) : null }));
}

/** Gesamtbestand je Artikel. Ohne Berechtigungsprüfung. */
export async function stockOnHand(tx: Prisma.TransactionClient, organizationId: string, itemIds: string[]) {
  const sums = await tx.stockMovement.groupBy({ by: ["itemId"], where: { organizationId, itemId: { in: itemIds } }, _sum: { quantity: true } });
  return new Map(itemIds.map((id) => [id, new Decimal(sums.find((s) => s.itemId === id)?._sum.quantity?.toString() ?? 0)]));
}

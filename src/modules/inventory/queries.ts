import type { Prisma } from "@prisma/client";

/** Für andere Module (Vertrieb, Fertigung): Artikel-Grunddaten innerhalb der Organisation. Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst. */
export function itemsByIds(tx: Prisma.TransactionClient, organizationId: string, ids: string[]) {
  return tx.item.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, number: true, name: true, unit: true, tracking: true, active: true } });
}

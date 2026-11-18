import type { Prisma } from "@prisma/client";

/** Für andere Module (Instandhaltung): Anlagegüter der Organisation (Nummer, Name). Ohne Berechtigungsprüfung – Aufrufer autorisieren selbst. */
export function fixedAssetsByIds(tx: Prisma.TransactionClient, organizationId: string, ids: string[]) {
  return tx.fixedAsset.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, number: true, name: true } });
}

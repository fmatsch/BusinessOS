import type { Prisma } from "@prisma/client";
import type { Ctx } from "@/platform/authz/authorize";

/**
 * Schreibt ein Ereignis in die Outbox – in derselben Transaktion wie die Änderung. Die Nutzlast enthält nur Kennungen, Nummern und Beträge
 * (keine Personendaten); `actorUserId` ist die auslösende Person. Verarbeitung durch den Worker (Benachrichtigungen, Workflows).
 */
export async function emitEvent(tx: Prisma.TransactionClient, ctx: Pick<Ctx, "organizationId" | "userId">, type: string, payload: Record<string, string | number | boolean | null>) {
  await tx.outboxEvent.create({ data: { organizationId: ctx.organizationId, type, payload: { ...payload, actorUserId: ctx.userId } } });
}

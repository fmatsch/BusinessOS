import type { Prisma } from "@prisma/client";
import type { Ctx } from "../authz/authorize";

/** Schreibt einen Audit-Eintrag in derselben Transaktion wie die Änderung. */
export async function writeAudit(
  tx: Prisma.TransactionClient,
  ctx: Pick<Ctx, "userId" | "organizationId">,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    actorType?: "USER" | "AI" | "SYSTEM";
  },
) {
  await tx.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorType: entry.actorType ?? "USER",
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
    },
  });
}

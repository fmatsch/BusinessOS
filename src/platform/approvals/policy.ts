import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { DEFAULT_POLICIES, policyStepsSchema, type PolicyStep } from "./engine";

export const PURCHASE_REQUEST = "PURCHASE_REQUEST";
export const ABSENCE_REQUEST = "ABSENCE_REQUEST";

export interface ActivePolicy {
  version: number;
  steps: PolicyStep[];
}

/** Aktuelle Regel; die Standardregel wird beim ersten Zugriff als Version 1 angelegt. */
export async function getActivePolicy(tx: Prisma.TransactionClient, organizationId: string, subjectType: string): Promise<ActivePolicy> {
  const latest = await tx.approvalPolicy.findFirst({ where: { organizationId, subjectType }, orderBy: { version: "desc" } });
  if (latest) return { version: latest.version, steps: policyStepsSchema.parse(latest.steps) };
  // skipDuplicates statt Fangen von P2002: ein Fehler würde die Postgres-Transaktion abbrechen
  const defaults = DEFAULT_POLICIES[subjectType];
  if (!defaults) throw new Error(`Keine Standardregel für ${subjectType}`);
  await tx.approvalPolicy.createMany({
    data: [{ organizationId, subjectType, version: 1, steps: defaults as unknown as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  const first = await tx.approvalPolicy.findFirstOrThrow({ where: { organizationId, subjectType }, orderBy: { version: "desc" } });
  return { version: first.version, steps: policyStepsSchema.parse(first.steps) };
}

export async function readPolicy(ctx: Ctx, subjectType = PURCHASE_REQUEST) {
  authorize(ctx, "org.settings.manage");
  const policy = await db.$transaction((tx) => getActivePolicy(tx, ctx.organizationId, subjectType));
  const versions = await db.approvalPolicy.findMany({ where: { organizationId: ctx.organizationId, subjectType }, orderBy: { version: "desc" }, take: 10 });
  return { policy, versions };
}

/** Veröffentlicht eine neue Version. Laufende Vorgänge behalten ihre Schritte; nur neue Vorgänge nutzen die neue Regel. */
export async function publishPolicy(ctx: Ctx, rawSteps: unknown, subjectType = PURCHASE_REQUEST) {
  authorize(ctx, "org.settings.manage");
  const steps = policyStepsSchema.parse(rawSteps);
  return db.$transaction(async (tx) => {
    const current = await getActivePolicy(tx, ctx.organizationId, subjectType);
    const created = await tx.approvalPolicy.create({
      data: { organizationId: ctx.organizationId, subjectType, version: current.version + 1, steps: steps as unknown as Prisma.InputJsonValue, createdById: ctx.userId },
    });
    await writeAudit(tx, ctx, {
      action: "approval_policy.publish", entityType: "ApprovalPolicy", entityId: created.id,
      before: { version: current.version, steps: current.steps as unknown as Prisma.InputJsonValue },
      after: { version: created.version, steps: steps as unknown as Prisma.InputJsonValue },
    });
    return created;
  });
}

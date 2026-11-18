import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { definitionSchema, type Action, type Condition } from "./engine";

export const MAX_WORKFLOWS = 50;

export type WorkflowRow = { id: string; key: string; version: number; name: string; eventType: string; conditions: Condition[]; actions: Action[]; enabled: boolean; createdAt: Date };

const parse = (r: { id: string; key: string; version: number; name: string; eventType: string; conditions: unknown; actions: unknown; enabled: boolean; createdAt: Date }): WorkflowRow => ({ ...r, conditions: r.conditions as Condition[], actions: r.actions as Action[] });

/** Veröffentlicht eine neue Version einer Regel (oder die erste). Frühere Versionen bleiben unverändert erhalten. */
export async function publishWorkflow(ctx: Ctx, raw: unknown) {
  authorize(ctx, "workflow.manage");
  const input = definitionSchema.parse(raw);
  return db.$transaction(async (tx) => {
    // Sperre je Organisation: gleichzeitige Veröffentlichungen vergeben die Versionsnummern nacheinander
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${ctx.organizationId} FOR UPDATE`;
    const latest = await tx.workflowDefinition.findFirst({ where: { organizationId: ctx.organizationId, key: input.key }, orderBy: { version: "desc" } });
    if (!latest) {
      const keys = await tx.workflowDefinition.findMany({ where: { organizationId: ctx.organizationId }, distinct: ["key"], select: { key: true } });
      if (keys.length >= MAX_WORKFLOWS) throw new ConflictError(`Höchstens ${MAX_WORKFLOWS} Workflows je Organisation`);
    }
    const created = await tx.workflowDefinition.create({
      data: {
        organizationId: ctx.organizationId, key: input.key, version: (latest?.version ?? 0) + 1, name: input.name, eventType: input.eventType,
        conditions: input.conditions as unknown as Prisma.InputJsonValue, actions: input.actions as unknown as Prisma.InputJsonValue, enabled: input.enabled, createdById: ctx.userId,
      },
    });
    await writeAudit(tx, ctx, { action: "workflow.publish", entityType: "WorkflowDefinition", entityId: created.id, after: { key: input.key, version: created.version, event: input.eventType, enabled: input.enabled } });
    return parse(created);
  });
}

/** Ein-/Ausschalten als neue Version (der bisherige Stand bleibt nachvollziehbar). */
export async function setWorkflowEnabled(ctx: Ctx, key: string, enabled: boolean) {
  authorize(ctx, "workflow.manage");
  const latest = await db.workflowDefinition.findFirst({ where: { organizationId: ctx.organizationId, key }, orderBy: { version: "desc" } });
  if (!latest) throw new NotFoundError("Workflow");
  if (latest.enabled === enabled) throw new ConflictError(enabled ? "Der Workflow ist bereits aktiv" : "Der Workflow ist bereits ausgeschaltet");
  return publishWorkflow(ctx, { key, name: latest.name, eventType: latest.eventType, conditions: latest.conditions, actions: latest.actions, enabled });
}

/** Aktuelle Version je Schlüssel. */
export async function listWorkflows(ctx: Ctx): Promise<WorkflowRow[]> {
  authorize(ctx, "workflow.read");
  const rows = await db.workflowDefinition.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ key: "asc" }, { version: "desc" }] });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true))).map(parse);
}

export async function workflowHistory(ctx: Ctx, key: string): Promise<WorkflowRow[]> {
  authorize(ctx, "workflow.read");
  const rows = await db.workflowDefinition.findMany({ where: { organizationId: ctx.organizationId, key }, orderBy: { version: "desc" }, take: 50 });
  if (rows.length === 0) throw new NotFoundError("Workflow");
  return rows.map(parse);
}

export async function listWorkflowRuns(ctx: Ctx, take = 50) {
  authorize(ctx, "workflow.read");
  return db.workflowRun.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take, include: { definition: { select: { key: true, name: true, version: true } } } });
}

import { db } from "@/lib/db";
import { runAgent, type AgentResult } from "@/platform/ai/agent";
import type { AiProvider } from "@/platform/ai/provider";
import { AnthropicProvider } from "@/platform/ai/anthropic";
import { rateLimit } from "@/platform/auth/rate-limit";
import type { Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { can } from "@/platform/authz/authorize";
import { copilotTools } from "./tools";
import { copilotWriteTools } from "./write-tools";

export const MAX_QUESTION = 1000;

export class CopilotUnavailableError extends Error {
  constructor() {
    super("Der KI-Copilot ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt).");
    this.name = "CopilotUnavailableError";
  }
}
export class RateLimitedError extends Error {
  constructor() {
    super("Zu viele Anfragen. Bitte später erneut versuchen.");
    this.name = "RateLimitedError";
  }
}

export function getProvider(): AiProvider | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new AnthropicProvider({ apiKey, model: process.env.AI_MODEL || undefined });
}

/** Beantwortet eine Frage mit dem Kontext des Benutzers. Jede Frage und jeder Werkzeugaufruf wird als KI-Aktion protokolliert. */
export async function askCopilot(ctx: Ctx, rawQuestion: string, provider: AiProvider | null = getProvider()): Promise<AgentResult> {
  const question = rawQuestion.trim().slice(0, MAX_QUESTION);
  if (!question) throw new Error("Bitte eine Frage eingeben.");
  if (!provider) throw new CopilotUnavailableError();
  if (!rateLimit(`ai:${ctx.userId}`, 20, 60 * 60_000)) throw new RateLimitedError();

  const audit = (action: string, entityId: string, after: Record<string, unknown>) =>
    db.$transaction((tx) => writeAudit(tx, ctx, { action, entityType: "AiCopilot", entityId, after: after as never, actorType: "AI" }));

  const result = await runAgent({
    provider, ctx, question, tools: copilotTools, writeTools: copilotWriteTools,
    onProposal: async (p) => {
      const saved = await db.copilotProposal.create({ data: { organizationId: ctx.organizationId, userId: ctx.userId, tool: p.tool, input: p.input as never, summary: p.summary } });
      await audit("ai.proposal", saved.id, { tool: p.tool, summary: p.summary, onBehalfOf: ctx.userId });
      return { id: saved.id };
    },
    onEvent: async (e) => {
      if (e.kind === "question") await audit("ai.question", "question", { question: e.question, onBehalfOf: ctx.userId });
      else if (e.kind === "tool_call") await audit("ai.tool_call", e.tool ?? "unknown", { input: e.input as never, ok: e.ok, onBehalfOf: ctx.userId });
    },
  });
  await audit("ai.answer", "answer", { status: result.status, toolsUsed: result.toolsUsed, sources: result.sources.length, proposals: result.proposals.length, onBehalfOf: ctx.userId });
  return result;
}

/** Vorschläge verfallen, wenn sie nicht zeitnah bestätigt werden (die Daten könnten sich geändert haben). */
export const PROPOSAL_TTL_MS = 15 * 60_000;

/**
 * Führt einen Vorschlag aus – nur für die Person, für die er erstellt wurde, nur einmal und nur innerhalb der Frist.
 * Die Änderung läuft über denselben Service wie die Oberfläche mit den Berechtigungen der bestätigenden Person.
 */
export async function confirmProposal(ctx: Ctx, id: string, now = Date.now()) {
  const p = await db.copilotProposal.findFirst({ where: { id, organizationId: ctx.organizationId, userId: ctx.userId } });
  if (!p) throw new NotFoundError("Vorschlag");
  if (p.status !== "PENDING") throw new ConflictError("Der Vorschlag wurde bereits entschieden");
  if (now - p.createdAt.getTime() > PROPOSAL_TTL_MS) {
    await db.copilotProposal.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXPIRED", decidedAt: new Date() } });
    throw new ConflictError("Der Vorschlag ist abgelaufen – bitte den Copilot erneut fragen");
  }
  const tool = copilotWriteTools.find((t) => t.name === p.tool);
  if (!tool || !can(ctx, tool.permission)) throw new ConflictError("Der Vorschlag kann nicht ausgeführt werden (Werkzeug oder Berechtigung fehlt)");
  const input = tool.input.safeParse(p.input);
  if (!input.success) throw new ConflictError("Der Vorschlag ist ungültig");
  // Beanspruchen: genau eine Bestätigung führt aus, auch bei doppeltem Klick
  const claimed = await db.copilotProposal.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXECUTED", decidedAt: new Date() } });
  if (claimed.count !== 1) throw new ConflictError("Der Vorschlag wurde bereits entschieden");
  try {
    const r = await tool.execute(ctx, input.data);
    await db.copilotProposal.update({ where: { id }, data: { resultMessage: r.message.slice(0, 300) } });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "ai.proposal_confirmed", entityType: "CopilotProposal", entityId: id, after: { tool: p.tool, summary: p.summary, result: r.message } as never }));
    return r;
  } catch (e) {
    const message = e instanceof Error && ["ForbiddenError", "NotFoundError", "ConflictError", "ZodError"].includes(e.name) ? e.message : "Die Änderung konnte nicht ausgeführt werden.";
    await db.copilotProposal.update({ where: { id }, data: { status: "FAILED", resultMessage: message.slice(0, 300) } });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "ai.proposal_failed", entityType: "CopilotProposal", entityId: id, after: { tool: p.tool, error: message } as never }));
    if (!(e instanceof Error && ["ForbiddenError", "NotFoundError", "ConflictError", "ZodError"].includes(e.name))) console.error("Copilot proposal failed", p.tool, e);
    throw new ConflictError(message);
  }
}

export async function rejectProposal(ctx: Ctx, id: string) {
  const r = await db.copilotProposal.updateMany({ where: { id, organizationId: ctx.organizationId, userId: ctx.userId, status: "PENDING" }, data: { status: "REJECTED", decidedAt: new Date() } });
  if (r.count !== 1) throw new ConflictError("Der Vorschlag ist nicht mehr offen");
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "ai.proposal_rejected", entityType: "CopilotProposal", entityId: id }));
}

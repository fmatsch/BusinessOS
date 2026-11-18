import { db } from "@/lib/db";
import { runAgent, type AgentResult } from "@/platform/ai/agent";
import type { AiProvider } from "@/platform/ai/provider";
import { AnthropicProvider } from "@/platform/ai/anthropic";
import { rateLimit } from "@/platform/auth/rate-limit";
import type { Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { copilotTools } from "./tools";

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
    provider, ctx, question, tools: copilotTools,
    onEvent: async (e) => {
      if (e.kind === "question") await audit("ai.question", "question", { question: e.question, onBehalfOf: ctx.userId });
      else await audit("ai.tool_call", e.tool ?? "unknown", { input: e.input as never, ok: e.ok, onBehalfOf: ctx.userId });
    },
  });
  await audit("ai.answer", "answer", { status: result.status, toolsUsed: result.toolsUsed, sources: result.sources.length, onBehalfOf: ctx.userId });
  return result;
}

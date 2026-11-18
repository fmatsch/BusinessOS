"use server";

import { requireContext } from "@/platform/tenancy/context";
import { askCopilot, CopilotUnavailableError, RateLimitedError } from "@/modules/copilot/service";

export interface CopilotState {
  question?: string;
  answer?: string;
  status?: "ok" | "refused" | "truncated" | "limit";
  sources?: { type: string; id: string; label: string; href?: string }[];
  toolsUsed?: string[];
  error?: string;
}

export async function ask(_prev: CopilotState, formData: FormData): Promise<CopilotState> {
  const question = String(formData.get("question") ?? "");
  const ctx = await requireContext();
  try {
    const r = await askCopilot(ctx, question);
    return { question, answer: r.answer, status: r.status, sources: r.sources, toolsUsed: r.toolsUsed };
  } catch (e) {
    if (e instanceof CopilotUnavailableError || e instanceof RateLimitedError) return { question, error: e.message };
    if (e instanceof Error && e.message === "Bitte eine Frage eingeben.") return { question, error: e.message };
    console.error("Copilot failed", e);
    return { question, error: "Die Anfrage an die KI ist fehlgeschlagen. Bitte später erneut versuchen." };
  }
}

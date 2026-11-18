"use server";

import { requireContext } from "@/platform/tenancy/context";
import { askCopilot, confirmProposal, CopilotUnavailableError, RateLimitedError, rejectProposal } from "@/modules/copilot/service";

export interface CopilotState {
  question?: string;
  answer?: string;
  status?: "ok" | "refused" | "truncated" | "limit";
  sources?: { type: string; id: string; label: string; href?: string }[];
  toolsUsed?: string[];
  proposals?: { id: string; tool: string; summary: string }[];
  error?: string;
}

export interface ProposalState {
  done?: "executed" | "rejected";
  message?: string;
  href?: string;
  error?: string;
}

export async function ask(_prev: CopilotState, formData: FormData): Promise<CopilotState> {
  const question = String(formData.get("question") ?? "");
  const ctx = await requireContext();
  try {
    const r = await askCopilot(ctx, question);
    return { question, answer: r.answer, status: r.status, sources: r.sources, toolsUsed: r.toolsUsed, proposals: r.proposals };
  } catch (e) {
    if (e instanceof CopilotUnavailableError || e instanceof RateLimitedError) return { question, error: e.message };
    if (e instanceof Error && e.message === "Bitte eine Frage eingeben.") return { question, error: e.message };
    console.error("Copilot failed", e);
    return { question, error: "Die Anfrage an die KI ist fehlgeschlagen. Bitte später erneut versuchen." };
  }
}

/** Bestätigen oder Verwerfen eines Vorschlags (nur durch die Person, für die er erstellt wurde). */
export async function decideProposal(_prev: ProposalState, formData: FormData): Promise<ProposalState> {
  const id = String(formData.get("id") ?? "");
  const ctx = await requireContext();
  try {
    if (formData.get("decision") === "reject") { await rejectProposal(ctx, id); return { done: "rejected", message: "Der Vorschlag wurde verworfen. Es wurde nichts geändert." }; }
    const r = await confirmProposal(ctx, id);
    return { done: "executed", message: r.message, href: r.href };
  } catch (e) {
    if (e instanceof Error && ["ConflictError", "NotFoundError", "ForbiddenError"].includes(e.name)) return { error: e.message };
    console.error("Copilot proposal decision failed", e);
    return { error: "Die Änderung konnte nicht ausgeführt werden." };
  }
}

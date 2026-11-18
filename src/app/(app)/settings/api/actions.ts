"use server";

import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { createApiToken, revokeApiToken } from "@/platform/api/tokens";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { ZodError } from "zod";

export interface CreateState { token?: string; expiresAt?: string; error?: string }

/** Legt ein Token an. Der Klartext geht nur in diese Antwort (keine Adresse, kein Cookie) und wird danach nirgends mehr angezeigt. */
export async function createTokenAction(_prev: CreateState, fd: FormData): Promise<CreateState> {
  const ctx = await requireContext();
  try {
    const r = await createApiToken(ctx, { name: fd.get("name"), expiresInDays: fd.get("expiresInDays") || 90 });
    revalidatePath("/settings/api");
    return { token: r.token, expiresAt: r.expiresAt.toISOString().slice(0, 10) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Dafür fehlt Ihnen die Berechtigung." };
    if (e instanceof ZodError) return { error: e.issues.map((i) => i.message).join("; ") };
    throw e;
  }
}

export async function revokeTokenAction(fd: FormData): Promise<void> {
  const ctx = await requireContext();
  try { await revokeApiToken(ctx, String(fd.get("id"))); } catch (e) { if (!(e instanceof NotFoundError || e instanceof ConflictError || e instanceof ForbiddenError)) throw e; }
  revalidatePath("/settings/api");
}

"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { adminResetMfa, beginMfaSetup, confirmMfaSetup, disableMfa, regenerateRecoveryCodes } from "@/platform/auth/mfa";
import { adminCreateResetLink, changePassword } from "@/platform/auth/password-reset";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { runAction } from "../../action-helpers";

const BACK = "/settings/security";

export interface CodesState { recoveryCodes?: string[]; error?: string }
export interface LinkState { url?: string; expiresAt?: string; error?: string }

const message = (e: unknown) => (e instanceof ConflictError || e instanceof NotFoundError ? e.message : e instanceof ForbiddenError ? "Dafür fehlt Ihnen die Berechtigung." : null);

export async function beginSetupAction() {
  const ctx = await requireContext();
  await runAction(BACK, () => beginMfaSetup(ctx.userId));
  revalidatePath(BACK);
}

/** Bestätigt die Einrichtung; die Wiederherstellungscodes stehen nur in dieser Antwort. */
export async function confirmSetupAction(_prev: CodesState, fd: FormData): Promise<CodesState> {
  const ctx = await requireContext();
  try {
    const r = await confirmMfaSetup(ctx.userId, String(fd.get("code") ?? ""));
    // kein revalidatePath: die Seite würde neu gerendert und die einmalige Anzeige der Codes ginge verloren
    return { recoveryCodes: r.recoveryCodes };
  } catch (e) {
    const m = message(e);
    if (m) return { error: m };
    throw e;
  }
}

export async function regenerateCodesAction(_prev: CodesState, fd: FormData): Promise<CodesState> {
  const ctx = await requireContext();
  try {
    return { recoveryCodes: (await regenerateRecoveryCodes(ctx.userId, String(fd.get("code") ?? ""))).recoveryCodes };
  } catch (e) {
    const m = message(e);
    if (m) return { error: m };
    throw e;
  }
}

export async function disableAction(fd: FormData) {
  const ctx = await requireContext();
  await runAction(BACK, () => disableMfa(ctx.userId, String(fd.get("password") ?? ""), String(fd.get("code") ?? "")));
  revalidatePath(BACK);
}

export async function changePasswordAction(fd: FormData) {
  const ctx = await requireContext();
  if (String(fd.get("next")) !== String(fd.get("next2"))) return runAction(BACK, async () => { throw new ConflictError("Die beiden neuen Passwörter stimmen nicht überein"); });
  await runAction(BACK, () => changePassword(ctx.userId, String(fd.get("current") ?? ""), String(fd.get("next") ?? "")));
  // Alle Sitzungen sind entwertet – die nächste Seite führt zur Anmeldung
  revalidatePath(BACK);
}

export async function adminResetMfaAction(fd: FormData) {
  const ctx = await requireContext();
  await runAction(BACK, () => adminResetMfa(ctx, String(fd.get("userId"))));
  revalidatePath(BACK);
}

export async function adminLinkAction(_prev: LinkState, fd: FormData): Promise<LinkState> {
  const ctx = await requireContext();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  try {
    const r = await adminCreateResetLink(ctx, String(fd.get("userId")), process.env.APP_URL?.replace(/\/$/, "") ?? `${proto}://${host}`);
    return { url: r.url, expiresAt: r.expiresAt.toISOString().slice(11, 16) };
  } catch (e) {
    const m = message(e);
    if (m) return { error: m };
    throw e;
  }
}

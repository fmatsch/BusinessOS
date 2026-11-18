import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError } from "@/platform/errors";
import { isMailConfigured, sendMail } from "@/platform/mail";
import { exclusiveMember } from "./mfa";
import { hashPassword, passwordProblem, verifyPassword } from "./password";
import { clearKey, isLimited, recordHit } from "./rate-limit";
import { auditUser } from "./user-audit";

/**
 * Passwort zurücksetzen. Der Link enthält ein Einmal-Token (nur als Hash gespeichert, 60 Minuten gültig). Die Antwort auf eine Anfrage ist
 * immer gleich – so lässt sich nicht herausfinden, welche Adressen Konten haben. Nach dem Ändern enden alle bestehenden Sitzungen.
 * Der zweite Faktor bleibt bestehen: Ein Reset-Link umgeht ihn nicht.
 */

export const RESET_TTL_MS = 60 * 60_000;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

export { isMailConfigured };

/** Anfrage „Passwort vergessen“. Je Adresse höchstens 3 pro Stunde, insgesamt 200 pro Stunde. Gibt nie preis, ob ein Konto existiert. */
export async function requestPasswordReset(emailRaw: string, baseUrl: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return;
  if (isLimited(`reset:${email}`, 3, 60 * 60_000) || isLimited("reset:all", 200, 60 * 60_000)) return;
  recordHit(`reset:${email}`); recordHit("reset:all");
  if (!isMailConfigured()) return;
  const user = await db.user.findUnique({ where: { email } });
  if (!user?.active) return;
  const token = newToken();
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }); // ältere offene Links verfallen
    await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
  });
  // nicht abwarten: die Antwortzeit soll nicht verraten, ob ein Konto existiert
  void sendMail({ to: user.email, subject: "Passwort zurücksetzen", text: `Guten Tag ${user.name},\n\nüber diesen Link können Sie ein neues Passwort festlegen (60 Minuten gültig, nur einmal verwendbar):\n\n${baseUrl}/reset/${token}\n\nHaben Sie das nicht angefordert, ignorieren Sie diese Nachricht – Ihr Passwort bleibt unverändert.\n` });
  await auditUser(user.id, "auth.password_reset.request");
}

/** Link für ein Mitglied, wenn kein E-Mail-Versand eingerichtet ist (Inhaber gibt ihn weiter). Nur für Konten, die ausschließlich dieser Organisation angehören. */
export async function adminCreateResetLink(ctx: Ctx, userId: string, baseUrl: string) {
  authorize(ctx, "org.members.manage");
  await exclusiveMember(ctx, userId);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.active) throw new ConflictError("Das Konto ist nicht aktiv");
  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
    await tx.passwordResetToken.create({ data: { userId, tokenHash: hash(token), expiresAt } });
    await writeAudit(tx, ctx, { action: "auth.password_reset.admin_link", entityType: "User", entityId: userId });
  });
  return { url: `${baseUrl}/reset/${token}`, expiresAt };
}

/** Ist das Token gültig? Liefert die E-Mail-Adresse für die Anzeige. */
export async function peekResetToken(token: string): Promise<{ email: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const t = await db.passwordResetToken.findUnique({ where: { tokenHash: hash(token) }, include: { user: { select: { email: true, active: true } } } });
  if (!t || t.usedAt || t.expiresAt.getTime() <= Date.now() || !t.user.active) return null;
  return { email: t.user.email };
}

/** Setzt das Passwort mit einem Token. Das Token wird verbraucht, alle Sitzungen enden. */
export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ConflictError("Der Link ist ungültig oder abgelaufen");
  const userId = await db.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findFirst({ where: { tokenHash: hash(token), usedAt: null, expiresAt: { gt: new Date() } } });
    if (!row) throw new ConflictError("Der Link ist ungültig oder abgelaufen");
    const user = await tx.user.findUnique({ where: { id: row.userId } });
    if (!user?.active) throw new ConflictError("Der Link ist ungültig oder abgelaufen");
    const problem = passwordProblem(newPassword, { email: user.email, name: user.name });
    if (problem) throw new ConflictError(problem);
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 } } });
    const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new ConflictError("Der Link ist ungültig oder abgelaufen");
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
    clearKey(`login:${user.email.toLowerCase()}`);
    return user.id;
  });
  await auditUser(userId, "auth.password_reset.complete");
}

/** Passwort ändern (angemeldet): verlangt das aktuelle Passwort; danach enden alle Sitzungen, auch diese (erneut anmelden). */
export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw new ConflictError("Das aktuelle Passwort stimmt nicht");
  const problem = passwordProblem(next, { email: user.email, name: user.name });
  if (problem) throw new ConflictError(problem);
  if (await verifyPassword(next, user.passwordHash)) throw new ConflictError("Das neue Passwort muss sich vom bisherigen unterscheiden");
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next), sessionVersion: { increment: 1 } } });
  await auditUser(userId, "auth.password_change");
}

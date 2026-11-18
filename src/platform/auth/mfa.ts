import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { open, seal } from "./secret-box";
import { verifyPassword } from "./password";
import { auditUser } from "./user-audit";
import { generateRecoveryCodes, generateSecret, hashRecovery, looksLikeRecovery, otpauthUri, verifyTotp } from "./totp";

/**
 * Zwei-Faktor-Anmeldung (TOTP) je Benutzerkonto. Das Geheimnis liegt verschlüsselt in der Datenbank, Wiederherstellungscodes nur als Hash.
 * Jeder Code gilt höchstens einmal (Zeitschritt wird gemerkt). Die Konten gelten organisationsübergreifend; deshalb setzt der Inhaber einer
 * Organisation nur Konten zurück, die ausschließlich zu seiner Organisation gehören.
 */

const ISSUER = "BusinessOS";

export async function getMfaStatus(userId: string) {
  const m = await db.userMfa.findUnique({ where: { userId } });
  return { enabled: !!m?.enabledAt, pending: !!m && !m.enabledAt, recoveryLeft: m?.enabledAt ? m.recoveryHashes.length : 0 };
}

/** Beginnt die Einrichtung: erzeugt ein neues (noch nicht aktives) Geheimnis. Ein vorheriger, unbestätigter Versuch wird ersetzt. */
export async function beginMfaSetup(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new NotFoundError("Benutzer");
  const existing = await db.userMfa.findUnique({ where: { userId } });
  if (existing?.enabledAt) throw new ConflictError("Die Zwei-Faktor-Anmeldung ist bereits eingerichtet");
  const secret = generateSecret();
  await db.userMfa.upsert({ where: { userId }, create: { userId, secretEnc: seal(secret) }, update: { secretEnc: seal(secret), lastUsedStep: 0 } });
  return { secret, uri: otpauthUri(ISSUER, user.email, secret) };
}

/** Das noch unbestätigte Geheimnis (für die Anzeige während der Einrichtung). */
export async function pendingMfaSetup(userId: string) {
  const m = await db.userMfa.findUnique({ where: { userId }, include: { user: { select: { email: true } } } });
  if (!m || m.enabledAt) return null;
  const secret = open(m.secretEnc);
  return { secret, uri: otpauthUri(ISSUER, m.user.email, secret) };
}

/** Bestätigt die Einrichtung mit einem gültigen Code, schaltet die Anmeldung scharf und gibt die Wiederherstellungscodes EINMALIG zurück. */
export async function confirmMfaSetup(userId: string, code: string) {
  const m = await db.userMfa.findUnique({ where: { userId } });
  if (!m || m.enabledAt) throw new ConflictError("Es gibt keine offene Einrichtung");
  const step = verifyTotp(open(m.secretEnc), code);
  if (step === null) throw new ConflictError("Der Code stimmt nicht – bitte den aktuellen Code der App eingeben");
  const codes = generateRecoveryCodes();
  await db.userMfa.update({ where: { userId }, data: { enabledAt: new Date(), lastUsedStep: step, recoveryHashes: codes.map(hashRecovery) } });
  await auditUser(userId, "auth.mfa.enable");
  return { recoveryCodes: codes };
}

/**
 * Prüft den zweiten Faktor bei der Anmeldung (oder bei sensiblen Änderungen): TOTP-Code oder Wiederherstellungscode.
 * Ein Code gilt nur einmal. Gibt `true` zurück, wenn er stimmt.
 */
export async function verifySecondFactor(userId: string, input: string): Promise<boolean> {
  const code = input.trim();
  if (!code) return false;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "UserMfa" WHERE "userId" = ${userId} FOR UPDATE`;
    const m = await tx.userMfa.findUnique({ where: { userId } });
    if (!m?.enabledAt) return false;
    if (looksLikeRecovery(code)) {
      const h = hashRecovery(code);
      if (!m.recoveryHashes.includes(h)) return false;
      await tx.userMfa.update({ where: { userId }, data: { recoveryHashes: m.recoveryHashes.filter((x) => x !== h) } });
      return true;
    }
    const step = verifyTotp(open(m.secretEnc), code);
    if (step === null || step <= m.lastUsedStep) return false; // falsch oder bereits verwendet
    await tx.userMfa.update({ where: { userId }, data: { lastUsedStep: step } });
    return true;
  });
}

/** Neue Wiederherstellungscodes (die alten verfallen). Verlangt einen gültigen Code. */
export async function regenerateRecoveryCodes(userId: string, code: string) {
  if (!(await verifySecondFactor(userId, code))) throw new ConflictError("Der Code stimmt nicht");
  const codes = generateRecoveryCodes();
  await db.userMfa.update({ where: { userId }, data: { recoveryHashes: codes.map(hashRecovery) } });
  await auditUser(userId, "auth.mfa.recovery_codes");
  return { recoveryCodes: codes };
}

/** Deaktivieren verlangt Passwort und einen gültigen zweiten Faktor. */
export async function disableMfa(userId: string, password: string, code: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new ConflictError("Das Passwort stimmt nicht");
  if (!(await verifySecondFactor(userId, code))) throw new ConflictError("Der Code stimmt nicht");
  await db.userMfa.delete({ where: { userId } });
  await auditUser(userId, "auth.mfa.disable");
}

// ───────────────────────── Verwaltung durch den Inhaber ─────────────────────────

async function exclusiveMember(ctx: Ctx, userId: string) {
  const memberships = await db.organizationMembership.findMany({ where: { userId }, select: { organizationId: true } });
  if (!memberships.some((m) => m.organizationId === ctx.organizationId)) throw new NotFoundError("Mitglied");
  if (memberships.length > 1) throw new ConflictError("Das Konto gehört mehreren Organisationen an – bitte die Person selbst oder die Plattformbetreuung einbeziehen");
}

/** Mitglieder der Organisation mit Stand der Zwei-Faktor-Anmeldung. */
export async function listMfaStatus(ctx: Ctx) {
  authorize(ctx, "org.members.manage");
  const members = await db.organizationMembership.findMany({ where: { organizationId: ctx.organizationId }, include: { user: { select: { id: true, name: true, email: true, active: true, mfa: { select: { enabledAt: true } } } }, role: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  return members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, active: m.user.active, role: m.role.name, mfaEnabled: !!m.user.mfa?.enabledAt }));
}

/** Setzt die Zwei-Faktor-Anmeldung eines Mitglieds zurück (z. B. Gerät verloren). Bestehende Sitzungen enden; nur für Konten, die ausschließlich dieser Organisation angehören. */
export async function adminResetMfa(ctx: Ctx, userId: string) {
  authorize(ctx, "org.members.manage");
  if (userId === ctx.userId) throw new ConflictError("Die eigene Zwei-Faktor-Anmeldung bitte unter „Sicherheit“ ändern");
  await exclusiveMember(ctx, userId);
  await db.$transaction(async (tx) => {
    const r = await tx.userMfa.deleteMany({ where: { userId } });
    if (r.count !== 1) throw new ConflictError("Für dieses Konto ist keine Zwei-Faktor-Anmeldung eingerichtet");
    await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    await writeAudit(tx, ctx, { action: "auth.mfa.admin_reset", entityType: "User", entityId: userId });
  });
}

export { exclusiveMember };

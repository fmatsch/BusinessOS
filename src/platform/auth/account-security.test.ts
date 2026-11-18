import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { adminResetMfa, beginMfaSetup, confirmMfaSetup, disableMfa, getMfaStatus, listMfaStatus, regenerateRecoveryCodes, verifySecondFactor } from "./mfa";
import { adminCreateResetLink, changePassword, completePasswordReset, peekResetToken, requestPasswordReset } from "./password-reset";
import { resetRateLimit } from "./rate-limit";
import { base32Decode, hotp, stepOf } from "./totp";

const hasDb = !!process.env.DATABASE_URL;
type RoleKey = keyof typeof SYSTEM_ROLES;
const PW = "ein-sicheres-Passwort-42";
const codeAt = (secret: string, stepOffset = 0) => hotp(base32Decode(secret), stepOf(Date.now()) + stepOffset);
const tokenOf = (url: string) => url.split("/reset/")[1]!;

describe.skipIf(!hasDb)("Konto-Sicherheit: Zwei-Faktor und Passwort zurücksetzen", () => {
  let tenantId = "", orgA = "", orgB = "";
  const c: Record<string, Ctx> = {};
  const uid: Record<string, string> = {};
  const userIds: string[] = [];

  async function makeOrg(name: string) {
    const org = await db.organization.create({ data: { tenantId, name } });
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await db.role.create({ data: { organizationId: org.id, key, name: def.name, system: true } });
      const perms = await db.permission.findMany({ where: { key: { in: [...def.permissions] } } });
      await db.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
    return org.id;
  }
  async function makeUser(org: string, label: string, role: RoleKey) {
    const user = await db.user.create({ data: { email: `${label}-${org}@test.invalid`, name: label, passwordHash: await bcrypt.hash(PW, 4) } });
    userIds.push(user.id); uid[label] = user.id;
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org, key: role } } });
    await db.organizationMembership.create({ data: { userId: user.id, organizationId: org, roleId: r.id } });
    c[label] = { userId: user.id, organizationId: org, permissions: new Set(SYSTEM_ROLES[role]!.permissions as readonly Permission[]) as Ctx["permissions"] };
  }

  beforeAll(async () => {
    for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
    tenantId = (await db.tenant.create({ data: { name: "TEST-Security" } })).id;
    orgA = await makeOrg("TEST-SC-A");
    orgB = await makeOrg("TEST-SC-B");
    for (const [l, r] of [["owner", "owner"], ["anna", "employee"], ["ben", "employee"], ["fin", "finance"]] as const) await makeUser(orgA, l, r);
    await makeUser(orgB, "ownerB", "owner");
    // Eine Person in zwei Organisationen
    const r = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgB, key: "employee" } } });
    await db.organizationMembership.create({ data: { userId: uid.ben!, organizationId: orgB, roleId: r.id } });
    process.env.AUTH_SECRET ??= "test-auth-secret";
    process.env.SMTP_URL = "smtp://127.0.0.1:1"; // erreichbar nicht – der Versand scheitert still, das Token entsteht trotzdem
    process.env.MAIL_FROM = "noreply@test.invalid";
  });

  beforeEach(() => resetRateLimit());

  afterAll(async () => {
    delete process.env.SMTP_URL; delete process.env.MAIL_FROM;
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
      await tx.userMfa.deleteMany({ where: { userId: { in: userIds } } });
      await tx.auditLog.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Einrichtung: Geheimnis nur verschlüsselt gespeichert, Bestätigung nur mit gültigem Code, Wiederherstellungscodes einmalig", async () => {
    expect(await getMfaStatus(uid.anna!)).toEqual({ enabled: false, pending: false, recoveryLeft: 0 });
    const { secret, uri } = await beginMfaSetup(uid.anna!);
    expect(uri).toContain(`secret=${secret}`);
    const row = await db.userMfa.findUniqueOrThrow({ where: { userId: uid.anna! } });
    expect(row.secretEnc).not.toContain(secret);
    expect(row.enabledAt).toBeNull();
    expect((await verifySecondFactor(uid.anna!, codeAt(secret)))).toBe(false); // noch nicht aktiv
    await expect(confirmMfaSetup(uid.anna!, "000000")).rejects.toBeInstanceOf(ConflictError);
    const { recoveryCodes } = await confirmMfaSetup(uid.anna!, codeAt(secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(await getMfaStatus(uid.anna!)).toEqual({ enabled: true, pending: false, recoveryLeft: 10 });
    const stored = await db.userMfa.findUniqueOrThrow({ where: { userId: uid.anna! } });
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]!); // nur Hashes
    await expect(beginMfaSetup(uid.anna!)).rejects.toBeInstanceOf(ConflictError);
    await expect(confirmMfaSetup(uid.anna!, codeAt(secret))).rejects.toBeInstanceOf(ConflictError);
    (globalThis as Record<string, unknown>).__anna = { secret, recoveryCodes };
  });

  it("zweiter Faktor: jeder Code nur einmal (auch gegen Wiederholung), Wiederherstellungscodes einmalig", async () => {
    const { secret, recoveryCodes } = (globalThis as unknown as { __anna: { secret: string; recoveryCodes: string[] } }).__anna;
    expect(await verifySecondFactor(uid.anna!, "123456")).toBe(false);
    expect(await verifySecondFactor(uid.anna!, "")).toBe(false);
    expect(await verifySecondFactor(uid.anna!, "kein code")).toBe(false);
    const next = codeAt(secret, 1);
    expect(await verifySecondFactor(uid.anna!, next)).toBe(true);
    expect(await verifySecondFactor(uid.anna!, next)).toBe(false); // Wiederholung
    expect(await verifySecondFactor(uid.anna!, codeAt(secret, 0))).toBe(false); // älterer Schritt nach neuerem
    // gleichzeitige Versuche mit demselben Code: genau einer gelingt
    const fresh = codeAt(secret, 1);
    const same = await Promise.all([verifySecondFactor(uid.anna!, fresh), verifySecondFactor(uid.anna!, fresh)]);
    expect(same.filter(Boolean)).toHaveLength(0); // war schon verbraucht
    const rc = recoveryCodes[3]!;
    expect(await verifySecondFactor(uid.anna!, rc.toUpperCase())).toBe(true); // Schreibweise egal
    expect(await verifySecondFactor(uid.anna!, rc)).toBe(false);
    expect((await getMfaStatus(uid.anna!)).recoveryLeft).toBe(9);
    expect(await verifySecondFactor(uid.ben!, "123456")).toBe(false); // ohne Einrichtung
  });

  it("Wiederherstellungscodes erneuern und Deaktivieren verlangen die Faktoren; Mandanten und Rechte", async () => {
    const { recoveryCodes: old } = (globalThis as unknown as { __anna: { recoveryCodes: string[] } }).__anna;
    await expect(regenerateRecoveryCodes(uid.anna!, "000000")).rejects.toBeInstanceOf(ConflictError);
    const fresh = await regenerateRecoveryCodes(uid.anna!, old[0]!);
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect((await getMfaStatus(uid.anna!)).recoveryLeft).toBe(10);
    await expect(disableMfa(uid.anna!, "falsches-Passwort-123", fresh.recoveryCodes[0]!)).rejects.toThrow(/Passwort/);
    await expect(disableMfa(uid.anna!, PW, "000000")).rejects.toThrow(/Code/);
    // Verwaltung: nur Inhaber; eigene Einrichtung nicht; Konten mehrerer Organisationen nicht
    expect((await listMfaStatus(c.owner!)).find((m) => m.name === "anna")).toMatchObject({ mfaEnabled: true });
    await expect(listMfaStatus(c.fin!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adminResetMfa(c.fin!, uid.anna!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adminResetMfa(c.ownerB!, uid.anna!)).rejects.toBeInstanceOf(NotFoundError); // fremde Organisation
    await expect(adminResetMfa(c.owner!, uid.owner!)).rejects.toThrow(/Sicherheit/);
    await expect(adminResetMfa(c.owner!, uid.ben!)).rejects.toThrow(/mehreren Organisationen/);
    const before = (await db.user.findUniqueOrThrow({ where: { id: uid.anna! } })).sessionVersion;
    await adminResetMfa(c.owner!, uid.anna!);
    expect((await getMfaStatus(uid.anna!)).enabled).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: uid.anna! } })).sessionVersion).toBe(before + 1); // Sitzungen enden
    await expect(adminResetMfa(c.owner!, uid.anna!)).rejects.toThrow(/keine Zwei-Faktor/);
    // Deaktivieren durch die Person selbst
    const again = await beginMfaSetup(uid.anna!);
    await confirmMfaSetup(uid.anna!, codeAt(again.secret));
    await disableMfa(uid.anna!, PW, codeAt(again.secret, 1));
    expect((await getMfaStatus(uid.anna!)).enabled).toBe(false);
    expect(await db.auditLog.count({ where: { organizationId: orgA, action: { in: ["auth.mfa.enable", "auth.mfa.disable", "auth.mfa.admin_reset"] } } })).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(await db.auditLog.findMany({ where: { organizationId: orgA } }))).not.toContain(again.secret);
  });

  it("Passwort-Reset: Anfrage verrät nichts, Token nur als Hash, einmalig, 60 Minuten, danach enden Sitzungen", async () => {
    await requestPasswordReset("gibt-es-nicht@test.invalid", "http://localhost");
    await requestPasswordReset("kein-mail-format", "http://localhost");
    expect(await db.passwordResetToken.count({ where: { userId: { in: userIds } } })).toBe(0);
    await requestPasswordReset(`ben-${orgA}@test.invalid`, "http://localhost");
    const tokens = await db.passwordResetToken.findMany({ where: { userId: uid.ben! } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Begrenzung: je Adresse höchstens 3 pro Stunde
    for (let i = 0; i < 5; i++) await requestPasswordReset(`fin-${orgA}@test.invalid`, "http://localhost");
    expect(await db.passwordResetToken.count({ where: { userId: uid.fin! } })).toBe(1); // ältere offene Links werden ersetzt
    expect(await db.auditLog.count({ where: { organizationId: orgA, action: "auth.password_reset.request" } })).toBe(3 + 1); // ben 1, fin 3 (danach begrenzt)
  });

  it("Reset-Link des Inhabers: Rechte, Passwortregeln, Verbrauch, Verfall, ersetzte Links, inaktive Konten", async () => {
    await expect(adminCreateResetLink(c.fin!, uid.anna!, "http://x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adminCreateResetLink(c.ownerB!, uid.anna!, "http://x")).rejects.toBeInstanceOf(NotFoundError);
    await expect(adminCreateResetLink(c.owner!, uid.ben!, "http://x")).rejects.toThrow(/mehreren Organisationen/);
    const first = await adminCreateResetLink(c.owner!, uid.anna!, "http://localhost");
    const t1 = tokenOf(first.url);
    expect(await peekResetToken(t1)).toEqual({ email: `anna-${orgA}@test.invalid` });
    expect(await peekResetToken("kurz")).toBeNull();
    const second = await adminCreateResetLink(c.owner!, uid.anna!, "http://localhost");
    expect(await peekResetToken(t1)).toBeNull(); // älterer Link ersetzt
    const t2 = tokenOf(second.url);
    await expect(completePasswordReset(t2, "kurz")).rejects.toThrow(/mindestens 12/);
    await expect(completePasswordReset(t2, "Passwort1234")).rejects.toThrow(/verbreitet/);
    expect(await peekResetToken(t2)).not.toBeNull(); // Fehlversuche verbrauchen den Link nicht
    const before = (await db.user.findUniqueOrThrow({ where: { id: uid.anna! } })).sessionVersion;
    await completePasswordReset(t2, "ein-ganz-neues-Passwort-77");
    const after = await db.user.findUniqueOrThrow({ where: { id: uid.anna! } });
    expect(await bcrypt.compare("ein-ganz-neues-Passwort-77", after.passwordHash)).toBe(true);
    expect(after.sessionVersion).toBe(before + 1);
    expect(await peekResetToken(t2)).toBeNull();
    await expect(completePasswordReset(t2, "noch-ein-Passwort-88-x")).rejects.toThrow(/ungültig oder abgelaufen/); // nur einmal
    // abgelaufen
    const third = await adminCreateResetLink(c.owner!, uid.anna!, "http://localhost");
    await db.passwordResetToken.updateMany({ where: { userId: uid.anna! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(completePasswordReset(tokenOf(third.url), "zum-dritten-Mal-Passwort-9")).rejects.toThrow(/ungültig oder abgelaufen/);
    // inaktives Konto
    const fourth = await adminCreateResetLink(c.owner!, uid.anna!, "http://localhost");
    await db.user.update({ where: { id: uid.anna! }, data: { active: false } });
    expect(await peekResetToken(tokenOf(fourth.url))).toBeNull();
    await expect(adminCreateResetLink(c.owner!, uid.anna!, "http://localhost")).rejects.toThrow(/nicht aktiv/);
    await db.user.update({ where: { id: uid.anna! }, data: { active: true } });
    expect(JSON.stringify(await db.auditLog.findMany({ where: { organizationId: orgA } }))).not.toContain(t2); // kein Token im Protokoll
  });

  it("Passwort ändern: aktuelles Passwort nötig, Regeln, ungleich dem alten, beendet Sitzungen", async () => {
    await expect(changePassword(uid.fin!, "falsch", "ein-neues-Passwort-123")).rejects.toThrow(/aktuelle Passwort/);
    await expect(changePassword(uid.fin!, PW, "kurz")).rejects.toThrow(/mindestens 12/);
    await expect(changePassword(uid.fin!, PW, PW)).rejects.toThrow(/unterscheiden/);
    const before = (await db.user.findUniqueOrThrow({ where: { id: uid.fin! } })).sessionVersion;
    await changePassword(uid.fin!, PW, "ein-neues-Passwort-123");
    const u = await db.user.findUniqueOrThrow({ where: { id: uid.fin! } });
    expect(await bcrypt.compare("ein-neues-Passwort-123", u.passwordHash)).toBe(true);
    expect(u.sessionVersion).toBe(before + 1);
  });
});

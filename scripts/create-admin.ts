/*
 * Ersteinrichtung: legt Organisation, Systemrollen und den ersten Inhaber-Benutzer an (Installer, einmalig).
 * Eingabe nur über Umgebungsvariablen (kein Passwort auf der Kommandozeile): ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD, ORG_NAME.
 * Bricht ohne Änderung ab, wenn die Datenbank bereits Benutzer enthält (idempotent, überschreibt nie).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { syncSystemRoles } from "../src/platform/authz/sync-roles";

const db = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = (process.env.ADMIN_NAME ?? "").trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  const orgName = (process.env.ORG_NAME ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ADMIN_EMAIL fehlt oder ist ungültig");
  if (!name || name.length > 100) throw new Error("ADMIN_NAME fehlt oder ist zu lang");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD muss mindestens 12 Zeichen haben");
  if (!orgName || orgName.length > 120) throw new Error("ORG_NAME fehlt oder ist zu lang");

  if ((await db.user.count()) > 0) {
    console.log("Bereits eingerichtet: Es gibt schon Benutzer – nichts geändert.");
    return;
  }
  const tenant = await db.tenant.create({ data: { name: orgName } });
  const org = await db.organization.create({ data: { tenantId: tenant.id, name: orgName } });
  await syncSystemRoles(db, org.id);
  const owner = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org.id, key: "owner" } } });
  const user = await db.user.create({ data: { email, name, passwordHash: await bcrypt.hash(password, 12) } });
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: org.id, roleId: owner.id } });
  console.log(`Eingerichtet: Organisation „${orgName}“, Inhaber ${email}.`);
}

main()
  .catch((e) => { console.error("Einrichtung fehlgeschlagen:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

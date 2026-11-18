import { db } from "@/lib/db";
import { writeAudit } from "@/platform/audit/audit";

/**
 * Protokolliert ein Konto-Ereignis (Anmeldung, Zwei-Faktor, Passwort) in der Änderungshistorie jeder Organisation, in der die Person Mitglied ist.
 * Ohne Passwörter, Codes oder Geheimnisse – nur Art und Zeitpunkt.
 */
export async function auditUser(userId: string, action: string, after?: Record<string, string | number | boolean | null>) {
  const orgs = await db.organizationMembership.findMany({ where: { userId }, select: { organizationId: true } });
  for (const o of orgs) {
    await db.$transaction((tx) => writeAudit(tx, { userId, organizationId: o.organizationId }, { action, entityType: "User", entityId: userId, after }));
  }
}

import type { PrismaClient } from "@prisma/client";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions";

type Client = Pick<PrismaClient, "permission" | "role" | "rolePermission" | "organization">;

/**
 * Gleicht die Systemrollen aller Organisationen mit `SYSTEM_ROLES` ab.
 * Rein ergänzend: fehlende Berechtigungen werden hinzugefügt, nichts wird entfernt
 * (ein Entzug ist eine bewusste Entscheidung und läuft nicht automatisch).
 * Fehlende Systemrollen werden angelegt. Mehrfaches Ausführen ändert nichts.
 */
export async function syncSystemRoles(db: Client, organizationId?: string) {
  for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
  const perms = new Map((await db.permission.findMany()).map((p) => [p.key, p.id]));
  const orgs = await db.organization.findMany({ where: organizationId ? { id: organizationId } : {}, select: { id: true } });
  let rolesCreated = 0, grants = 0;
  for (const org of orgs) {
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      let role = await db.role.findUnique({ where: { organizationId_key: { organizationId: org.id, key } } });
      if (!role) { role = await db.role.create({ data: { organizationId: org.id, key, name: def.name, system: true } }); rolesCreated++; }
      const have = new Set((await db.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } })).map((r) => r.permissionId));
      const missing = (def.permissions as readonly string[]).map((k) => perms.get(k)).filter((id): id is string => !!id && !have.has(id));
      if (missing.length) { await db.rolePermission.createMany({ data: missing.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true }); grants += missing.length; }
    }
  }
  return { organizations: orgs.length, rolesCreated, grants };
}

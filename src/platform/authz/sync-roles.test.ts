import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { SYSTEM_ROLES } from "./permissions";
import { syncSystemRoles } from "./sync-roles";

describe.skipIf(!process.env.DATABASE_URL)("Rollen-Sync", () => {
  let tenantId = "", orgId = "";
  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { name: "TEST-Sync" } })).id;
    orgId = (await db.organization.create({ data: { tenantId, name: "TEST-SYNC-A" } })).id;
  });
  afterAll(async () => {
    await db.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } });
    await db.role.deleteMany({ where: { organizationId: orgId } });
    await db.organization.delete({ where: { id: orgId } });
    await db.tenant.delete({ where: { id: tenantId } });
    await db.$disconnect();
  });

  it("legt Systemrollen an, ergänzt fehlende Berechtigungen, entfernt nichts und ist wiederholbar", async () => {
    const first = await syncSystemRoles(db, orgId);
    expect(first.rolesCreated).toBe(Object.keys(SYSTEM_ROLES).length);
    const finance = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgId, key: "finance" } } });
    const count = () => db.rolePermission.count({ where: { roleId: finance.id } });
    expect(await count()).toBe(SYSTEM_ROLES.finance!.permissions.length);

    // eine Berechtigung fehlt (wie nach einem Update) und eine zusätzliche, bewusst vergebene bleibt erhalten
    const missing = await db.permission.findUniqueOrThrow({ where: { key: "finance.invoice.in.accept_variance" } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: finance.id, permissionId: missing.id } } });
    const extra = await db.permission.findUniqueOrThrow({ where: { key: "hr.employee.read_sensitive" } });
    const hadExtra = (SYSTEM_ROLES.finance!.permissions as readonly string[]).includes(extra.key);
    if (!hadExtra) await db.rolePermission.create({ data: { roleId: finance.id, permissionId: extra.id } });

    const second = await syncSystemRoles(db, orgId);
    expect(second).toMatchObject({ rolesCreated: 0, grants: 1 });
    expect(await db.rolePermission.count({ where: { roleId: finance.id, permissionId: missing.id } })).toBe(1);
    expect(await db.rolePermission.count({ where: { roleId: finance.id, permissionId: extra.id } })).toBe(1);
    expect(await syncSystemRoles(db, orgId)).toMatchObject({ grants: 0 });
  });
});

/* Synthetische Demo-Daten – keine echten Personen- oder Finanzdaten. Nur für lokale Entwicklung. */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PERMISSIONS, SYSTEM_ROLES } from "../src/platform/authz/permissions";

const db = new PrismaClient();

async function main() {
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 12) throw new Error("SEED_DEMO_PASSWORD (min. 12 Zeichen) in .env setzen");
  if (process.env.NODE_ENV === "production") throw new Error("Seed läuft nicht in Produktion");

  for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, update: {}, create: { key } });
  const perms = await db.permission.findMany();

  const tenant = (await db.tenant.findFirst({ where: { name: "Demo" } })) ?? (await db.tenant.create({ data: { name: "Demo" } }));
  const orgs = [];
  for (const name of ["Muster GmbH", "Beispiel AG"]) {
    const org =
      (await db.organization.findFirst({ where: { tenantId: tenant.id, name } })) ??
      (await db.organization.create({ data: { tenantId: tenant.id, name } }));
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await db.role.upsert({
        where: { organizationId_key: { organizationId: org.id, key } },
        update: {},
        create: { organizationId: org.id, key, name: def.name, system: true },
      });
      await db.rolePermission.deleteMany({ where: { roleId: role.id } });
      await db.rolePermission.createMany({
        data: perms.filter((p) => (def.permissions as readonly string[]).includes(p.key)).map((p) => ({ roleId: role.id, permissionId: p.id })),
      });
    }
    orgs.push(org);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const users = [
    { email: "admin@demo.example", name: "Alex Admin", memberOf: [0, 1], role: "owner" },
    { email: "mitarbeiter@demo.example", name: "Max Mitarbeiter", memberOf: [0], role: "employee" },
  ];
  for (const u of users) {
    const user = await db.user.upsert({ where: { email: u.email }, update: {}, create: { email: u.email, name: u.name, passwordHash } });
    for (const i of u.memberOf) {
      const org = orgs[i]!;
      const role = await db.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: org.id, key: u.role } } });
      await db.organizationMembership.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
        update: { roleId: role.id },
        create: { userId: user.id, organizationId: org.id, roleId: role.id },
      });
    }
  }
  console.log("Seed fertig: admin@demo.example (Inhaber, 2 Organisationen), mitarbeiter@demo.example (Mitarbeiter)");
}

main().finally(() => db.$disconnect());

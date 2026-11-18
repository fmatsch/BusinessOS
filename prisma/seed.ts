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
    { email: "fuehrung@demo.example", name: "Franka Führung", memberOf: [0], role: "manager" },
    { email: "finanzen@demo.example", name: "Finn Finanzen", memberOf: [0], role: "finance" },
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
  // Mitarbeiterprofile (synthetisch) für die Demo-Benutzer der ersten Organisation + Urlaubsanspruch
  const org0 = orgs[0]!;
  const people: { email: string; number: string; first: string; last: string; title: string; manager?: string }[] = [
    { email: "fuehrung@demo.example", number: "100", first: "Franka", last: "Führung", title: "Teamleitung" },
    { email: "mitarbeiter@demo.example", number: "101", first: "Max", last: "Mitarbeiter", title: "Sachbearbeitung", manager: "fuehrung@demo.example" },
    { email: "finanzen@demo.example", number: "102", first: "Finn", last: "Finanzen", title: "Controlling" },
    { email: "admin@demo.example", number: "001", first: "Alex", last: "Admin", title: "Geschäftsführung" },
  ];
  const empIds: Record<string, string> = {};
  for (const p of people) {
    const user = await db.user.findUniqueOrThrow({ where: { email: p.email } });
    const existing = await db.employee.findFirst({ where: { organizationId: org0.id, userId: user.id } });
    const e = existing ?? (await db.employee.create({
      data: { organizationId: org0.id, number: p.number, firstName: p.first, lastName: p.last, jobTitle: p.title, email: p.email, userId: user.id, managerId: p.manager ? empIds[p.manager] : null },
    }));
    empIds[p.email] = e.id;
    if (!(await db.employment.findFirst({ where: { employeeId: e.id } })))
      await db.employment.create({ data: { organizationId: org0.id, employeeId: e.id, validFrom: new Date("2020-01-01T00:00:00Z"), contractType: "FULL_TIME", weeklyHours: 38.5 } });
    if (!(await db.leaveBalanceEntry.findFirst({ where: { employeeId: e.id, year: new Date().getFullYear(), kind: "ENTITLEMENT" } })))
      await db.leaveBalanceEntry.create({ data: { organizationId: org0.id, employeeId: e.id, year: new Date().getFullYear(), kind: "ENTITLEMENT", days: 25, note: "Jahresanspruch (Demo)" } });
  }
  console.log("Seed fertig: admin@ (Inhaber, 2 Organisationen), mitarbeiter@, fuehrung@, finanzen@demo.example");
}

main().finally(() => db.$disconnect());

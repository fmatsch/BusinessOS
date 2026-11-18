/* Ergänzt fehlende Berechtigungen der Systemrollen in allen Organisationen. Nach jedem Deployment ausführen: npm run db:sync-roles */
import { PrismaClient } from "@prisma/client";
import { syncSystemRoles } from "../src/platform/authz/sync-roles";

const db = new PrismaClient();
syncSystemRoles(db)
  .then((r) => console.log("Rollen-Sync:", r))
  .catch((e) => { console.error("Rollen-Sync fehlgeschlagen", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

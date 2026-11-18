/* Hintergrund-Worker: verarbeitet die Outbox in Intervallen. Start: npm run worker */
import { PrismaClient } from "@prisma/client";
import { runOutbox } from "../src/modules/events";
import { syncSystemRoles } from "../src/platform/authz/sync-roles";

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  console.log(`Worker gestartet (Intervall ${intervalMs} ms)`);
  // neue Berechtigungen der Systemrollen bei jedem Start in bestehende Organisationen übernehmen (rein ergänzend)
  const db = new PrismaClient();
  // die Datenbank kann beim Start noch hochfahren oder wiederherstellen: bis zu 2 Minuten erneut versuchen
  try {
    for (let attempt = 1; ; attempt++) {
      try { console.log("Rollen-Sync:", await syncSystemRoles(db)); break; } catch (e) {
        if (attempt >= 24) throw e;
        console.log(`Datenbank noch nicht bereit (Versuch ${attempt}) – warte …`);
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  } finally { await db.$disconnect(); }
  while (!stopping) {
    const r = await runOutbox();
    if (r.processed || r.retried || r.dead) console.log(new Date().toISOString(), r);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  console.log("Worker beendet");
}

main().catch((e) => {
  console.error("Worker abgebrochen", e);
  process.exit(1);
});

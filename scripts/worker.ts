/* Hintergrund-Worker: verarbeitet die Outbox in Intervallen. Start: npm run worker */
import { runOutbox } from "../src/modules/events";

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  console.log(`Worker gestartet (Intervall ${intervalMs} ms)`);
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

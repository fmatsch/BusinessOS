// Startet eine lokale PostgreSQL ohne Docker (nur für Entwicklung/Tests). Daten liegen außerhalb des Projekts.
import EmbeddedPostgres from "embedded-postgres";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dir = process.env.DEV_DB_DIR ?? path.join(os.tmpdir(), "businessos-pg-utf8");
const port = Number(process.env.DEV_DB_PORT ?? 54329);
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: "businessos", password: "dev-only-password", port, persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});
if (!fs.existsSync(path.join(dir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try { await pg.createDatabase("businessos"); } catch { /* existiert bereits */ }
console.log(`READY postgresql://businessos:dev-only-password@localhost:${port}/businessos`);
process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);

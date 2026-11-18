// Startet eine eingebettete PostgreSQL ohne Docker für den lokalen Betrieb (Installer, „Dieses System“).
// Daten liegen dauerhaft im angegebenen Ordner. Nicht für Produktivdaten mit hohen Anforderungen gedacht (keine Replikation, keine Wartung durch das System).
// Konfiguration über Umgebungsvariablen: LOCAL_DB_DIR, LOCAL_DB_PORT, LOCAL_DB_USER, LOCAL_DB_PASSWORD, LOCAL_DB_NAME.
import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import fs from "node:fs";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} fehlt`); process.exit(2); } return v; };
const dir = path.resolve(need("LOCAL_DB_DIR"));
const port = Number(need("LOCAL_DB_PORT"));
const user = need("LOCAL_DB_USER"), password = need("LOCAL_DB_PASSWORD"), dbName = need("LOCAL_DB_NAME");

const pg = new EmbeddedPostgres({ databaseDir: dir, user, password, port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: (e) => console.error(String(e).slice(0, 300)) });
if (!fs.existsSync(path.join(dir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try { await pg.createDatabase(dbName); } catch { /* existiert bereits */ }
console.log(`READY ${port}`);

let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; try { await pg.stop(); } finally { process.exit(0); } };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);

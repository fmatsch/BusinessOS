// Startet BusinessOS lokal: (eingebettete Datenbank), Worker und Webserver als Prozessgruppe. Strg+C beendet alles.
// Liest .env im Projektordner; LOCAL_DB_* in .env schaltet die eingebettete Datenbank ein. Port: PORT (Standard 3000).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const env = { ...loadEnv(path.join(root, ".env")), ...process.env };
// Direkt mit Node starten (ohne Shell): plattformunabhängig und ohne Shell-Maskierungsprobleme
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const children = [];
let stopping = false;

function run(label, cmd, args, extra = {}) {
  const p = spawn(cmd, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${label}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => { if (!stopping) { console.error(`[${label}] beendet (Code ${code}) – alles wird gestoppt`); stop(1); } });
  children.push(p);
  return p;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      // Windows: SIGTERM beendet nur den direkten Prozess; Next.js startet Unterprozesse – daher den ganzen Baum beenden
      if (process.platform === "win32" && c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch { /* schon beendet */ }
  }
  setTimeout(() => process.exit(code), 4000).unref();
  Promise.all(children.map((c) => new Promise((r) => c.once("exit", r)))).then(() => process.exit(code));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function waitPort(port, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((res) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Port ${port} wurde nicht erreichbar`);
}

const portInUse = (p) => new Promise((res) => { const s = net.connect(p, "127.0.0.1", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
if (await portInUse(Number(env.PORT ?? 3000))) { console.error(`Port ${env.PORT ?? 3000} ist bereits belegt (läuft BusinessOS schon?). Abbruch.`); process.exit(1); }
if (!fs.existsSync(path.join(root, ".next"))) { console.error("Kein Build gefunden (.next). Bitte zuerst installieren/bauen: npm run build"); process.exit(1); }

if (env.LOCAL_DB_DIR) {
  // erst weitermachen, wenn die Datenbank „READY“ meldet (der Port allein genügt nicht: sie kann noch hochfahren)
  await new Promise((resolve, reject) => {
    const db = run("db", process.execPath, [path.join(root, "scripts", "local-db.mjs")]);
    const t = setTimeout(() => reject(new Error("Die Datenbank wurde nicht rechtzeitig bereit")), 120_000);
    db.stdout.on("data", (d) => { if (String(d).includes("READY")) { clearTimeout(t); resolve(); } });
  });
}
const port = String(env.PORT ?? 3000);
run("worker", process.execPath, [tsxCli, "scripts/worker.ts"]);
run("web", process.execPath, [nextCli, "start", "-p", port, "-H", env.HOST ?? "127.0.0.1"]);
await waitPort(Number(port));
console.log(`BusinessOS läuft: http://localhost:${port}  (beenden mit Strg+C)`);

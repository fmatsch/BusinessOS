// Ablauf „Dieses System“: Voraussetzungen prüfen, Datenbank wählen (Docker oder eingebettet oder vorhandene), .env schreiben, Abhängigkeiten
// installieren, Datenbank migrieren, bauen, ersten Benutzer anlegen, Startskripte schreiben, optional Autostart.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { renderEnv, parseEnv } from "./envfile.mjs";
import { randomB64Url, randomHex } from "./secrets.mjs";
import { isPort, nodeOk, shq } from "./validate.mjs";

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const npxCmd = isWin ? "npx.cmd" : "npx";

/** Führt einen Befehl im Projektordner aus und zeigt die Ausgabe; bricht bei Fehler ab. */
function run(ui, cmd, args, { cwd, env = {}, label } = {}) {
  ui.line(`\n▶ ${label ?? `${cmd} ${args.join(" ")}`}`);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], shell: isWin });
    const show = (d) => ui.write(String(d));
    p.stdout.on("data", show);
    p.stderr.on("data", show);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`„${label ?? cmd}“ ist fehlgeschlagen (Code ${code}).`))));
  });
}

export const portFree = (port) => new Promise((res) => {
  const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
  s.listen(port, "127.0.0.1");
});

export function dockerAvailable() {
  const r = spawnSync("docker", ["compose", "version"], { stdio: "ignore", shell: isWin });
  return r.status === 0;
}

async function waitPort(port, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); })) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Die Datenbank wurde auf Port ${port} nicht erreichbar.`);
}

/**
 * @param {object} o appDir, port, db ("docker"|"embedded"|"external"), dbUrl?, dbPort?, admin{email,name,password,orgName}, autostart?, startNow?, force?, skipBuild?
 */
export async function installLocal(o, ui) {
  const { appDir } = o;
  if (!nodeOk()) throw new Error(`Node.js ${process.versions.node} ist zu alt. Benötigt wird 20.9 oder neuer (https://nodejs.org).`);
  if (!fs.existsSync(path.join(appDir, "package.json"))) throw new Error(`Kein Projektordner: ${appDir}`);
  const envPath = path.join(appDir, ".env");
  if (fs.existsSync(envPath) && !o.force) throw new Error(`${envPath} existiert bereits – vorhandene Installation? Mit --force wird sie überschrieben (die Datenbank bleibt unberührt, aber die Schlüssel ändern sich).`);
  if (!isPort(o.port)) throw new Error("Ungültiger Port.");
  if (!(await portFree(Number(o.port)))) throw new Error(`Port ${o.port} ist belegt. Bitte einen anderen Port wählen (--port).`);

  // 1) Datenbank festlegen
  const dbName = "businessos", dbUser = "businessos", dbPassword = randomHex(18);
  let databaseUrl, extraEnv = {};
  let embeddedProc = null;
  const dataDir = path.join(appDir, "data", "postgres");
  if (o.db === "docker") {
    if (!dockerAvailable()) throw new Error("Docker (mit „docker compose“) wurde nicht gefunden. Bitte Docker installieren oder eine andere Datenbank wählen.");
    const dbPort = Number(o.dbPort ?? 5432);
    if (!(await portFree(dbPort))) throw new Error(`Port ${dbPort} ist belegt (läuft schon eine PostgreSQL?). Bitte --db-port wählen.`);
    databaseUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${dbPort}/${dbName}?schema=public`;
    extraEnv = { POSTGRES_USER: dbUser, POSTGRES_PASSWORD: dbPassword, POSTGRES_DB: dbName };
  } else if (o.db === "embedded") {
    const dbPort = Number(o.dbPort ?? 54320);
    if (!(await portFree(dbPort))) throw new Error(`Port ${dbPort} ist belegt. Bitte --db-port wählen.`);
    databaseUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${dbPort}/${dbName}?schema=public`;
    extraEnv = { LOCAL_DB_DIR: dataDir.replace(/\\/g, "/"), LOCAL_DB_PORT: String(dbPort), LOCAL_DB_USER: dbUser, LOCAL_DB_PASSWORD: dbPassword, LOCAL_DB_NAME: dbName };
  } else if (o.db === "external") {
    if (!/^postgres(ql)?:\/\//.test(o.dbUrl ?? "")) throw new Error("Die Datenbank-Adresse muss mit postgresql:// beginnen.");
    databaseUrl = o.dbUrl;
  } else throw new Error("Unbekannte Datenbankart.");

  const values = {
    DATABASE_URL: databaseUrl, AUTH_SECRET: randomB64Url(32), AUTH_TRUST_HOST: "true", AUTH_URL: `http://localhost:${o.port}`, PORT: String(o.port), NODE_ENV: "production", ...extraEnv,
  };
  ui.line(`\nDatenbank: ${o.db === "docker" ? "PostgreSQL in Docker" : o.db === "embedded" ? "eingebettetes PostgreSQL (lokal, für Test und kleine Einsätze)" : "vorhandene PostgreSQL"}`);
  fs.writeFileSync(envPath, renderEnv(values), { mode: 0o600 });
  ui.line(`Konfiguration geschrieben: ${envPath}`);
  const env = { ...parseEnv(fs.readFileSync(envPath, "utf8")) };

  try {
    // 2) Abhängigkeiten
    await run(ui, npmCmd, ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: appDir, label: "Abhängigkeiten installieren (npm ci)" });

    // 3) Datenbank starten
    if (o.db === "docker") {
      await run(ui, "docker", ["compose", "up", "-d", "db"], { cwd: appDir, env, label: "Datenbank starten (Docker)" });
      await waitPort(Number(o.dbPort ?? 5432));
    } else if (o.db === "embedded") {
      ui.line("\n▶ Eingebettete Datenbank starten");
      embeddedProc = spawn(process.execPath, [path.join(appDir, "scripts", "local-db.mjs")], { cwd: appDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let ready = false; let log = "";
      embeddedProc.stdout.on("data", (d) => { log += d; if (String(d).includes("READY")) ready = true; });
      embeddedProc.stderr.on("data", (d) => { log += d; });
      const t0 = Date.now();
      while (!ready && Date.now() - t0 < 120_000) {
        if (embeddedProc.exitCode !== null) throw new Error(`Die eingebettete Datenbank ist beendet: ${log.slice(-400)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) throw new Error("Die eingebettete Datenbank wurde nicht rechtzeitig bereit.");
    }

    // 4) Schema, Rollen, Build, erster Benutzer
    await run(ui, npxCmd, ["prisma", "generate"], { cwd: appDir, env, label: "Datenbankzugriff erzeugen (prisma generate)" });
    await run(ui, npxCmd, ["prisma", "migrate", "deploy"], { cwd: appDir, env, label: "Datenbank einrichten (Migrationen)" });
    if (!o.skipBuild) await run(ui, npmCmd, ["run", "build"], { cwd: appDir, env: { ...env, NEXT_TELEMETRY_DISABLED: "1" }, label: "Anwendung bauen (npm run build)" });
    await run(ui, npxCmd, ["tsx", "scripts/sync-roles.ts"], { cwd: appDir, env, label: "Rollen und Rechte anlegen" });
    await run(ui, npxCmd, ["tsx", "scripts/create-admin.ts"], {
      cwd: appDir, label: "Ersten Benutzer anlegen",
      env: { ...env, ADMIN_EMAIL: o.admin.email, ADMIN_NAME: o.admin.name, ADMIN_PASSWORD: o.admin.password, ORG_NAME: o.admin.orgName },
    });
  } finally {
    if (embeddedProc && embeddedProc.exitCode === null) {
      embeddedProc.kill("SIGTERM");
      await new Promise((r) => { embeddedProc.once("exit", r); setTimeout(r, 15_000); });
    }
  }

  // 5) Startskripte und optional Autostart
  const runJs = path.join(appDir, "scripts", "run-local.mjs");
  const startSh = path.join(appDir, "start.sh"), startCmd = path.join(appDir, "start.cmd");
  fs.writeFileSync(startSh, `#!/usr/bin/env sh\ncd ${shq(appDir)} && exec ${shq(process.execPath)} ${shq(runJs)}\n`, { mode: 0o755 });
  fs.writeFileSync(startCmd, `@echo off\r\ncd /d "${appDir}"\r\n"${process.execPath}" "${runJs}"\r\n`);
  ui.line(`\nStartskripte: ${isWin ? startCmd : startSh}`);

  if (o.autostart) await setupAutostart(ui, { appDir, runJs });

  ui.line("\n────────────────────────────────────────────");
  ui.line("BusinessOS ist installiert.");
  ui.line(`Starten:      ${isWin ? "start.cmd" : "./start.sh"}   (oder: node scripts/run-local.mjs)`);
  ui.line(`Adresse:      http://localhost:${o.port}`);
  ui.line(`Anmeldung:    ${o.admin.email}`);
  ui.line(`Daten:        ${o.db === "embedded" ? dataDir : o.db === "docker" ? "Docker-Volume „pgdata“" : "Ihre PostgreSQL"}`);
  if (o.db === "embedded") ui.line("Hinweis:      Die eingebettete Datenbank ist für Test und kleine Einsätze gedacht. Für Produktivdaten bitte PostgreSQL (Docker oder Server) verwenden und regelmäßig sichern.");
  ui.line("────────────────────────────────────────────");
  return { runJs, startFile: isWin ? startCmd : startSh };
}

async function setupAutostart(ui, { appDir, runJs }) {
  try {
    if (isWin) {
      const r = spawnSync("schtasks", ["/Create", "/TN", "BusinessOS", "/TR", `"${process.execPath}" "${runJs}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"], { encoding: "utf8" });
      ui.line(r.status === 0 ? "Autostart eingerichtet (Aufgabenplanung „BusinessOS“, bei Anmeldung)." : `Autostart konnte nicht eingerichtet werden: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
    } else if (process.platform === "linux") {
      const dir = path.join(os.homedir(), ".config", "systemd", "user");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "businessos.service"), `[Unit]\nDescription=BusinessOS\n\n[Service]\nWorkingDirectory=${appDir}\nExecStart=${process.execPath} ${runJs}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
      const r = spawnSync("systemctl", ["--user", "enable", "--now", "businessos.service"], { encoding: "utf8" });
      ui.line(r.status === 0 ? "Autostart eingerichtet (systemd --user)." : `Autostart konnte nicht eingerichtet werden: ${(r.stderr || "").trim().slice(0, 200)}`);
    } else ui.line("Autostart wird für dieses Betriebssystem nicht automatisch eingerichtet.");
  } catch (e) { ui.line(`Autostart konnte nicht eingerichtet werden: ${e.message}`); }
}

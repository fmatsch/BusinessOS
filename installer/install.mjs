#!/usr/bin/env node
// BusinessOS-Installer: „Dieses System“ oder „Ubuntu-Server per SSH“. Ohne Parameter führt er durch alle Fragen.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askUbuntu, askAdmin, buildStage, defaultAppDir, installUbuntu } from "./lib/ubuntu.mjs";
import { dockerAvailable, installLocal } from "./lib/local.mjs";
import { Prompter } from "./lib/prompt.mjs";
import { isDomain, isEmail, isHost, isPort, isText, isUnixUser, nodeOk, passwordProblem } from "./lib/validate.mjs";
import { newSecrets } from "./lib/ubuntu.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const HELP = `BusinessOS-Installer

Aufruf:  node installer/install.mjs [Parameter]      (oder install.cmd / ./install.sh)

Ohne Parameter werden alle Angaben interaktiv abgefragt.

Allgemein
  --target local|ubuntu      Ziel: dieses System oder ein Ubuntu-Server
  --app-dir <Ordner>         Projektordner (Standard: der Ordner über dem Installer)
  --admin-email <E-Mail>     erster Benutzer (Inhaber)
  --admin-name <Name>        Name des ersten Benutzers
  --org-name <Name>          Name der Organisation/Firma
  --yes                      keine Rückfragen vor dem Start
  --dry-run                  nur prüfen und anzeigen, nichts ändern
  --help                     diese Hilfe
  Passwort des ersten Benutzers: Umgebungsvariable BOS_ADMIN_PASSWORD (nie als Parameter)

Dieses System (--target local)
  --db docker|embedded|external   Datenbank (Standard: docker, falls vorhanden, sonst embedded)
  --db-url <postgresql://…>       bei --db external
  --db-port <Port>                Port der Datenbank
  --port <Port>                   Port der Anwendung (Standard 3000)
  --autostart                     beim Anmelden automatisch starten (Windows/Linux)
  --force                         vorhandene .env überschreiben

Ubuntu-Server (--target ubuntu)
  --host <Name|IP>  --ssh-port <Port>  --ssh-user <Benutzer>
  --key <Schlüsseldatei>          statt Passwort-Anmeldung
  --domain <name>  --acme-email <E-Mail>   HTTPS mit Let's Encrypt (sonst nur HTTP)
  --ufw yes|no                    Firewall einrichten
  --mode install|update           Neu installieren oder aktualisieren
  --accept-fingerprint <SHA256:…> Host-Schlüssel ohne Rückfrage akzeptieren (nur dieser Wert)
  Passwörter: BOS_SSH_PASSWORD, BOS_SSH_KEY_PASSPHRASE, BOS_SUDO_PASSWORD (Umgebungsvariablen)
`;

function parseArgs(argv) {
  const flags = new Set(["yes", "dry-run", "help", "autostart", "force", "skip-build"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unbekanntes Argument: ${a}`);
    const k = a.slice(2);
    if (flags.has(k)) out[k] = true;
    else { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`Wert für --${k} fehlt`); out[k] = v; }
  }
  return out;
}

const must = (cond, msg) => { if (!cond) throw new Error(msg); };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(HELP); return; }
  const ui = new Prompter();
  ui.line("BusinessOS-Installer\n");
  if (!nodeOk()) throw new Error(`Node.js ${process.versions.node} ist zu alt (benötigt: 20.9 oder neuer).`);
  const appDir = path.resolve(a["app-dir"] ?? defaultAppDir(here));

  const target = a.target ?? (await ui.choose("Wo soll BusinessOS laufen?", [
    { value: "local", label: "Auf diesem System (alles Notwendige wird lokal installiert)" },
    { value: "ubuntu", label: "Auf einem Ubuntu-Server (Zugangsdaten werden abgefragt, der Server wird per SSH eingerichtet)" },
  ]));
  must(["local", "ubuntu"].includes(target), "--target muss local oder ubuntu sein");

  const adminGiven = {
    email: a["admin-email"], name: a["admin-name"], orgName: a["org-name"], password: process.env.BOS_ADMIN_PASSWORD || undefined,
  };
  if (adminGiven.email) must(isEmail(adminGiven.email), "Ungültige --admin-email");
  if (adminGiven.name) must(isText(adminGiven.name, 100), "Ungültiger --admin-name");
  if (adminGiven.orgName) must(isText(adminGiven.orgName), "Ungültiger --org-name");
  if (adminGiven.password) must(!passwordProblem(adminGiven.password), passwordProblem(adminGiven.password) ?? "");

  if (target === "local") {
    const dockerOk = dockerAvailable();
    const db = a.db ?? (a.yes ? (dockerOk ? "docker" : "embedded") : await ui.choose("Datenbank", [
      ...(dockerOk ? [{ value: "docker", label: "PostgreSQL in Docker (empfohlen)" }] : []),
      { value: "embedded", label: "Eingebettetes PostgreSQL – ohne Docker, für Test und kleine Einsätze" },
      { value: "external", label: "Vorhandene PostgreSQL (Adresse wird abgefragt)" },
    ]));
    must(["docker", "embedded", "external"].includes(db), "--db muss docker, embedded oder external sein");
    const dbUrl = db === "external" ? (a["db-url"] ?? await ui.ask("Datenbank-Adresse (postgresql://Benutzer:Passwort@Host:5432/Datenbank)", { validate: (v) => (/^postgres(ql)?:\/\//.test(v) ? null : "Die Adresse muss mit postgresql:// beginnen.") })) : undefined;
    const port = a.port ?? (a.yes ? "3000" : await ui.ask("Port der Anwendung", { def: "3000", validate: (v) => (isPort(v) ? null : "Ungültiger Port.") }));
    must(isPort(port), "Ungültiger --port");
    if (a["db-port"]) must(isPort(a["db-port"]), "Ungültiger --db-port");
    const admin = await askAdmin(ui, adminGiven);
    const autostart = a.autostart ?? (a.yes ? false : (process.platform === "win32" || process.platform === "linux") && (await ui.confirm("BusinessOS beim Anmelden automatisch starten?", false)));

    ui.line("\nZusammenfassung");
    ui.line(`  Ziel:          dieses System (${process.platform})`);
    ui.line(`  Projektordner: ${appDir}`);
    ui.line(`  Datenbank:     ${db}${a["db-port"] ? ` (Port ${a["db-port"]})` : ""}`);
    ui.line(`  Adresse:       http://localhost:${port}`);
    ui.line(`  Inhaber:       ${admin.name} <${admin.email}>, Organisation „${admin.orgName}“`);
    if (a["dry-run"]) { ui.line("\nTrockenlauf: nichts geändert."); return; }
    if (!a.yes && !(await ui.confirm("\nJetzt installieren?", true))) { ui.line("Abgebrochen."); return; }
    await installLocal({ appDir, port, db, dbUrl, dbPort: a["db-port"], admin, autostart: Boolean(autostart), force: Boolean(a.force), skipBuild: Boolean(a["skip-build"]) }, ui);
    return;
  }

  // Ubuntu
  const given = {
    host: a.host, sshPort: a["ssh-port"] ? Number(a["ssh-port"]) : undefined, sshUser: a["ssh-user"],
    authMethod: a.key ? "key" : (process.env.BOS_SSH_PASSWORD ? "password" : undefined), keyPath: a.key,
    sshPassword: process.env.BOS_SSH_PASSWORD || undefined, passphrase: process.env.BOS_SSH_KEY_PASSPHRASE || undefined, sudoPassword: process.env.BOS_SUDO_PASSWORD || undefined,
    mode: a.mode, domain: a.domain, acmeEmail: a["acme-email"], enableUfw: a.ufw === undefined ? undefined : a.ufw === "yes",
    admin: adminGiven.email && adminGiven.name && adminGiven.orgName && adminGiven.password ? adminGiven : undefined,
    acceptFingerprint: a["accept-fingerprint"], appDir,
  };
  if (given.host) must(isHost(given.host), "Ungültiger --host");
  if (given.sshPort) must(isPort(given.sshPort), "Ungültiger --ssh-port");
  if (given.sshUser) must(isUnixUser(given.sshUser), "Ungültiger --ssh-user");
  if (given.domain) must(isDomain(given.domain), "Ungültige --domain (Kleinbuchstaben, z. B. erp.beispiel.at)");
  if (given.acmeEmail) must(isEmail(given.acmeEmail), "Ungültige --acme-email");
  if (given.mode) must(["install", "update"].includes(given.mode), "--mode muss install oder update sein");
  if (a.yes) { given.sshPort ??= 22; given.sshUser ??= "root"; given.mode ??= "install"; given.domain ??= ""; given.enableUfw ??= true; }

  const o = await askUbuntu(ui, given);
  if (o.admin) must(!passwordProblem(o.admin.password), "Das Passwort des ersten Benutzers ist zu schwach.");

  ui.line("\nZusammenfassung");
  ui.line(`  Ziel:       Ubuntu-Server ${o.sshUser}@${o.host}:${o.sshPort}`);
  ui.line(`  Aktion:     ${o.mode === "install" ? "Neu installieren" : "Aktualisieren"}`);
  ui.line(`  Adresse:    ${o.domain ? `https://${o.domain} (Let's Encrypt, E-Mail ${o.acmeEmail})` : `http://${o.host} (ohne Verschlüsselung)`}`);
  ui.line(`  Firewall:   ${o.enableUfw ? `ufw (SSH ${o.sshPort}, 80, 443)` : "unverändert"}`);
  ui.line("  Auf dem Server: PostgreSQL, nginx, Node.js 22, Systemdienste, tägliche Datenbanksicherung");
  if (o.admin) ui.line(`  Inhaber:    ${o.admin.name} <${o.admin.email}>, Organisation „${o.admin.orgName}“`);
  if (a["dry-run"]) {
    const files = buildStage({ mode: o.mode, release: "20000101000000", domain: o.domain, acmeEmail: o.acmeEmail, sshPort: o.sshPort, enableUfw: o.enableUfw, host: o.host, admin: o.admin, secrets: newSecrets() });
    ui.line(`\nTrockenlauf: ${Object.keys(files).length} Dateien würden übertragen (${Object.keys(files).join(", ")}). Nichts geändert.`);
    return;
  }
  if (!a.yes && !(await ui.confirm("\nJetzt einrichten?", true))) { ui.line("Abgebrochen."); return; }
  await installUbuntu(o, ui);
}

main().catch((e) => { console.error(`\nFehler: ${e instanceof Error ? e.message : e}`); process.exit(1); });

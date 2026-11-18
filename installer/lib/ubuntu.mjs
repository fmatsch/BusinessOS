// Ablauf „Ubuntu-Server“: Zugangsdaten → Verbindung (Host-Schlüssel bestätigen) → Prüfung → Dateien hochladen → Einrichtung als root → Zusammenfassung.
import path from "node:path";
import { cleanupPack, packApp } from "./pack.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderEnv } from "./envfile.mjs";
import { randomB64Url, randomHex, randomPassword } from "./secrets.mjs";
import {
  APP_PORT, BACKUP_SERVICE, BACKUP_TIMER, PROVISION_SH, renderAdminEnv, renderBackupScript, renderNginx, renderParams, renderWebUnit, renderWorkerUnit,
} from "./ubuntu-script.mjs";
import { isDomain, isEmail, isHost, isPort, isText, isUnixUser, passwordProblem } from "./validate.mjs";

const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** Alle Dateien für den Server als { Name: Inhalt|Pfad, mode } – rein, damit testbar. */
export function buildStage({ mode, release, domain, acmeEmail, sshPort, enableUfw, host, admin, secrets }) {
  const files = {
    "provision.sh": { data: PROVISION_SH, mode: 0o700 },
    params: { data: renderParams({ mode, release, domain, acmeEmail, sshPort, enableUfw }), mode: 0o600 },
    "businessos.service": { data: renderWebUnit(), mode: 0o644 },
    "businessos-worker.service": { data: renderWorkerUnit(), mode: 0o644 },
    "businessos-backup": { data: renderBackupScript(), mode: 0o700 },
    "businessos-backup.service": { data: BACKUP_SERVICE, mode: 0o644 },
    "businessos-backup.timer": { data: BACKUP_TIMER, mode: 0o644 },
    "nginx.conf": { data: renderNginx({ domain }), mode: 0o644 },
  };
  if (mode === "install") {
    const url = domain ? `http://${domain}` : `http://${host}`;
    files.env = {
      mode: 0o600,
      data: renderEnv({
        NODE_ENV: "production", DB_NAME: "businessos", DB_USER: "businessos", DB_PASSWORD: secrets.dbPassword,
        DATABASE_URL: `postgresql://businessos:${secrets.dbPassword}@127.0.0.1:5432/businessos?schema=public`,
        AUTH_SECRET: secrets.authSecret, AUTH_TRUST_HOST: "true", AUTH_URL: url, PORT: String(APP_PORT),
      }),
    };
    files["admin.env"] = { data: renderAdminEnv(admin), mode: 0o600 };
  }
  return files;
}

export function newSecrets() {
  return { dbPassword: randomHex(24), authSecret: randomB64Url(32) };
}

/**
 * @param {object} opts  host, sshPort, sshUser, authMethod ("password"|"key"), sshPassword?, keyPath?, passphrase?, sudoPassword?, mode,
 *   domain?, acmeEmail?, enableUfw, admin?{email,name,password,orgName}, appDir, acceptFingerprint?
 * @param {import("./prompt.mjs").Prompter} ui
 */
/** Lädt die SSH-Bibliothek erst bei Bedarf und installiert sie beim ersten Mal in den Installer-Ordner. */
async function loadSsh(ui) {
  try { return await import("./ssh.mjs"); } catch (e) {
    if (!String(e?.code ?? e).includes("MODULE_NOT_FOUND") && !String(e).includes("Cannot find")) throw e;
    ui.line("Die SSH-Bibliothek wird einmalig installiert (npm install im Installer-Ordner) …");
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error("npm install im Installer-Ordner ist fehlgeschlagen (Internetzugang nötig).");
    return import("./ssh.mjs");
  }
}

export async function installUbuntu(opts, ui) {
  const log = (s) => ui.line(s);
  const { SshSession } = await loadSsh(ui);
  const ssh = new SshSession();
  let pack = null;
  try {
    log(`\nVerbinde mit ${opts.sshUser}@${opts.host}:${opts.sshPort} …`);
    await ssh.connect({
      host: opts.host, port: opts.sshPort, username: opts.sshUser, password: opts.authMethod === "password" ? opts.sshPassword : undefined,
      privateKey: opts.authMethod === "key" ? opts.keyPath : undefined, passphrase: opts.passphrase,
      confirmHostKey: async (fp) => {
        if (opts.acceptFingerprint) {
          if (opts.acceptFingerprint === fp) return true;
          throw new Error(`Der Host-Schlüssel des Servers ist ${fp}, erwartet war ${opts.acceptFingerprint}. Abbruch.`);
        }
        log(`Fingerabdruck des Servers: ${fp}`);
        log("Vergleichen Sie ihn mit dem Wert, den Ihr Anbieter nennt (oder `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` auf dem Server).");
        return ui.confirm("Stimmt der Fingerabdruck und soll die Verbindung fortgesetzt werden?", false);
      },
    });

    // 1) Rechte und System prüfen
    const asRoot = (await ssh.exec("id -u")).out.trim() === "0";
    const sudoPw = asRoot ? undefined : (opts.sudoPassword ?? opts.sshPassword);
    const sudoPrefix = asRoot ? "" : "sudo -S -p '' ";
    if (!asRoot) {
      const t = await ssh.exec(`${sudoPrefix}true`, { stdin: sudoPw !== undefined ? sudoPw + "\n" : "\n" });
      if (t.code !== 0) throw new Error(`Der Benutzer ${opts.sshUser} darf kein sudo ausführen (oder das sudo-Passwort stimmt nicht). Bitte root oder einen Benutzer mit sudo-Recht verwenden.`);
    }
    const sys = await ssh.exec(". /etc/os-release 2>/dev/null; echo \"$ID $VERSION_ID $(uname -m)\"");
    log(`System: ${sys.out.trim() || "unbekannt"}`);

    // 2) Dateien vorbereiten
    log("Packe die Anwendung …");
    pack = await packApp(opts.appDir);
    log(`  Archiv: ${(pack.size / 1024 / 1024).toFixed(1)} MB`);
    const files = buildStage({
      mode: opts.mode, release: stamp(), domain: opts.domain, acmeEmail: opts.acmeEmail, sshPort: opts.sshPort, enableUfw: opts.enableUfw,
      host: opts.host, admin: opts.admin, secrets: newSecrets(),
    });

    // 3) Hochladen in ein privates Staging-Verzeichnis
    const stage = (await ssh.exec("mktemp -d /tmp/bos.XXXXXX")).out.trim().split("\n")[0];
    if (!/^\/tmp\/bos\.[A-Za-z0-9]+$/.test(stage)) throw new Error("Staging-Verzeichnis konnte nicht angelegt werden.");
    log("Übertrage Dateien …");
    await ssh.upload(pack.file, `${stage}/app.tar.gz`, 0o600);
    for (const [name, f] of Object.entries(files)) await ssh.upload(f.data, `${stage}/${name}`, f.mode);

    // 4) Einrichtung als root; Ausgabe wird live gezeigt
    log("\nRichte den Server ein (das dauert einige Minuten) …\n");
    const run = await ssh.exec(`${sudoPrefix}bash ${stage}/provision.sh ${stage}`, { stdin: sudoPw !== undefined ? sudoPw + "\n" : undefined, onOutput: (s) => ui.write(s) });

    // 5) Aufräumen (enthält Geheimnisse): überschreiben und löschen
    await ssh.exec(`cd ${stage} 2>/dev/null && { shred -u env admin.env 2>/dev/null || rm -f env admin.env; }; rm -rf ${stage}; true`);
    if (run.code !== 0 || !run.out.includes("RESULT_OK")) throw new Error("Die Einrichtung ist fehlgeschlagen (siehe Ausgabe oben). Nach Behebung kann der Installer erneut gestartet werden.");

    const url = opts.domain ? `http://${opts.domain}${""}` : `http://${opts.host}`;
    log("\n────────────────────────────────────────────");
    log(opts.mode === "install" ? "BusinessOS ist installiert." : "BusinessOS wurde aktualisiert.");
    log(`Adresse:        ${opts.domain ? `https://${opts.domain} (falls das Zertifikat ausgestellt wurde, sonst ${url})` : url}`);
    if (opts.mode === "install" && opts.admin) log(`Anmeldung:      ${opts.admin.email} (Passwort wie eingegeben)`);
    log("Konfiguration:  /etc/businessos/env (nur root/Dienst lesbar; enthält Datenbank- und Sitzungsschlüssel)");
    log("Sicherungen:    täglich nach /var/backups/businessos (14 Tage); Wiederherstellung: gunzip -c Datei | psql -h 127.0.0.1 -U businessos businessos");
    log("Protokolle:     journalctl -u businessos -u businessos-worker -f");
    if (!opts.domain) log("Hinweis:        Ohne Domain läuft BusinessOS unverschlüsselt (HTTP). Für den Betrieb im Internet bitte eine Domain mit Zertifikat einrichten (Installer erneut mit Domain ausführen ist nicht nötig: später `certbot --nginx -d <domain>` und AUTH_URL in /etc/businessos/env anpassen).");
    log("────────────────────────────────────────────");
    return { ok: true };
  } finally {
    if (pack) cleanupPack(pack);
    ssh.close();
  }
}

/** Interaktive Abfrage der Zugangsdaten und Optionen für den Ubuntu-Server. Vorgaben aus Parametern werden nicht erneut erfragt. */
export async function askUbuntu(ui, given) {
  const o = { ...given };
  o.host ??= await ui.ask("Server (Hostname oder IP-Adresse)", { validate: (v) => (isHost(v) ? null : "Bitte einen gültigen Hostnamen oder eine IP-Adresse eingeben.") });
  o.sshPort ??= Number(await ui.ask("SSH-Port", { def: "22", validate: (v) => (isPort(v) ? null : "Ungültiger Port.") }));
  o.sshUser ??= await ui.ask("SSH-Benutzer", { def: "root", validate: (v) => (isUnixUser(v) ? null : "Ungültiger Benutzername.") });
  o.authMethod ??= await ui.choose("Anmeldung am Server", [{ value: "password", label: "Passwort" }, { value: "key", label: "SSH-Schlüsseldatei" }]);
  if (o.authMethod === "password") o.sshPassword ??= await ui.secret(`Passwort für ${o.sshUser}@${o.host}`, { validate: (v) => (v ? null : "Bitte ein Passwort eingeben.") });
  else {
    o.keyPath ??= await ui.ask("Pfad zur privaten Schlüsseldatei", { validate: (v) => (v ? null : "Pfad fehlt.") });
    o.passphrase ??= (await ui.confirm("Ist der Schlüssel mit einer Passphrase geschützt?", false)) ? await ui.secret("Passphrase") : undefined;
  }
  if (o.sshUser !== "root" && !ui.interactive && o.sudoPassword === undefined && o.authMethod === "password") o.sudoPassword = o.sshPassword; // ohne Terminal: dasselbe Passwort annehmen
  if (o.sshUser !== "root") o.sudoPassword ??= o.authMethod === "password" ? (await ui.confirm(`Ist das sudo-Passwort dasselbe wie das SSH-Passwort?`, true) ? o.sshPassword : await ui.secret("sudo-Passwort")) : await ui.secret("sudo-Passwort (leer, wenn sudo ohne Passwort erlaubt ist)");
  o.mode ??= await ui.choose("Was soll geschehen?", [{ value: "install", label: "Neu installieren" }, { value: "update", label: "Bestehende Installation aktualisieren (Daten bleiben erhalten)" }]);
  if (o.domain === undefined) {
    const d = await ui.ask("Domain für HTTPS (leer = nur HTTP über die IP-Adresse)", { def: "", validate: (v) => (v === "" || isDomain(v) ? null : "Bitte eine gültige Domain in Kleinbuchstaben angeben (z. B. erp.beispiel.at).") });
    o.domain = d;
  }
  if (o.domain && !o.acmeEmail) o.acmeEmail = await ui.ask("E-Mail für Zertifikatsmeldungen (Let's Encrypt)", { validate: (v) => (isEmail(v) ? null : "Ungültige E-Mail-Adresse.") });
  o.enableUfw ??= await ui.confirm(`Firewall (ufw) mit SSH-Port ${o.sshPort}, HTTP und HTTPS aktivieren?`, true);
  if (o.mode === "install") o.admin ??= await askAdmin(ui, {});
  return o;
}

export async function askAdmin(ui, given) {
  const a = { ...given };
  a.orgName ??= await ui.ask("Name Ihrer Organisation/Firma", { validate: (v) => (isText(v) ? null : "Bitte einen Namen eingeben (höchstens 120 Zeichen).") });
  a.name ??= await ui.ask("Ihr Name (erster Benutzer, Inhaber)", { validate: (v) => (isText(v, 100) ? null : "Bitte einen Namen eingeben.") });
  a.email ??= await ui.ask("Ihre E-Mail-Adresse (Anmeldename)", { validate: (v) => (isEmail(v) ? null : "Ungültige E-Mail-Adresse.") });
  if (!a.password) {
    if (await ui.confirm("Soll ein sicheres Passwort erzeugt und einmalig angezeigt werden?", true)) {
      a.password = randomPassword(20);
      ui.line(`\n  Ihr Passwort (bitte jetzt notieren): ${a.password}\n`);
    } else {
      for (;;) {
        const p1 = await ui.secret("Passwort (mindestens 12 Zeichen)", { validate: passwordProblem });
        const p2 = await ui.secret("Passwort wiederholen");
        if (p1 === p2) { a.password = p1; break; }
        ui.line("  → Die Eingaben stimmen nicht überein.");
      }
    }
  }
  return a;
}

export const defaultAppDir = (installerDir) => path.resolve(installerDir, "..");

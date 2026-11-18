# BusinessOS-Installer

Richtet BusinessOS entweder **auf diesem System** oder **auf einem Ubuntu-Server** ein. Ohne Parameter führt der Installer durch alle Fragen.

```text
Windows:       installer\install.cmd
Linux/macOS:   ./installer/install.sh
Überall:       node installer/install.mjs
```

Voraussetzung auf dem Rechner, auf dem der Installer läuft: **Node.js 20.9 oder neuer** und das Programm `tar` (in Windows 10+, macOS und Linux vorhanden).

## Variante 1: Dieses System

Alles Notwendige wird lokal eingerichtet:

1. Voraussetzungen prüfen (Node.js-Version, freie Ports).
2. **Datenbank** wählen:
   * **PostgreSQL in Docker** (empfohlen, wenn Docker vorhanden ist),
   * **eingebettetes PostgreSQL** (ohne Docker; für Test und kleine Einsätze – keine Replikation, keine Wartung durch das System),
   * **vorhandene PostgreSQL** (Adresse wird abgefragt).
3. `.env` mit zufälligen Schlüsseln schreiben (Zugriff nur für den Benutzer).
4. Abhängigkeiten installieren, Datenbank migrieren, Anwendung bauen, Rollen und Rechte anlegen.
5. **Ersten Benutzer** (Inhaber) und Organisation anlegen – Passwort selbst wählen oder erzeugen lassen.
6. Startskripte `start.cmd` / `start.sh` schreiben; optional **Autostart** (Windows: Aufgabenplanung bei Anmeldung, Linux: systemd `--user`).

Starten: `start.cmd` bzw. `./start.sh` (oder `node scripts/run-local.mjs`). Die Anwendung läuft danach unter `http://localhost:3000` (Port wählbar). Strg+C beendet Datenbank (falls eingebettet), Worker und Webserver gemeinsam.

## Variante 2: Ubuntu-Server

Der Installer fragt nach **Server, SSH-Port, Benutzer, Anmeldung (Passwort oder Schlüsseldatei)** und – wenn der Benutzer nicht `root` ist – nach dem **sudo-Passwort**. Dann:

1. Verbindung aufbauen. Der **Fingerabdruck des Server-Schlüssels wird angezeigt und muss bestätigt werden**; erst danach werden Zugangsdaten gesendet.
2. Rechte und System prüfen (Ubuntu 22.04 oder neuer, x86_64/aarch64, systemd, mindestens 4 GB freier Platz).
3. Die Anwendung als Archiv übertragen (ohne Abhängigkeiten, Builds, `.env`).
4. Auf dem Server als root:
   * Pakete: PostgreSQL, nginx, (certbot, ufw); **Node.js 22** aus der NodeSource-Paketquelle (Schlüssel wird mit `signed-by` eingebunden, kein `curl | bash`).
   * Bei weniger als 2 GB Arbeitsspeicher: 2-GB-Auslagerungsdatei für den Build.
   * Systembenutzer `businessos`, Verzeichnis `/opt/businessos` (Versionen unter `releases/`, Verweis `current`), Konfiguration `/etc/businessos/env` (nur root und Dienst).
   * Datenbank und Benutzer mit zufälligem Passwort; PostgreSQL lauscht nur lokal.
   * `npm ci`, Migrationen, Build, **erster Benutzer**.
   * systemd-Dienste `businessos` (Web, nur `127.0.0.1:3000`) und `businessos-worker`, mit Härtung (`NoNewPrivileges`, `ProtectSystem` …).
   * nginx als Reverse Proxy; mit **Domain** zusätzlich ein **Let's-Encrypt-Zertifikat** (Weiterleitung auf HTTPS), ohne Domain läuft die Anwendung über die IP-Adresse **unverschlüsselt**.
   * Optional Firewall (ufw): SSH-Port, 80, 443.
   * **Tägliche Datenbanksicherung** nach `/var/backups/businessos` (14 Tage).
   * Funktionsprüfung (Anmeldeseite muss antworten).
5. Zugangsdaten und Geheimnisse im Staging-Verzeichnis werden überschrieben und gelöscht.

**Aktualisieren:** Installer erneut starten und „Bestehende Installation aktualisieren“ wählen. Daten, Konfiguration und Datenbank bleiben; eine neue Version wird gebaut, migriert und erst nach Erfolg umgeschaltet. Die letzten drei Versionen bleiben für einen Rückschritt liegen (`ln -sfn /opt/businessos/releases/<alt> /opt/businessos/current && systemctl restart businessos businessos-worker`; Datenbankmigrationen sind nicht automatisch umkehrbar – vorher sichern).

**Wiederherstellen einer Sicherung:**

```bash
sudo systemctl stop businessos businessos-worker
gunzip -c /var/backups/businessos/businessos-<Zeit>.sql.gz | sudo -u postgres psql -v ON_ERROR_STOP=1 businessos
sudo systemctl start businessos businessos-worker
```

(Die Datenbank vorher leeren oder neu anlegen.)

## Parameter (für Automatisierung)

```text
--target local|ubuntu     --app-dir <Ordner>     --yes     --dry-run     --help
--admin-email <E-Mail>    --admin-name <Name>    --org-name <Name>
  Passwort des ersten Benutzers: Umgebungsvariable BOS_ADMIN_PASSWORD (nie als Parameter)

local:   --db docker|embedded|external  --db-url <…>  --db-port <Port>  --port <Port>  --autostart  --force
ubuntu:  --host <Name|IP>  --ssh-port <Port>  --ssh-user <Benutzer>  --key <Schlüsseldatei>
         --domain <name>  --acme-email <E-Mail>  --ufw yes|no  --mode install|update
         --accept-fingerprint <SHA256:…>   (Host-Schlüssel nur mit genau diesem Wert akzeptieren)
         Passwörter: BOS_SSH_PASSWORD, BOS_SSH_KEY_PASSPHRASE, BOS_SUDO_PASSWORD
```

`--dry-run` prüft die Eingaben und zeigt, was geschehen würde, ohne etwas zu ändern oder zu verbinden.

## Sicherheit

* Alles, was in Skripte oder Dateien einfließt (Host, Domain, E-Mail, Namen, Ports), wird vorher streng geprüft; das Einrichtungsskript auf dem Server ist **statisch** (keine Werte hineinformatiert), die Werte stehen in einer geprüften Parameterdatei.
* Passwörter erscheinen nie in Befehlszeilen oder Protokollen: SSH-Passwörter gehen an die SSH-Bibliothek, das sudo-Passwort über die Standardeingabe, Datenbank- und Sitzungsschlüssel werden zufällig erzeugt und nur in `/etc/businessos/env` (0640 root:businessos) abgelegt.
* Das Archiv enthält keine `.env`, keine Abhängigkeiten, keine lokalen Daten.

## Grenzen (ehrlich)

* Nur **Ubuntu 22.04+** als Server; andere Linux-Distributionen oder Windows-Server werden nicht unterstützt.
* Das Einrichtungsskript baut die Anwendung **auf dem Server** (Internetzugang für `npm` und Paketquellen nötig, Build braucht Zeit und Arbeitsspeicher).
* Der Ubuntu-Ablauf wurde **vollständig auf Ubuntu 24.04 (WSL2, ohne Domain, ohne Firewall) durchlaufen**: Neuinstallation und Aktualisierung, danach Anmeldung und Seitenaufrufe über nginx. **Nicht erprobt:** Ubuntu 22.04, ein Server im Internet mit Domain und Let's-Encrypt-Zertifikat, die Firewall-Option, Anmeldung per Schlüsseldatei. Bitte zuerst auf einem Testserver ausprobieren.
* Kein Hochverfügbarkeits-Betrieb, kein verwalteter Datenbank-Cluster, keine automatischen Betriebssystem-Updates, keine Überwachung. Sicherungen liegen auf demselben Server – bitte zusätzlich extern sichern.
* Das eingebettete PostgreSQL der lokalen Variante ist für Test und kleine Einsätze gedacht.

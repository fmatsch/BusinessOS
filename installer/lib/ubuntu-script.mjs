// Erzeugt die Dateien, die auf den Ubuntu-Server übertragen werden. Das Einrichtungsskript selbst ist statisch (nichts wird hineinformatiert);
// alle Werte stehen in `params` (geprüft, in Hochkommas), die Konfigurationsdateien werden hier gerendert und vom Skript nur installiert.
import { isDomain, isEmail, isPort, shq } from "./validate.mjs";

export const NODE_MAJOR = 22;
export const APP_PORT = 3000;

/** Parameterdatei für das Skript (wird mit `. params` eingelesen). */
export function renderParams({ mode, release, domain = "", acmeEmail = "", sshPort, enableUfw, appPort = APP_PORT }) {
  if (!["install", "update"].includes(mode)) throw new Error("Ungültiger Modus");
  if (!/^\d{14}$/.test(release)) throw new Error("Ungültige Release-Kennung");
  if (domain && !isDomain(domain)) throw new Error("Ungültige Domain");
  if (acmeEmail && !isEmail(acmeEmail)) throw new Error("Ungültige E-Mail-Adresse");
  if (domain && !acmeEmail) throw new Error("Für ein Zertifikat wird eine E-Mail-Adresse benötigt");
  if (!isPort(sshPort) || !isPort(appPort)) throw new Error("Ungültiger Port");
  return [
    `MODE=${shq(mode)}`, `RELEASE=${shq(release)}`, `DOMAIN=${shq(domain)}`, `ACME_EMAIL=${shq(acmeEmail)}`,
    `SSH_PORT=${shq(sshPort)}`, `ENABLE_UFW=${shq(enableUfw ? "yes" : "no")}`, `APP_PORT=${shq(appPort)}`, `NODE_MAJOR=${shq(NODE_MAJOR)}`,
  ].join("\n") + "\n";
}

/** Zugangsdaten des ersten Inhabers (nur Installation); als Shell-Datei mit sicher maskierten Werten. */
export function renderAdminEnv({ email, name, password, orgName }) {
  return [`ADMIN_EMAIL=${shq(email)}`, `ADMIN_NAME=${shq(name)}`, `ADMIN_PASSWORD=${shq(password)}`, `ORG_NAME=${shq(orgName)}`].join("\n") + "\n";
}

const HARDEN = [
  "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=full", "ProtectHome=true", "ProtectKernelTunables=true", "ProtectControlGroups=true",
  "RestrictSUIDSGID=true", "LockPersonality=true",
].join("\n");

export function renderWebUnit(appPort = APP_PORT) {
  if (!isPort(appPort)) throw new Error("Ungültiger Port");
  return `[Unit]
Description=BusinessOS (Webanwendung)
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=businessos
Group=businessos
WorkingDirectory=/opt/businessos/current
EnvironmentFile=/etc/businessos/env
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p ${appPort} -H 127.0.0.1
Restart=always
RestartSec=3
${HARDEN}

[Install]
WantedBy=multi-user.target
`;
}

export function renderWorkerUnit() {
  return `[Unit]
Description=BusinessOS (Hintergrund-Worker: Ereignisse, Benachrichtigungen, Workflows)
After=network-online.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=businessos
Group=businessos
WorkingDirectory=/opt/businessos/current
EnvironmentFile=/etc/businessos/env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node node_modules/tsx/dist/cli.mjs scripts/worker.ts
Restart=always
RestartSec=5
${HARDEN}

[Install]
WantedBy=multi-user.target
`;
}

/** Tägliche Datenbanksicherung (pg_dump, 14 Tage aufbewahrt, nur für root lesbar). */
export function renderBackupScript() {
  return `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
dest=/var/backups/businessos
mkdir -p "$dest"
set -a; . /etc/businessos/env; set +a
file="$dest/businessos-$(date +%Y%m%d-%H%M%S).sql.gz"
PGPASSWORD="$DB_PASSWORD" pg_dump -h 127.0.0.1 -U "$DB_USER" "$DB_NAME" | gzip -9 > "$file"
find "$dest" -name 'businessos-*.sql.gz' -mtime +14 -delete
echo "Sicherung: $file"
`;
}

export const BACKUP_SERVICE = `[Unit]
Description=BusinessOS Datenbanksicherung

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/businessos-backup
`;

export const BACKUP_TIMER = `[Unit]
Description=BusinessOS Datenbanksicherung täglich

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
`;

/** nginx als Reverse Proxy. Mit Domain: eigener Server-Block (Zertifikat danach per certbot); ohne Domain: Standardserver für die IP-Adresse. */
export function renderNginx({ domain = "", appPort = APP_PORT } = {}) {
  if (domain && !isDomain(domain)) throw new Error("Ungültige Domain");
  if (!isPort(appPort)) throw new Error("Ungültiger Port");
  return `server {
    listen 80${domain ? "" : " default_server"};
    listen [::]:80${domain ? "" : " default_server"};
    server_name ${domain || "_"};

    client_max_body_size 12m;   # Belege und Kontoauszüge (Anwendung begrenzt auf 10 MB)
    server_tokens off;

    location / {
        proxy_pass http://127.0.0.1:${appPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
`;
}

/** Statisches Einrichtungsskript (läuft als root auf dem Server). Erwartet das Staging-Verzeichnis als erstes Argument. */
export const PROVISION_SH = String.raw`#!/usr/bin/env bash
# BusinessOS – Einrichtung auf Ubuntu (22.04/24.04). Läuft als root. Wiederholbar: MODE=update spielt nur eine neue Version ein.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
STAGE="\${1:?Staging-Verzeichnis fehlt}"
APP=/opt/businessos
ENVF=/etc/businessos/env
SVC=businessos

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
trap 'printf "FEHLER in Zeile %s (Befehl: %s)\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

[ "$(id -u)" -eq 0 ] || die "Das Skript muss als root laufen."
# shellcheck disable=SC1090
. "$STAGE/params"

log "Voraussetzungen prüfen"
. /etc/os-release
[ "\${ID:-}" = "ubuntu" ] || die "Nur Ubuntu wird unterstützt (gefunden: \${PRETTY_NAME:-unbekannt})."
case "\${VERSION_ID%%.*}" in 22|24|26) ;; *) die "Ubuntu 22.04 oder neuer erforderlich (gefunden: $VERSION_ID).";; esac
case "$(uname -m)" in x86_64|aarch64) ;; *) die "Nicht unterstützte Architektur: $(uname -m)";; esac
[ -d /run/systemd/system ] || die "systemd wird benötigt."
free_kb=$(df -Pk /opt | awk 'NR==2{print $4}')
[ "$free_kb" -gt 4000000 ] || die "Zu wenig freier Speicher in /opt (mindestens 4 GB)."
mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)

log "Pakete installieren"
apt-get update -y
apt-get install -y ca-certificates curl gnupg tar gzip postgresql nginx
[ -z "$DOMAIN" ] || apt-get install -y certbot python3-certbot-nginx
[ "$ENABLE_UFW" != "yes" ] || apt-get install -y ufw

need_node=yes
if command -v node >/dev/null 2>&1; then
  cur=$(node -p 'process.versions.node.split(".")[0]')
  [ "$cur" -ge 20 ] && need_node=no
fi
if [ "$need_node" = yes ]; then
  log "Node.js $NODE_MAJOR installieren (Paketquelle von NodeSource, Schlüssel wird geprüft eingebunden)"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 oder neuer konnte nicht eingerichtet werden."

# Der Build braucht ca. 2 GB Arbeitsspeicher; bei weniger ohne Swap wird eine Auslagerungsdatei angelegt.
if [ "$mem_kb" -lt 2000000 ] && [ "$(swapon --noheadings | wc -l)" -eq 0 ] && [ ! -e /swapfile ]; then
  log "Wenig Arbeitsspeicher: 2-GB-Auslagerungsdatei anlegen"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Systembenutzer und Verzeichnisse"
id "$SVC" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/$SVC --create-home --shell /usr/sbin/nologin "$SVC"
install -d -m 0755 "$APP" "$APP/releases"
install -d -m 0750 -o root -g "$SVC" /etc/businessos
install -d -m 0750 -o "$SVC" -g "$SVC" /var/lib/$SVC

if [ "$MODE" = install ]; then
  if [ -e "$ENVF" ] && [ -e "$APP/current" ]; then die "Es gibt bereits eine Installation ($ENVF). Zum Aktualisieren den Modus „Aktualisieren“ wählen."; fi
  if [ -e "$ENVF" ]; then
    warn "Unfertige frühere Installation gefunden – die vorhandene Konfiguration wird weiterverwendet."
  else
    log "Konfiguration schreiben"
    install -m 0640 -o root -g "$SVC" "$STAGE/env" "$ENVF"
  fi
else
  [ -e "$ENVF" ] || die "Keine bestehende Installation gefunden ($ENVF) – bitte neu installieren."
fi
set -a; . "$ENVF"; set +a

if [ "$MODE" = install ]; then
  log "PostgreSQL-Datenbank anlegen"
  systemctl enable --now postgresql
  pg() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; }
  [ "$(pg -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")" = 1 ] || pg -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'"
  [ "$(pg -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" = 1 ] || pg -c "CREATE DATABASE $DB_NAME OWNER $DB_USER ENCODING 'UTF8' TEMPLATE template0"
fi

log "Anwendung einspielen (Release $RELEASE)"
REL="$APP/releases/$RELEASE"
mkdir -p "$REL"
tar -xzf "$STAGE/app.tar.gz" -C "$REL"
chown -R "$SVC:$SVC" "$REL"
as_svc() { runuser -u "$SVC" -- env HOME=/var/lib/$SVC NEXT_TELEMETRY_DISABLED=1 bash -c "cd '$REL' && set -a && . '$ENVF' && set +a && $*"; }
as_svc 'npm ci --include=dev --no-audit --no-fund'
as_svc 'npx prisma generate'
as_svc 'npx prisma migrate deploy'
as_svc 'npx tsx scripts/sync-roles.ts'
as_svc 'NODE_ENV=production npm run build'

if [ "$MODE" = install ]; then
  log "Ersten Benutzer anlegen"
  adm=$(mktemp /run/bos-admin.XXXXXX)
  install -m 0640 -o root -g "$SVC" "$STAGE/admin.env" "$adm"
  as_svc "set -a; . '$adm'; set +a; npx tsx scripts/create-admin.ts" || { rm -f "$adm"; die "Benutzer konnte nicht angelegt werden."; }
  rm -f "$adm"
fi

log "Dienste einrichten"
ln -sfn "$REL" "$APP/current"
install -m 0644 "$STAGE/businessos.service" /etc/systemd/system/businessos.service
install -m 0644 "$STAGE/businessos-worker.service" /etc/systemd/system/businessos-worker.service
install -m 0750 "$STAGE/businessos-backup" /usr/local/sbin/businessos-backup
install -m 0644 "$STAGE/businessos-backup.service" /etc/systemd/system/businessos-backup.service
install -m 0644 "$STAGE/businessos-backup.timer" /etc/systemd/system/businessos-backup.timer
systemctl daemon-reload
systemctl enable businessos businessos-worker businessos-backup.timer
systemctl restart businessos businessos-worker
systemctl start businessos-backup.timer

log "Webserver (nginx) einrichten"
install -m 0644 "$STAGE/nginx.conf" /etc/nginx/sites-available/businessos
ln -sfn /etc/nginx/sites-available/businessos /etc/nginx/sites-enabled/businessos
[ -n "$DOMAIN" ] || rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

if [ -n "$DOMAIN" ] && [ "$MODE" = install ]; then
  log "TLS-Zertifikat (Let's Encrypt) für $DOMAIN"
  if certbot --nginx -d "$DOMAIN" -m "$ACME_EMAIL" --agree-tos --no-eff-email --non-interactive --redirect; then
    sed -i "s#^AUTH_URL=.*#AUTH_URL=https://$DOMAIN#" "$ENVF"
    systemctl restart businessos
  else
    warn "Das Zertifikat konnte nicht ausgestellt werden (zeigt der DNS-Eintrag von $DOMAIN auf diesen Server? Ports 80/443 offen?). Die Anwendung läuft vorerst ohne TLS auf http://$DOMAIN."
  fi
fi

if [ "$ENABLE_UFW" = yes ]; then
  log "Firewall (ufw): SSH $SSH_PORT, HTTP, HTTPS"
  ufw allow "$SSH_PORT"/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

log "Funktionsprüfung"
ok=no
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$APP_PORT/login"; then ok=yes; break; fi
  sleep 1
done
if [ "$ok" != yes ]; then
  journalctl -u businessos -n 40 --no-pager >&2 || true
  die "Die Anwendung antwortet nicht. Protokoll: journalctl -u businessos"
fi

# alte Releases aufräumen (die letzten 3 bleiben für einen Rückschritt)
ls -1dt "$APP"/releases/* | tail -n +4 | xargs -r rm -rf

log "Fertig"
echo "RESULT_OK"
`.replace(/\\\$\{/g, "${");

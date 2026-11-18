#!/usr/bin/env sh
# BusinessOS-Installer (Linux/macOS)
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js wurde nicht gefunden. Bitte Node.js 20.9 oder neuer installieren: https://nodejs.org" >&2
  exit 1
fi
exec node "$(dirname "$0")/install.mjs" "$@"

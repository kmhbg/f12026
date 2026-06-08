#!/usr/bin/env bash
# Säker uppdatering av produktion (homelab / proxmox2) – behåller data/bets.json
#
# Cache: OpenF1 replay-data sparas i data/cache/sessions/ på värddisken
# (samma sökväg som CACHE_DIR=data/cache i server.js). Vid Docker-deploy på
# proxmox2, se docker-compose.yml med bind mount ./data/cache:/app/data/cache.
#
# OpenF1 MQTT: sätt i systemd drop-in eller /etc/environment (ej i git):
#   OPENF1_USERNAME=din@email.com
#   OPENF1_PASSWORD=ditt_openf1_lösenord
# Se lib/openf1-mqtt-config.js och openf1.org/auth.html.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/f1-betting-2026}"
SERVICE_NAME="${SERVICE_NAME:-f1-betting}"

cd "$APP_DIR"

BACKUP_FILE="$APP_DIR/data/.bets.json.backup"
mkdir -p data

if [ -f data/bets.json ]; then
  cp data/bets.json "$BACKUP_FILE"
  cp data/bets.json "data/.bets.json.backup.$(date +%Y%m%d%H%M%S)"
  echo "Backup: $BACKUP_FILE"
fi

git fetch origin
git checkout main
# Rensa lokala ändringar (t.ex. node_modules) så pull/reset inte blockeras
git reset --hard origin/main

if [ -f "$BACKUP_FILE" ]; then
  cp "$BACKUP_FILE" data/bets.json
  echo "Återställde data/bets.json från backup"
fi

# Persistent replay-cache (OpenF1) – skrivs av www-data via systemd
mkdir -p data/cache/sessions
if command -v chown &>/dev/null && id www-data &>/dev/null; then
  chown -R www-data:www-data data/cache 2>/dev/null || sudo chown -R www-data:www-data data/cache || true
fi

npm ci --omit=dev 2>/dev/null || npm install --omit=dev

if systemctl is-active --quiet "$SERVICE_NAME"; then
  sudo systemctl restart "$SERVICE_NAME"
  echo "Tjänst $SERVICE_NAME omstartad."
else
  echo "Varning: systemd-tjänst $SERVICE_NAME hittades inte – starta appen manuellt."
fi

echo "Klart. Verifiera: curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/"

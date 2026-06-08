#!/usr/bin/env bash
# Säker uppdatering av produktion (homelab) – behåller data/bets.json
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/f1-betting-2026}"
SERVICE_NAME="${SERVICE_NAME:-f1-betting}"

cd "$APP_DIR"

if [ -f data/bets.json ]; then
  cp data/bets.json "/tmp/bets.json.backup.$(date +%Y%m%d%H%M%S)"
  cp data/bets.json /tmp/bets.json.backup
  echo "Backup: /tmp/bets.json.backup"
fi

git fetch origin
git checkout main
git pull --ff-only origin main

if [ -f /tmp/bets.json.backup ]; then
  mkdir -p data
  cp /tmp/bets.json.backup data/bets.json
  echo "Återställde data/bets.json från backup"
fi

npm ci --omit=dev 2>/dev/null || npm install --omit=dev

if systemctl is-active --quiet "$SERVICE_NAME"; then
  sudo systemctl restart "$SERVICE_NAME"
  echo "Tjänst $SERVICE_NAME omstartad."
else
  echo "Varning: systemd-tjänst $SERVICE_NAME hittades inte – starta appen manuellt."
fi

echo "Klart. Verifiera: curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/"

#!/usr/bin/env bash
# F1 Betting 2026 – installationsskript för Proxmox/Caddy-miljö
# Kör detta på servern (t.ex. i /var/www/f1-betting-2026 efter att du kopierat dit filerna).

set -e

APP_DIR="${APP_DIR:-/var/www/f1-betting-2026}"
CADDY_USER="${CADDY_USER:-www-data}"
SERVICE_NAME="f1-betting"

echo "=== F1 Betting 2026 – Installerar i $APP_DIR ==="

# Om skriptet körs inifrån app-katalogen (t.ex. efter git clone)
if [ -f "package.json" ] && [ -f "server.js" ]; then
  INSTALL_DIR="$(pwd)"
else
  INSTALL_DIR="$APP_DIR"
  if [ ! -d "$INSTALL_DIR" ] || [ ! -f "$INSTALL_DIR/package.json" ]; then
    echo "Fel: Hittar inte package.json i $INSTALL_DIR. Klona/kopiera först appen dit."
    exit 1
  fi
  cd "$INSTALL_DIR"
fi

# Node.js
if ! command -v node &>/dev/null; then
  echo "Node.js saknas. Installera t.ex.: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

# npm install
echo "Installerar npm-beroenden..."
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Säkerställ data-katalog och rättigheter
mkdir -p data
touch data/bets.json
chown -R "$CADDY_USER:$CADDY_USER" "$INSTALL_DIR" 2>/dev/null || true

# Systemd – kopiera service-fil om den finns
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
if [ -f "$SCRIPT_DIR/f1-betting.service" ]; then
  # Uppdatera WorkingDirectory i service-filen
  sed "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" "$SCRIPT_DIR/f1-betting.service" > /tmp/f1-betting.service
  sudo cp /tmp/f1-betting.service /etc/systemd/system/f1-betting.service
  sudo systemctl daemon-reload
  sudo systemctl enable f1-betting
  sudo systemctl restart f1-betting
  echo "Systemd-tjänst 'f1-betting' aktiverad och startad."
else
  echo "Kör appen manuellt: cd $INSTALL_DIR && node server.js"
fi

# Caddy
if command -v caddy &>/dev/null; then
  echo "Caddy är installerat. Lägg till reverse proxy manuellt eller använd deploy/Caddyfile."
  echo "Exempel: sudo cp $SCRIPT_DIR/Caddyfile /etc/caddy/Caddyfile (justera domän) och sudo systemctl reload caddy"
else
  echo "Caddy hittades inte. Installera Caddy och konfigurera enligt deploy/Caddyfile."
fi

echo ""
echo "=== Klart. Appen lyssnar på port 3000. Öppna via Caddy (t.ex. http://din-server) ==="

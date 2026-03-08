#!/usr/bin/env bash
# F1 Betting 2026 – installationsskript för Proxmox/Caddy-miljö
# Kör detta på servern. Skriptet:
# 1) Säkerställer att git och Node finns
# 2) Klonar/uppdaterar projektet från GitHub
# 3) Installerar npm-beroenden
# 4) Sätter upp systemd-tjänst
# 5) Uppdaterar Caddys konfiguration automatiskt

set -e

APP_DIR="${APP_DIR:-/var/www/f1-betting-2026}"
CADDY_USER="${CADDY_USER:-www-data}"
SERVICE_NAME="f1-betting"
# Sätt till din riktiga GitHub-URL för projektet:
GIT_URL="${GIT_URL:-https://github.com/kmhbg/f1-betting-2026.git}"

echo "=== F1 Betting 2026 – Installerar i $APP_DIR ==="

# Säkerställ att git är installerat
if ! command -v git &>/dev/null; then
  echo "git saknas – försöker installera (apt)..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update
    sudo apt-get install -y git
  else
    echo "Kunde inte installera git automatiskt (apt-get saknas). Installera git manuellt och kör skriptet igen."
    exit 1
  fi
fi

# Säkerställ att Node.js finns
if ! command -v node &>/dev/null; then
  echo "Node.js saknas. Installera t.ex.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi

# Klona eller uppdatera från GitHub
if [ -d "$APP_DIR/.git" ]; then
  echo "Hittade befintligt git-repo i $APP_DIR – hämtar senaste från GitHub..."
  cd "$APP_DIR"
  # Backup av data/bets.json innan pull för att behålla lokala data
  if [ -f "data/bets.json" ]; then
    cp "data/bets.json" "/tmp/bets.json.backup"
  fi
  git fetch origin || echo "Varning: git fetch misslyckades, kontrollera manuellt."
  git pull --ff-only origin main || echo "Varning: git pull misslyckades, kontrollera manuellt."
  if [ -f "/tmp/bets.json.backup" ]; then
    mkdir -p data
    cp "/tmp/bets.json.backup" "data/bets.json"
    rm -f "/tmp/bets.json.backup"
  fi
else
  echo "Klonar projektet från $GIT_URL till $APP_DIR ..."
  sudo mkdir -p "$APP_DIR"
  sudo chown "$(whoami)":"$(whoami)" "$APP_DIR"
  git clone "$GIT_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

INSTALL_DIR="$(pwd)"

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
  echo "Caddy hittades – försöker uppdatera /etc/caddy/Caddyfile automatiskt..."
  if [ -f "$SCRIPT_DIR/Caddyfile" ]; then
    # Lägg till vår konfiguration om den inte redan finns (markerad med kommentar)
    if [ -f /etc/caddy/Caddyfile ]; then
      if ! grep -q "F1 Betting 2026 – Caddy reverse proxy" /etc/caddy/Caddyfile; then
        echo "Lägger till F1 Betting-block i /etc/caddy/Caddyfile ..."
        echo "" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
        echo "# F1 Betting 2026 – autoimport" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
        sudo tee -a /etc/caddy/Caddyfile >/dev/null < "$SCRIPT_DIR/Caddyfile"
      else
        echo "Caddyfile verkar redan innehålla F1 Betting-konfiguration."
      fi
    else
      echo "Ingen /etc/caddy/Caddyfile hittades – kopierar vår som bas."
      sudo cp "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile
    fi

    echo "Laddar om Caddy..."
    sudo systemctl reload caddy || echo "Varning: kunde inte reloada Caddy – kontrollera konfigurationen."
  else
    echo "deploy/Caddyfile hittades inte, hoppar över Caddy-konfiguration."
  fi
else
  echo "Caddy hittades inte. Installera Caddy och konfigurera enligt deploy/Caddyfile."
fi

echo ""
echo "=== Klart. Appen lyssnar på port 3000. Öppna via Caddy (t.ex. http://din-server) ==="

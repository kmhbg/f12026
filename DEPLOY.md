# Deployment – F1 Betting 2026 på Proxmox med Caddy

Appen består av en **Node.js/Express-server** som måste köras. **Caddy** används som reverse proxy framför den (HTTPS, domän, etc.).

## Översikt

1. **Node-appen** kör på port 3000 (kan ändras med miljövariabeln `PORT`).
2. **Caddy** lyssnar på 80/443 och skickar trafik till `localhost:3000`.
3. **systemd** håller Node-appen igång och startar den vid omstart.

---

## Snabbinstallation på servern

### 1. Kopiera appen till servern

Till exempel med git (på servern):

```bash
sudo mkdir -p /var/www
sudo git clone https://github.com/DIN-USER/f1-betting-2026.git /var/www/f1-betting-2026
cd /var/www/f1-betting-2026
```

Eller kopiera hela projektmappen med `scp`/rsync från din dator till `/var/www/f1-betting-2026`.

### 2. Kör installationsskriptet

```bash
cd /var/www/f1-betting-2026
chmod +x deploy/deploy.sh
sudo ./deploy/deploy.sh
```

Skriptet:

- Kör `npm ci` / `npm install`
- Skapar `data/` och säkerställer `data/bets.json`
- Installerar och startar **systemd-tjänsten** `f1-betting`
- Påminner om att konfigurera Caddy

### 3. Konfigurera Caddy

**Alternativ A – Använd medföljande Caddyfile (lyssna på port 80)**

```bash
# Redigera om du vill använda en specifik domän istället för :80
sudo nano deploy/Caddyfile
# Kopiera in i Caddys konfiguration, t.ex.:
sudo cp /var/www/f1-betting-2026/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Alternativ B – Egen domän med HTTPS (Caddy fixar certifikat)**

Lägg till i din befintliga Caddy-konfiguration (t.ex. `/etc/caddy/Caddyfile`):

```caddy
f1bet.dindomain.se {
    reverse_proxy localhost:3000
}
```

Sedan:

```bash
sudo systemctl reload caddy
```

**Alternativ C – Inkludera fil från deploy-mappen**

I Caddyfile:

```caddy
import /var/www/f1-betting-2026/deploy/Caddyfile
```

(Justera sökväg och innehåll i `deploy/Caddyfile` så att det passar din domän/port.)

---

## Manuella steg (utan deploy.sh)

### Node och npm

```bash
cd /var/www/f1-betting-2026
npm ci --omit=dev
mkdir -p data
# Starta en gång: node server.js
```

### Systemd (valfritt)

```bash
sudo cp deploy/f1-betting.service /etc/systemd/system/
# Redigera WorkingDirectory om du inte använder /var/www/f1-betting-2026
sudo systemctl daemon-reload
sudo systemctl enable f1-betting
sudo systemctl start f1-betting
```

### Caddy

Lägg till en `reverse_proxy`-block som pekar på `localhost:3000` (se exempel ovan).

---

## Kontroll

- **Appen:** `curl -s http://localhost:3000/api/health` → `{"ok":true}` (om du har en sådan route) eller `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` → 200.
- **Via Caddy:** Öppna `http://din-server` eller `https://f1bet.dindomain.se` i webbläsaren.
- **Admin:** `https://din-domain/admin.html`
- **Loggar:** `sudo journalctl -u f1-betting -f`

---

## Uppdatera appen

```bash
cd /var/www/f1-betting-2026
git pull   # om du använder git
npm ci --omit=dev
sudo systemctl restart f1-betting
```

Caddy behöver normalt inte startas om vid app-uppdateringar.

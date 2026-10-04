# F1 Betting

Självhostad F1-betting för kompisgänget. Varje installation är ett eget gäng.

- **Racebets:** gissa topp 3 inför varje race. Betten låses vid start, och de andras bets syns först då.
- **Säsongsbets:** förar- och konstruktörsmästerskapet.
- **Rättning och pott:** vinnarna delar racets insatser. Utan vinnare går insatserna till potten.
- **Pit Wall:** live-tidtagning och replay via [OpenF1](https://openf1.org).
- **Inloggning:** användarnamn och lösenord. Admin bjuder in med engångslänkar.

Data lagras i SQLite med automatisk daglig backup.

## Kom igång (Docker)

```bash
git clone https://github.com/kmhbg/f12026.git f1-betting
cd f1-betting
cp .env.example .env        # ändra minst PUBLIC_URL och SEASON_YEAR
docker compose up -d
```

Öppna `http://<din-server>:3000`. Första gången skapar du admin-kontot. Därefter bjuder du in resten av gänget under **Admin → Hantera bettare**. Varje ny bettare får en engångslänk där de väljer sitt lösenord.

Uppdatera till senaste versionen:

```bash
./deploy/update.sh
```

### HTTPS

Kör appen bakom en reverse proxy med HTTPS, till exempel Caddy (se `deploy/Caddyfile.example`), nginx eller Nginx Proxy Manager. Sätt `TRUST_PROXY=true` i `.env`, så att inloggningscookien markeras `Secure`.

### Utan Docker

Kräver Node 20 eller senare.

```bash
npm ci --omit=dev
DATA_DIR=./data node server.js
```

## Konfiguration (`.env`)

| Variabel | Standard | Beskrivning |
|---|---|---|
| `APP_NAME` | F1 Betting | Namn som visas i appen |
| `SEASON_YEAR` | innevarande år | Säsong som bettas |
| `STAKE_PER_BET` | 50 | Insats per racebet |
| `PUBLIC_URL` | – | Publik adress som används i inbjudningslänkar |
| `TRUST_PROXY` | – | `true` bakom en reverse proxy med HTTPS |
| `CORS_ORIGINS` | – | Origins som får anropa API:et med cookies, till exempel mobilappar |
| `F1_IMPORT_TOKEN` | – | Slår på importen `POST /api/bets/race/:race/:user/import` (header `X-Import-Token`) |
| `OPENF1_USERNAME` / `OPENF1_PASSWORD` | – | OpenF1-konto för livedata under pågående pass |

## Administration från kommandoraden

```bash
docker compose exec f1-betting node scripts/admin.js list
docker compose exec f1-betting node scripts/admin.js invite <användare>   # ny lösenordslänk
docker compose exec f1-betting node scripts/admin.js role <användare> admin
```

**Flytta från den gamla `bets.json`:**

```bash
docker compose cp bets.json f1-betting:/data/bets.json
docker compose exec f1-betting node scripts/migrate-json-to-sqlite.js /data/bets.json --admin <ditt-id>
```

Användarna får inga lösenord vid flytten. Skapa en inbjudningslänk till var och en med `admin.js invite`.

## Utveckling

```bash
npm install
npm test
DATA_DIR=./data node server.js
```

## English (short)

Self-hosted F1 podium betting for a group of friends: one group per instance, username/password login, and SQLite storage. To get started, run `cp .env.example .env && docker compose up -d`, then open port 3000 and create the admin account. The mobile apps (Capacitor) are not yet updated for login.

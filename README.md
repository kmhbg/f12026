# F1 Betting

Självhostad F1-betting för en grupp – kompisgänget, jobbet eller klubben. Varje installation är en egen grupp.

- **Racebets:** gissa topp 3 inför varje race. Betten låses vid start, och de andras bets syns först då.
- **Säsongsbets:** förar- och konstruktörsmästerskapet.
- **Rättning och pott:** vinnarna delar racets insatser. Utan vinnare går insatserna till potten.
- **Topplista:** poäng per race (rätt förare på rätt plats, rätt förare på fel plats, bonus för exakt topp 3), saldo i kr, poäng per race och en trendgraf. Admin ställer in poängen.
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

Öppna `http://<din-server>:3000`. Så länge appen saknar admin skickas alla till registreringssidan (`/setup.html`), och den som registrerar sig där blir admin. Därefter bjuder du in resten av gruppen under **Admin → Hantera bettare**. Varje ny bettare får en engångslänk där de väljer sitt lösenord.

Ligger appen öppen mot internet redan innan du har registrerat dig, sätt `SETUP_TOKEN` i `.env`. Registreringen kräver då koden, så att ingen annan hinner bli admin först.

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
| `APP_NAME` | F1tting | Namn som visas i appen |
| `SEASON_YEAR` | innevarande år | Säsong som bettas |
| `STAKE_PER_BET` | 50 | Insats per racebet |
| `SETUP_TOKEN` | – | Om den är satt krävs koden för att registrera den första admin |
| `CACHE_RACE_COUNT` | 2 | Antal senaste race vars replay-data cachas. Äldre rensas automatiskt, utom pinnade (Admin → Replay-cache) och sådant som använts senaste dygnet |
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
docker compose exec f1-betting node scripts/admin.js create-admin <användarnamn> "<Namn>"   # ny admin om du låst ute dig
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

Self-hosted F1 podium betting for any group: one group per instance, username/password login, and SQLite storage. To get started, run `cp .env.example .env && docker compose up -d`, then open port 3000 and register the admin account (set `SETUP_TOKEN` to protect registration on a public host). The mobile apps (Capacitor) are not yet updated for login.

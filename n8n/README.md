# F1 Podiumprediktion (n8n + OpenF1)

Importbart n8n-workflow som hämtar data från [OpenF1](https://api.openf1.org) och föreslår P1, P2 och P3 inför kommande race baserat på kval och träning.

## Importera i n8n

1. Öppna din n8n-instans.
2. Gå till **Settings** (kugghjul) → **Import workflow**, eller klicka **+** → **Import from file**.
3. Välj filen `f1-podium-prediction.json` från denna mapp.
4. Spara och **aktivera** workflowet om du vill att schemaläggaren och webhook ska fungera.

## Testa manuellt

1. Öppna workflowet i n8n.
2. Klicka på noden **Manual Trigger** → **Execute workflow**.
3. Inspektera utdata från **Format Swedish Message** – fältet `message` innehåller en svensk sammanfattning.

### Lokal test (utan n8n)

```bash
node n8n/test-prediction.js          # Monaco 2026 (meeting_key 1286)
node n8n/test-prediction.js 1287       # annan helg
```

**Verifierat exempel – Monaco GP 2026:**

| Plats | Förare        | Kval |
|-------|---------------|------|
| P1    | Kimi Antonelli | P1  |
| P2    | Lewis Hamilton | P3  |
| P3    | Max Verstappen | P2  |

Piastri hamnar längre ner i rankingen (starkare kval än träning väger tyngst).

## Schemaläggning

Noden **Schedule Trigger** kör workflowet **lördag och söndag kl. 09:00** (`0 9 * * 6,0`). Justera cron-uttrycket efter din tidszon i n8n.

## Webhook (valfritt API-anrop)

Aktivera workflowet och anropa:

```bash
curl -X POST 'https://DIN-N8N/webhook/f1-podium-prediction' \
  -H 'Content-Type: application/json' \
  -d '{"meeting_key": 1286}'
```

Utelämna `meeting_key` för automatisk val av kommande race.

## Lägg till notifiering

Koppla en nod **efter** **Format Swedish Message**:

| Kanal    | Nod i n8n   | Fält att mappa |
|----------|-------------|----------------|
| Slack    | Slack       | `{{ $json.message }}` |
| E-post   | Send Email  | Brödtext: `{{ $json.message }}` |
| Telegram | Telegram    | Text: `{{ $json.message }}` |

Se också sticky note i workflowet.

## Prediktionslogik

Workflowet väljer racehelg i denna ordning:

1. Nästa **Race** med `date_start > now` (säsong 2026, ej inställd).
2. Annars senaste helg där **Qualifying** är klar men racet inte startat.
3. Annars senaste avslutade helg (demo/fallback).

Poäng (lägre = bättre):

| Datakälla | Vikt |
|-----------|------|
| Kvalposition | × 50 |
| FP3 snabbaste varv-rank | × 15 |
| FP2 snabbaste varv-rank | × 10 |
| FP1 snabbaste varv-rank | × 5 |

Om kval saknas normaliseras träningsvikterna så totalvikten motsvarar hela modellen.

## OpenF1 och rate limits

- API: [https://api.openf1.org](https://api.openf1.org) – ingen nyckel krävs för grundläggande REST.
- Workflowet gör ~6 anrop per körning med **350 ms paus** mellan varje anrop.
- Vid HTTP 429 (rate limit): vänta en stund och kör igen. Kör inte workflowet oftare än nödvändigt.
- Dokumentation: [github.com/br-g/openf1](https://github.com/br-g/openf1)

## F1tting-integration (valfritt)

Vill du skicka prediktionen till F1tting-bettingappen kan du lägga till en **HTTP Request**-nod efter formateringen:

```http
POST https://din-f1tting-server/api/...
Content-Type: application/json

{{ JSON.stringify({ podium: $json.podium, meeting_key: $json.meeting_key }) }}
```

Anpassa URL och autentisering efter din server.

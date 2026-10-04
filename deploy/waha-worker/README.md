# WAHA-worker för F1-betting

En egen WAHA-instans (`WAHA_WORKER_ID=waha-f1`) som bara läser F1-gruppen i
WhatsApp. n8n-flödet **F1 – bets från WhatsApp** hämtar meddelandena härifrån
och sparar saknade bets i f1.palsk.com. Workern skickar inga webhooks och
skriver inget i chatten.

## Installera (på waha-korv, VM 102)

```bash
mkdir -p /opt/waha-f1 && cd /opt/waha-f1
# kopiera docker-compose.yml hit, skapa sedan .env (lämna aldrig ut värdena):
#   WAHA_API_KEY=<ny slumpad nyckel, t.ex. openssl rand -hex 32>
#   WAHA_DASHBOARD_PASSWORD=<lösenord>
chmod 600 .env
docker compose up -d
```

## Koppla WhatsApp

1. Öppna `http://172.16.16.66:3001/dashboard` och logga in.
2. Skapa sessionen `f1` (engine GOWS) och skanna QR-koden med telefonen
   (WhatsApp → Länkade enheter). Den blir en extra länkad enhet; korv-sessionen
   påverkas inte.

## Byt n8n-flödet till workern

I noden **Inställningar** i flödet:

- `wahaUrl` → `http://172.16.16.66:3001`
- `wahaSession` → `f1`

och lägg in den nya nyckeln i credentialen **WAHA API** (header `X-Api-Key`).
Tills dess läser flödet via den befintliga sessionen `tisdags_meck`.

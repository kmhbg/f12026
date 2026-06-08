#!/usr/bin/env bash
# Pre-bygger OpenF1 replay-cache på produktionsservern via befintligt API i server.js.
#
# Användning (proxmox / homelab):
#   cd /var/www/f1-betting-2026 && bash deploy/prewarm-cache.sh
#
# Miljövariabler:
#   PREWARM_ALL=1          – alla avslutade sessioner (Race, Qualifying, Practice)
#   PREWARM_RACES_ONLY=1   – endast Race (standard)
#   APP_DIR                – appkatalog (standard /var/www/f1-betting-2026)
#   PORT                   – app-port (standard 3000)
#   BASE_URL               – API-bas (standard http://127.0.0.1:${PORT})
#   SERVICE_NAME           – systemd-tjänst (standard f1-betting)
#   SYNC_TIMEOUT_SEC       – max tid för POST sync (standard 7200)
#   POLL_INTERVAL_SEC      – poll-intervall under sync (standard 10)
#   PREWARM_LIMIT          – valfri max antal sessioner (för test)
#
# Cron-exempel (söndag 04:00, alla race):
#   0 4 * * 0 www-data cd /var/www/f1-betting-2026 && bash deploy/prewarm-cache.sh
#
# Cron-exempel (hel säsong, söndag 04:00):
#   0 4 * * 0 www-data cd /var/www/f1-betting-2026 && PREWARM_ALL=1 bash deploy/prewarm-cache.sh
#
# Systemd oneshot: se deploy/prewarm-cache.service
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/f1-betting-2026}"
PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
PREWARM_ALL="${PREWARM_ALL:-0}"
PREWARM_RACES_ONLY="${PREWARM_RACES_ONLY:-1}"
SERVICE_NAME="${SERVICE_NAME:-f1-betting}"
SYNC_TIMEOUT_SEC="${SYNC_TIMEOUT_SEC:-7200}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-10}"
PREWARM_LIMIT="${PREWARM_LIMIT:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$APP_DIR" ]]; then
  cd "$APP_DIR"
elif [[ -f "$SCRIPT_DIR/../server.js" ]]; then
  cd "$SCRIPT_DIR/.."
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

fail() {
  log "FEL: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Kommandot '$1' saknas"
}

json_get() {
  local json="$1"
  local expr="$2"
  node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String(${expr}));" "$json" 2>/dev/null || echo ""
}

json_array_len() {
  local json="$1"
  local key="$2"
  node -e "
    const d = JSON.parse(process.argv[1]);
    const v = d[process.argv[2]];
    process.stdout.write(String(Array.isArray(v) ? v.length : 0));
  " "$json" "$key"
}

print_sync_snapshot() {
  local json="$1"
  local prefix="${2:-}"
  local cached skipped failed total
  cached="$(json_array_len "$json" "cached")"
  skipped="$(json_array_len "$json" "skipped")"
  failed="$(json_array_len "$json" "failed")"
  total="$(json_get "$json" "d.totalCandidates ?? 0")"
  log "${prefix}candidater: ${total}, cachade: ${cached}, hoppade: ${skipped}, fel: ${failed}"
}

verify_service() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
      log "systemd-tjänst $SERVICE_NAME är aktiv"
    else
      log "Varning: systemd-tjänst $SERVICE_NAME verkar inte vara aktiv – fortsätter med HTTP-kontroll"
    fi
  fi

  local code body
  code="$(curl -sf -o /tmp/f1-prewarm-metadata-$$.json -w '%{http_code}' "${BASE_URL}/api/metadata" || echo "000")"
  if [[ "$code" != "200" ]]; then
    fail "App svarar inte på ${BASE_URL}/api/metadata (HTTP ${code}). Starta ${SERVICE_NAME} först."
  fi
  body="$(cat "/tmp/f1-prewarm-metadata-$$.json")"
  local season
  season="$(json_get "$body" "d.seasonYear ?? ''")"
  log "App OK – säsong ${season}, cache-katalog via API"
  rm -f "/tmp/f1-prewarm-metadata-$$.json"
}

wait_for_idle_sync() {
  local status_json in_progress
  status_json="$(curl -sf "${BASE_URL}/api/live/replay/cache/sync" || echo '{}')"
  in_progress="$(json_get "$status_json" "d.inProgress ? '1' : '0")"
  if [[ "$in_progress" != "1" ]]; then
    return 0
  fi

  log "Pågående cache-sync upptäckt – väntar tills klar..."
  while [[ "$in_progress" == "1" ]]; do
    print_sync_snapshot "$status_json" "  "
    sleep "$POLL_INTERVAL_SEC"
    status_json="$(curl -sf "${BASE_URL}/api/live/replay/cache/sync" || echo '{}')"
    in_progress="$(json_get "$status_json" "d.inProgress ? '1' : '0")"
  done
  log "Tidigare sync klar"
}

build_sync_query() {
  local query="all=1"
  if [[ "$PREWARM_ALL" == "1" && "$PREWARM_RACES_ONLY" != "1" ]]; then
    query="${query}&races_only=0"
    log "Läge: alla avslutade sessioner (Race, Qualifying, Practice)"
  else
    query="${query}&races_only=1"
    if [[ "$PREWARM_ALL" == "1" ]]; then
      log "Läge: alla avslutade race"
    else
      log "Läge: alla avslutade race (standard)"
    fi
  fi
  if [[ -n "$PREWARM_LIMIT" ]]; then
    query="${query}&limit=${PREWARM_LIMIT}"
    log "Begränsar till ${PREWARM_LIMIT} session(er)"
  fi
  printf '%s' "$query"
}

poll_sync_progress() {
  local post_pid="$1"
  local status_json in_progress last_cached last_skipped last_failed

  while kill -0 "$post_pid" 2>/dev/null; do
    status_json="$(curl -sf "${BASE_URL}/api/live/replay/cache/sync" || echo '{}')"
    in_progress="$(json_get "$status_json" "d.inProgress ? '1' : '0")"
    if [[ "$in_progress" == "1" && -n "$(json_get "$status_json" "d.last ? JSON.stringify(d.last) : ''")" ]]; then
      local last_json
      last_json="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(d.last||{}));" "$status_json")"
      last_cached="$(json_array_len "$last_json" "cached")"
      last_skipped="$(json_array_len "$last_json" "skipped")"
      last_failed="$(json_array_len "$last_json" "failed")"
      log "  pågår – cachade: ${last_cached}, hoppade: ${last_skipped}, fel: ${last_failed}"
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
}

trigger_sync() {
  local query result_file http_code
  query="$(build_sync_query)"
  result_file="$(mktemp "${TMPDIR:-/tmp}/f1-prewarm-result-XXXXXX")"

  log "Startar cache-sync via POST ${BASE_URL}/api/live/replay/cache/sync?${query}"
  log "Detta kan ta 30–60+ min vid full säsong (OpenF1 rate limits). Säker att köra om."

  curl -sf -X POST \
    --max-time "$SYNC_TIMEOUT_SEC" \
    -o "$result_file" \
    -w '%{http_code}' \
    "${BASE_URL}/api/live/replay/cache/sync?${query}" \
    > "${TMPDIR:-/tmp}/f1-prewarm-http-code-$$" &
  local post_pid=$!

  poll_sync_progress "$post_pid"

  wait "$post_pid" || fail "Cache-sync avbröts eller nådde timeout (${SYNC_TIMEOUT_SEC}s)"
  http_code="$(cat "${TMPDIR:-/tmp}/f1-prewarm-http-code-$$")"
  rm -f "${TMPDIR:-/tmp}/f1-prewarm-http-code-$$"

  if [[ "$http_code" == "409" ]]; then
    rm -f "$result_file"
    fail "Sync redan igång (HTTP 409)"
  fi
  if [[ "$http_code" != "200" ]]; then
    local err
    err="$(cat "$result_file" 2>/dev/null || true)"
    rm -f "$result_file"
    fail "Cache-sync misslyckades (HTTP ${http_code}): ${err}"
  fi

  local result
  result="$(cat "$result_file")"
  rm -f "$result_file"

  print_sync_snapshot "$result" "Resultat – "
  if [[ -n "$(json_get "$result" "d.error ?? ''")" ]]; then
    fail "Sync returnerade fel: $(json_get "$result" "d.error")"
  fi

  local failed_count
  failed_count="$(json_array_len "$result" "failed")"
  if [[ "$failed_count" != "0" ]]; then
    node -e "
      const d = JSON.parse(process.argv[1]);
      for (const row of d.failed || []) {
        console.log('[$(date '+%Y-%m-%d %H:%M:%S')]   misslyckades:', row.label || row.sessionKey, '-', row.error || 'okänt fel');
      }
    " "$result"
    fail "${failed_count} session(er) kunde inte cachas"
  fi

  log "Cache-prewarm klar"
}

main() {
  require_cmd curl
  require_cmd node

  log "F1 replay cache prewarm – $(pwd)"
  verify_service
  wait_for_idle_sync
  trigger_sync
}

main "$@"

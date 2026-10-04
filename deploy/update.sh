#!/usr/bin/env bash
# Uppdaterar en Docker-installation till senaste versionen av en gren och
# kontrollerar att appen svarar. Körs i katalogen där repot är klonat.
#   ./deploy/update.sh            (aktuell gren)
#   BRANCH=v2 ./deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-3000}"

git fetch origin "$BRANCH"
git checkout -q "$BRANCH"
git reset -q --hard "origin/$BRANCH"

APP_VERSION="$(git rev-parse --short HEAD)" docker compose up -d --build

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "OK: $(git log -1 --oneline)"
    exit 0
  fi
  sleep 2
done
echo "Appen svarar inte på /api/health – kolla: docker compose logs --tail 50" >&2
exit 1

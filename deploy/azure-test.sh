#!/usr/bin/env bash
# Deploy/uppdatera F1tting testmiljö i Azure Container Apps.
#
# Befintlig infrastruktur (rg-f12026-test, swedencentral):
#   - Container Apps Environment: f12026-test-env
#   - Container App:              f12026-test
#   - ACR (Basic, auto-skapad):   ca80d3e4df73acr
#   - Log Analytics:              workspace-rgf12026testz7iH
#
# OBS: ACR Tasks är blockerat på denna prenumeration – bygg lokalt och
# pusha med docker push (inte az acr build).
#
# Persistent cache: Azure Files monteras på /app/data/cache (OpenF1 replay).
#
# OpenF1 MQTT (https://github.com/br-g/openf1/tree/main/mqtt-config + openf1.org/auth.html):
#   Sätt secrets i Container App (aldrig i repo):
#     az containerapp secret set -g rg-f12026-test -n f12026-test \
#       --secrets openf1-username='DIN_EMAIL' openf1-password='DITT_LÖSENORD'
#     az containerapp update -g rg-f12026-test -n f12026-test \
#       --set-env-vars OPENF1_USERNAME=secretref:openf1-username \
#                      OPENF1_PASSWORD=secretref:openf1-password
#   Valfritt: OPENF1_MQTT_PASSWORD (förifylld access_token), OPENF1_MQTT_ENABLED=false
#
# På Apple Silicon: alltid --platform linux/amd64 (ACA kräver amd64).
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-f12026-test}"
LOCATION="${LOCATION:-swedencentral}"
APP_NAME="${APP_NAME:-f12026-test}"
ENV_NAME="${ENV_NAME:-f12026-test-env}"
ACR_NAME="${ACR_NAME:-ca80d3e4df73acr}"
IMAGE_TAG="${IMAGE_TAG:-live-$(date +%Y%m%d%H%M)}"
IMAGE="${IMAGE:-${ACR_NAME}.azurecr.io/f12026:${IMAGE_TAG}}"
PLATFORM="${PLATFORM:-linux/amd64}"
CACHE_STORAGE_ACCOUNT="${CACHE_STORAGE_ACCOUNT:-f12026testcache}"
CACHE_FILE_SHARE="${CACHE_FILE_SHARE:-f12026-cache}"
CACHE_MOUNT_NAME="${CACHE_MOUNT_NAME:-sessioncache}"
CACHE_MOUNT_PATH="${CACHE_MOUNT_PATH:-/app/data/cache}"

echo "=== F1tting Azure test deploy ==="
echo "RG: $RESOURCE_GROUP | App: $APP_NAME | Image: $IMAGE | Platform: $PLATFORM"

if ! command -v az &>/dev/null; then
  echo "az CLI saknas. Installera Azure CLI och kör 'az login'."
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "docker saknas. Installera Docker Desktop."
  exit 1
fi

ensure_azure_cache_volume() {
  echo "Säkerställer persistent cache-volym (Azure Files)..."

  if ! az storage account show -g "$RESOURCE_GROUP" -n "$CACHE_STORAGE_ACCOUNT" &>/dev/null; then
    echo "Skapar storage account $CACHE_STORAGE_ACCOUNT..."
    if ! az storage account create \
      -g "$RESOURCE_GROUP" \
      -n "$CACHE_STORAGE_ACCOUNT" \
      -l "$LOCATION" \
      --sku Standard_LRS \
      --kind StorageV2 \
      --min-tls-version TLS1_2 \
      -o none; then
      echo "Varning: Kunde inte skapa storage account (cache blir ej persistent i Azure)."
      echo "         Dockerfile-fix ger ändå skrivbar cache i containern tills volym finns."
      return 1
    fi
  fi

  local account_key
  account_key=$(az storage account keys list \
    -g "$RESOURCE_GROUP" \
    -n "$CACHE_STORAGE_ACCOUNT" \
    --query '[0].value' -o tsv)

  az storage share create \
    --name "$CACHE_FILE_SHARE" \
    --account-name "$CACHE_STORAGE_ACCOUNT" \
    --account-key "$account_key" \
    -o none 2>/dev/null || true

  az containerapp env storage set \
    --name "$ENV_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --storage-name "$CACHE_MOUNT_NAME" \
    --access-mode ReadWrite \
    --azure-file-account-name "$CACHE_STORAGE_ACCOUNT" \
    --azure-file-account-key "$account_key" \
    --azure-file-share-name "$CACHE_FILE_SHARE" \
    -o none

  echo "Cache-volym registrerad: $CACHE_MOUNT_NAME -> $CACHE_MOUNT_PATH"
  return 0
}

# Säkerställ att Microsoft.App är registrerat (kan flippa Registering/Registered)
az provider register -n Microsoft.App --wait >/dev/null 2>&1 || true

CACHE_VOLUME_READY=0
if ensure_azure_cache_volume; then
  CACHE_VOLUME_READY=1
fi

echo "Bygger Docker-image (${PLATFORM})..."
docker build --platform "$PLATFORM" -t "$IMAGE" .

echo "Loggar in på ACR..."
az acr login -n "$ACR_NAME"

echo "Pushar image..."
docker push "$IMAGE"

echo "Uppdaterar Container App..."
UPDATE_YAML="$(mktemp)"
if [ "$CACHE_VOLUME_READY" -eq 1 ]; then
  cat > "$UPDATE_YAML" <<EOF
properties:
  template:
    containers:
    - name: ${APP_NAME}
      image: ${IMAGE}
      env:
      - name: NODE_ENV
        value: production
      - name: BETS_FILE
        value: bets.test.json
      - name: CACHE_DIR
        value: /app/data/cache
      - name: CACHE_SYNC_INTERVAL_MS
        value: "21600000"
      - name: CACHE_PREWARM_RACE_COUNT
        value: "3"
      volumeMounts:
      - volumeName: cache-volume
        mountPath: ${CACHE_MOUNT_PATH}
    volumes:
    - name: cache-volume
      storageType: AzureFile
      storageName: ${CACHE_MOUNT_NAME}
EOF
else
  cat > "$UPDATE_YAML" <<EOF
properties:
  template:
    containers:
    - name: ${APP_NAME}
      image: ${IMAGE}
      env:
      - name: NODE_ENV
        value: production
      - name: BETS_FILE
        value: bets.test.json
      - name: CACHE_DIR
        value: /app/data/cache
      - name: CACHE_SYNC_INTERVAL_MS
        value: "21600000"
      - name: CACHE_PREWARM_RACE_COUNT
        value: "3"
EOF
fi

az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --yaml "$UPDATE_YAML" \
  -o none

rm -f "$UPDATE_YAML"

FQDN=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.configuration.ingress.fqdn" \
  -o tsv)

REVISION=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.latestRevisionName" \
  -o tsv)

echo ""
echo "=== Deploy klar ==="
echo "URL: https://${FQDN}"
echo "Revision: ${REVISION}"
echo ""
echo "Verifiera:"
echo "  curl -s -o /dev/null -w '%{http_code}' https://${FQDN}/api/metadata"
echo "  curl -s https://${FQDN}/api/live/replay/cache/sync"
echo "  curl -s -X POST https://${FQDN}/api/live/replay/cache/sync"
echo "  curl -s 'https://${FQDN}/api/live/replay/frame?session_key=11234&at=2026-03-08T05:30:00.000Z' | head -c 200"
echo "  curl -s https://${FQDN}/api/live/mqtt/status"

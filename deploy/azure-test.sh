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
# På Apple Silicon: alltid --platform linux/amd64 (ACA kräver amd64).
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-f12026-test}"
LOCATION="${LOCATION:-swedencentral}"
APP_NAME="${APP_NAME:-f12026-test}"
ACR_NAME="${ACR_NAME:-ca80d3e4df73acr}"
IMAGE_TAG="${IMAGE_TAG:-test}"
IMAGE="${IMAGE:-${ACR_NAME}.azurecr.io/f12026:${IMAGE_TAG}}"
PLATFORM="${PLATFORM:-linux/amd64}"

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

# Säkerställ att Microsoft.App är registrerat (kan flippa Registering/Registered)
az provider register -n Microsoft.App --wait >/dev/null 2>&1 || true

echo "Bygger Docker-image (${PLATFORM})..."
docker build --platform "$PLATFORM" -t "$IMAGE" .

echo "Loggar in på ACR..."
az acr login -n "$ACR_NAME"

echo "Pushar image..."
docker push "$IMAGE"

echo "Uppdaterar Container App..."
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "$IMAGE"

FQDN=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.configuration.ingress.fqdn" \
  -o tsv)

echo ""
echo "=== Deploy klar ==="
echo "URL: https://${FQDN}"
echo ""
echo "Verifiera:"
echo "  curl -s -o /dev/null -w '%{http_code}' https://${FQDN}/api/metadata"
echo "  curl -s -o /dev/null -w '%{http_code}' https://${FQDN}/"

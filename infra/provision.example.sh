#!/usr/bin/env bash
# =============================================================================
# recall — Azure Container Apps provisioning (example template)
# =============================================================================
# Copy this to `provision.sh`, fill in the CONFIG block below, then run it from
# the repo root:  bash infra/provision.sh
#
# It provisions the whole stack onto Azure Container Apps:
#
#   <prefix>-mcp     FastMCP backend   external ingress :8765   AUTH_MODE=entra
#   <prefix>-web     Next.js BFF       external ingress :3000   MSAL (humans)
#   <prefix>-worker  procrastinate     no ingress               background jobs
#   <prefix>-pg      Postgres 16 + pgvector   public + firewall rules
#
# Secrets live in Key Vault and are pulled by the apps via a user-assigned
# managed identity (that same identity also reads Key Vault). Images are pulled
# from ACR using the ACR admin credential — this avoids needing rights to create
# role assignments. If you *can* create role assignments, the cleaner path is a
# managed identity granted `AcrPull` + `Key Vault Secrets User` instead.
#
# All apps run min-replicas=1 (always-on / no cold starts). Idempotent and
# retry-wrapped: safe to re-run — existing resources are skipped.
# =============================================================================
set -euo pipefail

# Force UTF-8 I/O: on Windows the az CLI streams `az acr build` logs through
# cp1252 and can crash on Unicode in pip output ('charmap' codec can't encode).
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

# Git Bash (MSYS) rewrites args that look like Unix paths (e.g. the
# /subscriptions/.. identity resource IDs) into Windows paths, corrupting
# --user-assigned and identityref. Disable that path conversion.
export MSYS_NO_PATHCONV=1

# ── CONFIG — fill these in ────────────────────────────────────────────────────
SUBSCRIPTION="<your-subscription-id>"
LOCATION="westeurope"          # data plane: Postgres, ACR, Key Vault
ENV_LOCATION="westeurope"      # Container Apps environment region
RG="recall-rg"                 # resource group (create it first, or let create fail if it exists)
TAG="latest"

# Globally-unique names — change the prefix to something of your own.
# NOTE: ACR names allow only alphanumerics (no hyphens), 5-50 chars.
ACR_NAME="recallacr"           # globally unique
KV_NAME="recall-kv"            # globally unique, <=24 chars
PG_NAME="recall-pg"            # globally unique (DNS)
ENV_NAME="recall-env"
IDENTITY="recall-id"

APP_MCP="recall-mcp"
APP_WEB="recall-web"
APP_WORKER="recall-worker"

PG_ADMIN="recalladmin"
PG_DB="recall"

# ── Entra app registration (single-tenant) ────────────────────────────────────
# Create an app registration in your tenant, expose an API scope named `access`,
# and add a client secret. See infra/README.md for the full walkthrough.
AZURE_TENANT_ID="<your-entra-tenant-id>"
AZURE_CLIENT_ID="<your-app-client-id>"
AZURE_API_AUDIENCE="api://${AZURE_CLIENT_ID}"

# ── Azure OpenAI embeddings ────────────────────────────────────────────────────
# 3-large requested at 1536 dims (Matryoshka) to stay under pgvector's 2000-dim
# HNSW limit; api-version 2024-02-01 is required for the 3-series.
AOAI_ENDPOINT="https://<your-resource>.cognitiveservices.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-02-01"
AOAI_MODEL="text-embedding-3-large"
AOAI_DIM="1536"

# ── Trash retention (auto-purge, run by the worker) ──────────────────────────
# Hard-delete items that have sat in Trash longer than this many days. 0 = off.
TRASH_RETENTION_DAYS="${TRASH_RETENTION_DAYS:-30}"
TRASH_PURGE_CRON="${TRASH_PURGE_CRON:-0 4 * * *}"

# ── Secrets you MUST export before running ────────────────────────────────────
: "${AZURE_CLIENT_SECRET:?export AZURE_CLIENT_SECRET before running (Entra app secret)}"
: "${AZURE_OPENAI_API_KEY:?export AZURE_OPENAI_API_KEY before running (embeddings key)}"

# ── Helpers ───────────────────────────────────────────────────────────────────
retry() {
  local n=1
  until "$@"; do
    if [ "$n" -ge 4 ]; then echo "!! failed after $n attempts: $*" >&2; return 1; fi
    echo ">> transient failure, retry $n/3 in 15s: $*" >&2
    sleep 15; n=$((n + 1))
  done
}
exists() { "$@" -o none >/dev/null 2>&1; }

# acr_build: build an image in ACR. On Windows, az can crash (cp1252) while it
# STREAMS build logs, even though the build runs fine server-side. So we ignore
# the local crash, poll the run to completion, and confirm the tag landed.
acr_build() {  # <imageRepo> <dockerfile> <context>
  local img="$1" dockerfile="$2" ctx="$3" status tries=0
  echo ">> building ${img}:${TAG} ..."
  az acr build -r "$ACR_NAME" -t "${img}:${TAG}" -f "$dockerfile" "$ctx" >/dev/null 2>&1 || true
  while :; do
    status="$(az acr task list-runs -r "$ACR_NAME" --top 1 --query '[0].status' -o tsv 2>/dev/null || echo '')"
    case "$status" in
      Succeeded) break ;;
      Failed|Canceled|Error|Timeout) echo "!! ${img} build ${status}" >&2; return 1 ;;
    esac
    tries=$((tries + 1)); [ "$tries" -ge 40 ] && { echo "!! ${img} build timed out" >&2; return 1; }
    sleep 10
  done
  az acr repository show-tags -n "$ACR_NAME" --repository "$img" -o tsv 2>/dev/null | grep -qx "$TAG" \
    || { echo "!! ${img}:${TAG} not found after build" >&2; return 1; }
  echo ">> ${img}:${TAG} built"
}

az account set --subscription "$SUBSCRIPTION"
echo ">> Subscription set. Provisioning into $RG ($LOCATION)."

# ── 1. Container Registry ─────────────────────────────────────────────────────
echo ">> [1/9] Container Registry"
exists az acr show -n "$ACR_NAME" -g "$RG" \
  || retry az acr create -g "$RG" -n "$ACR_NAME" --sku Basic -l "$LOCATION" -o none
ACR_LOGIN_SERVER="$(retry az acr show -n "$ACR_NAME" -g "$RG" --query loginServer -o tsv)"

# ── 2. Managed identity (Key Vault reads) + ACR admin creds (image pull) ───────
echo ">> [2/9] Managed identity + ACR admin credentials"
exists az identity show -g "$RG" -n "$IDENTITY" \
  || retry az identity create -g "$RG" -n "$IDENTITY" -l "$LOCATION" -o none
IDENTITY_ID="$(retry az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)"
IDENTITY_PRINCIPAL="$(retry az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)"
retry az acr update -n "$ACR_NAME" --admin-enabled true -o none
ACR_USER="$(retry az acr credential show -n "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(retry az acr credential show -n "$ACR_NAME" --query "passwords[0].value" -o tsv)"

# ── 3. Key Vault (access-policy mode — no role assignments) ────────────────────
echo ">> [3/9] Key Vault"
exists az keyvault show -n "$KV_NAME" -g "$RG" \
  || retry az keyvault create -g "$RG" -n "$KV_NAME" -l "$LOCATION" \
       --enable-rbac-authorization false -o none
ME_OID="$(retry az ad signed-in-user show --query id -o tsv)"
retry az keyvault set-policy -n "$KV_NAME" --object-id "$ME_OID" \
  --secret-permissions get list set -o none
retry az keyvault set-policy -n "$KV_NAME" --object-id "$IDENTITY_PRINCIPAL" \
  --secret-permissions get list -o none
sleep 10

# Reuse an existing session secret if present (don't invalidate live sessions).
if SESSION_SECRET="$(az keyvault secret show --vault-name "$KV_NAME" -n session-secret --query value -o tsv 2>/dev/null)"; then
  echo ">> reusing existing session-secret"
else
  SESSION_SECRET="$(openssl rand -base64 32)"
fi

# ── 4. Postgres Flexible Server (Burstable B1ms) + pgvector ───────────────────
echo ">> [4/9] Postgres Flexible Server"
if exists az postgres flexible-server show -g "$RG" -n "$PG_NAME"; then
  echo ">> Postgres exists; reusing admin password from Key Vault"
  PG_PASSWORD="$(retry az keyvault secret show --vault-name "$KV_NAME" -n pg-admin-password --query value -o tsv)"
else
  PG_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  # --public-access 0.0.0.0 = allow Azure services (Container Apps) to connect.
  retry az postgres flexible-server create -g "$RG" -n "$PG_NAME" -l "$LOCATION" \
    --tier Burstable --sku-name Standard_B1ms \
    --version 16 --storage-size 32 \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --database-name "$PG_DB" --public-access 0.0.0.0 -y -o none
fi
# Allowlist the pgvector extension so the app's migration can CREATE EXTENSION.
retry az postgres flexible-server parameter set -g "$RG" -s "$PG_NAME" \
  --name azure.extensions --value VECTOR -o none

PG_FQDN="${PG_NAME}.postgres.database.azure.com"
DATABASE_URL="postgresql://${PG_ADMIN}:${PG_PASSWORD}@${PG_FQDN}:5432/${PG_DB}?sslmode=require"

# Store secrets in Key Vault (secret set is idempotent — new version each time).
retry az keyvault secret set --vault-name "$KV_NAME" -n database-url        --value "$DATABASE_URL"         -o none
retry az keyvault secret set --vault-name "$KV_NAME" -n session-secret      --value "$SESSION_SECRET"       -o none
retry az keyvault secret set --vault-name "$KV_NAME" -n azure-client-secret --value "$AZURE_CLIENT_SECRET"  -o none
retry az keyvault secret set --vault-name "$KV_NAME" -n azure-openai-key    --value "$AZURE_OPENAI_API_KEY" -o none
retry az keyvault secret set --vault-name "$KV_NAME" -n pg-admin-password   --value "$PG_PASSWORD"          -o none

# Versionless secret URIs for Container Apps Key Vault references.
kv_uri() { retry az keyvault secret show --vault-name "$KV_NAME" -n "$1" --query id -o tsv | sed 's|/[^/]*$||'; }
DB_URI="$(kv_uri database-url)"
SESSION_URI="$(kv_uri session-secret)"
CLIENT_URI="$(kv_uri azure-client-secret)"
AOAI_URI="$(kv_uri azure-openai-key)"

# ── 5. Build & push images (cloud build — no local Docker needed) ─────────────
echo ">> [5/9] Building images in ACR"
# NB: az resolves -f relative to the CWD, not the build context — so the web
# image needs -f web/Dockerfile (not Dockerfile) or it picks the backend one.
acr_build recall-backend Dockerfile .
acr_build recall-web web/Dockerfile web
# Pin deployments to the exact digest we just built. The :latest tag string
# never changes, so `az containerapp update` treats a rebuild as a no-op and the
# live app keeps running the old image. Referencing @sha256:... rolls each app.
BACKEND_IMG="${ACR_LOGIN_SERVER}/recall-backend@$(retry az acr repository show -n "$ACR_NAME" --image "recall-backend:${TAG}" --query digest -o tsv)"
WEB_IMG="${ACR_LOGIN_SERVER}/recall-web@$(retry az acr repository show -n "$ACR_NAME" --image "recall-web:${TAG}" --query digest -o tsv)"

# ── 6. Container Apps environment ─────────────────────────────────────────────
# `--logs-destination log-analytics` (with a workspace) is recommended; this
# template uses `none` to avoid requiring a Log Analytics workspace. Live logs
# still work via `az containerapp logs show`.
echo ">> [6/9] Container Apps environment"
exists az containerapp env show -g "$RG" -n "$ENV_NAME" \
  || retry az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$ENV_LOCATION" \
       --logs-destination none -o none

# ── 7. MCP backend (public) ───────────────────────────────────────────────────
echo ">> [7/9] $APP_MCP"
exists az containerapp show -g "$RG" -n "$APP_MCP" \
  || retry az containerapp create -g "$RG" -n "$APP_MCP" --environment "$ENV_NAME" \
       --image "$BACKEND_IMG" \
       --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
       --user-assigned "$IDENTITY_ID" \
       --ingress external --target-port 8765 --transport auto \
       --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi \
       --secrets "database-url=keyvaultref:${DB_URI},identityref:${IDENTITY_ID}" \
                 "aoai-key=keyvaultref:${AOAI_URI},identityref:${IDENTITY_ID}" \
                 "client-secret=keyvaultref:${CLIENT_URI},identityref:${IDENTITY_ID}" \
       --env-vars "DATABASE_URL=secretref:database-url" \
                  "MCP_HOST=0.0.0.0" "MCP_PORT=8765" \
                  "AUTH_MODE=entra" \
                  "AZURE_TENANT_ID=${AZURE_TENANT_ID}" \
                  "AZURE_CLIENT_ID=${AZURE_CLIENT_ID}" \
                  "AZURE_API_AUDIENCE=${AZURE_API_AUDIENCE}" \
                  "AZURE_CLIENT_SECRET=secretref:client-secret" \
                  "MCP_SCOPES=access" \
                  "EMBEDDING_PROVIDER=azure" \
                  "AZURE_OPENAI_API_KEY=secretref:aoai-key" \
                  "AZURE_OPENAI_EMBEDDING_ENDPOINT=${AOAI_ENDPOINT}" \
                  "AZURE_OPENAI_EMBEDDING_MODEL=${AOAI_MODEL}" \
                  "AZURE_OPENAI_EMBEDDING_DIM=${AOAI_DIM}" -o none
MCP_FQDN="$(retry az containerapp show -g "$RG" -n "$APP_MCP" --query properties.configuration.ingress.fqdn -o tsv)"
# Now that we know the public host, add it to the DNS-rebinding allowlist.
retry az containerapp update -g "$RG" -n "$APP_MCP" \
  --image "$BACKEND_IMG" \
  --set-env-vars "MCP_ALLOWED_HOSTS=${MCP_FQDN},${MCP_FQDN}:*,localhost:*,127.0.0.1:*" \
                 "MCP_PUBLIC_URL=https://${MCP_FQDN}" -o none

# ── 8. Worker (no ingress) ────────────────────────────────────────────────────
echo ">> [8/9] $APP_WORKER"
exists az containerapp show -g "$RG" -n "$APP_WORKER" \
  || retry az containerapp create -g "$RG" -n "$APP_WORKER" --environment "$ENV_NAME" \
       --image "$BACKEND_IMG" \
       --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
       --user-assigned "$IDENTITY_ID" \
       --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
       --command "sh" "/app/worker.sh" \
       --secrets "database-url=keyvaultref:${DB_URI},identityref:${IDENTITY_ID}" \
                 "aoai-key=keyvaultref:${AOAI_URI},identityref:${IDENTITY_ID}" \
       --env-vars "DATABASE_URL=secretref:database-url" \
                  "EMBEDDING_PROVIDER=azure" \
                  "AZURE_OPENAI_API_KEY=secretref:aoai-key" \
                  "AZURE_OPENAI_EMBEDDING_ENDPOINT=${AOAI_ENDPOINT}" \
                  "AZURE_OPENAI_EMBEDDING_MODEL=${AOAI_MODEL}" \
                  "AZURE_OPENAI_EMBEDDING_DIM=${AOAI_DIM}" -o none
retry az containerapp update -g "$RG" -n "$APP_WORKER" \
  --image "$BACKEND_IMG" \
  --set-env-vars "TRASH_RETENTION_DAYS=${TRASH_RETENTION_DAYS}" \
                 "TRASH_PURGE_CRON=${TRASH_PURGE_CRON}" -o none

# ── 9. Web BFF (public) ───────────────────────────────────────────────────────
echo ">> [9/9] $APP_WEB"
exists az containerapp show -g "$RG" -n "$APP_WEB" \
  || retry az containerapp create -g "$RG" -n "$APP_WEB" --environment "$ENV_NAME" \
       --image "$WEB_IMG" \
       --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
       --user-assigned "$IDENTITY_ID" \
       --ingress external --target-port 3000 --transport auto \
       --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi \
       --secrets "session-secret=keyvaultref:${SESSION_URI},identityref:${IDENTITY_ID}" \
                 "client-secret=keyvaultref:${CLIENT_URI},identityref:${IDENTITY_ID}" \
       --env-vars "BACKEND_URL=https://${MCP_FQDN}" \
                  "MCP_PUBLIC_URL=https://${MCP_FQDN}" \
                  "AUTH_MODE=entra" \
                  "AZURE_TENANT_ID=${AZURE_TENANT_ID}" \
                  "AZURE_CLIENT_ID=${AZURE_CLIENT_ID}" \
                  "AZURE_API_AUDIENCE=${AZURE_API_AUDIENCE}" \
                  "AZURE_CLIENT_SECRET=secretref:client-secret" \
                  "SESSION_SECRET=secretref:session-secret" -o none
WEB_FQDN="$(retry az containerapp show -g "$RG" -n "$APP_WEB" --query properties.configuration.ingress.fqdn -o tsv)"
# Wire the real callback URL now that the web host exists.
retry az containerapp update -g "$RG" -n "$APP_WEB" \
  --image "$WEB_IMG" \
  --set-env-vars "AUTH_REDIRECT_URI=https://${WEB_FQDN}/api/auth/callback" \
                 "AUTH_POST_LOGOUT_REDIRECT_URI=https://${WEB_FQDN}" -o none

# ── Register the web + MCP redirect URIs on the Entra app (may need admin) ─────
echo ">> Registering redirect URIs on Entra app $AZURE_CLIENT_ID (non-fatal)"
EXISTING_URIS="$(az ad app show --id "$AZURE_CLIENT_ID" --query "web.redirectUris" -o tsv 2>/dev/null | tr '\n' ' ' || true)"
az ad app update --id "$AZURE_CLIENT_ID" \
  --web-redirect-uris $EXISTING_URIS "https://${WEB_FQDN}/api/auth/callback" "https://${MCP_FQDN}/auth/callback" -o none \
  || echo "!! Could not update the Entra app automatically — add these under Portal > App registrations > <your app> > Authentication (Web): https://${WEB_FQDN}/api/auth/callback  and  https://${MCP_FQDN}/auth/callback"

# ── Summary ───────────────────────────────────────────────────────────────────
cat <<EOF

==============================================================================
  recall is provisioned.

  Web UI (humans):   https://${WEB_FQDN}
  MCP endpoint:      https://${MCP_FQDN}/mcp
  Health:            https://${MCP_FQDN}/health

  Postgres:          ${PG_FQDN}  (db: ${PG_DB}, user: ${PG_ADMIN})
  Secrets:           Key Vault ${KV_NAME}
  Images:            ${ACR_LOGIN_SERVER}/recall-{backend,web}:${TAG}

  Next:
   - Confirm the redirect URIs are registered on the Entra app (see above).
   - External AI clients point their MCP client at https://${MCP_FQDN}/mcp
     with an Entra token for audience ${AZURE_API_AUDIENCE}.
==============================================================================
EOF

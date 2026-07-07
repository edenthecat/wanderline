#!/usr/bin/env bash
# Deploy the backend service to Cloud Run from a published image.
#
# Reads config from .env.production; every value can be overridden by
# exporting the env var directly (useful for CI overrides).
#
# Usage:
#   IMAGE_TAG=1.2.3 ./scripts/deploy-backend.sh
#   ./scripts/deploy-backend.sh              # reads .env.production

set -euo pipefail

# Load config. Errors if .env.production doesn't exist yet.
SCRIPT_DIR=$(dirname "$0")
if [ -f "$SCRIPT_DIR/../.env.production" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/../.env.production"; set +a
fi

: "${IMAGE_TAG:?Set IMAGE_TAG (e.g. 1.2.3 or sha-XXXXXXXX)}"
: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:?Set REGION}"
: "${SQL_INSTANCE:?Set SQL_INSTANCE}"
: "${GCS_BUCKET:?Set GCS_BUCKET}"
: "${BACKEND_SERVICE:=wanderline-backend}"

IMAGE="ghcr.io/edenthecat/wanderline-backend:$IMAGE_TAG"

INSTANCE_CONNECTION=$(gcloud sql instances describe "$SQL_INSTANCE" \
  --project="$PROJECT_ID" --format='value(connectionName)')

# Rebuild the env-vars string on each deploy. Cloud Run's --set-env-vars
# replaces the WHOLE list, so anything not listed here gets wiped.
ENV_VARS_LIST=(
  "NODE_ENV=production"
  "DB_USER=wanderline"
  "DB_NAME=wanderline"
  "INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION"
  "UPLOAD_DIR=/tmp/uploads"
  "BUILDS_DIR=/tmp/exports"
  "WHISPER_MODEL=skip"
  "STORAGE_BACKEND=gcs"
  "GCS_BUCKET=$GCS_BUCKET"
  "USE_SIGNED_URL_DOWNLOADS=true"
  "SENTRY_RELEASE=$IMAGE_TAG"
)
[ -n "${CORS_ORIGIN:-}" ]        && ENV_VARS_LIST+=("CORS_ORIGIN=$CORS_ORIGIN")
[ -n "${SENTRY_DSN:-}" ]         && ENV_VARS_LIST+=("SENTRY_DSN=$SENTRY_DSN")
[ -n "${SENTRY_ENVIRONMENT:-}" ] && ENV_VARS_LIST+=("SENTRY_ENVIRONMENT=$SENTRY_ENVIRONMENT")
[ -n "${PUBLIC_BASE_URL:-}" ]    && ENV_VARS_LIST+=("PUBLIC_BASE_URL=$PUBLIC_BASE_URL")

# Custom delimiter (^~^) so CORS_ORIGIN can safely list comma-separated
# origins and Sentry DSNs can contain `@`.
ENV_VARS=$(IFS='~'; echo "${ENV_VARS_LIST[*]}")

echo "=== Deploying $IMAGE to $BACKEND_SERVICE ==="

gcloud run deploy "$BACKEND_SERVICE" \
  --project="$PROJECT_ID" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --add-cloudsql-instances="$INSTANCE_CONNECTION" \
  --set-env-vars="^~^$ENV_VARS" \
  --set-secrets="SESSION_SECRET=session-secret:latest,DB_PASSWORD=db-password:latest" \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --timeout=900

URL=$(gcloud run services describe "$BACKEND_SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')

echo
echo "=== Backend deployed ==="
echo "Image: $IMAGE"
echo "URL:   $URL"

#!/usr/bin/env bash
# Deploy the frontend service to Cloud Run from a published image.
# See deploy-backend.sh for the pattern.

set -euo pipefail

SCRIPT_DIR=$(dirname "$0")
if [ -f "$SCRIPT_DIR/../.env.production" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/../.env.production"; set +a
fi

: "${IMAGE_TAG:?Set IMAGE_TAG}"
: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:?Set REGION}"
: "${BACKEND_SERVICE:=wanderline-backend}"
: "${FRONTEND_SERVICE:=wanderline-frontend}"

IMAGE="ghcr.io/edenthecat/wanderline-frontend:$IMAGE_TAG"

BACKEND_URL=$(gcloud run services describe "$BACKEND_SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)' 2>/dev/null)

if [ -z "$BACKEND_URL" ]; then
  echo "Error: backend '$BACKEND_SERVICE' not found — deploy backend first."
  exit 1
fi

echo "=== Deploying $IMAGE to $FRONTEND_SERVICE (proxying to $BACKEND_URL) ==="

gcloud run deploy "$FRONTEND_SERVICE" \
  --project="$PROJECT_ID" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="BACKEND_URL=$BACKEND_URL" \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3

FRONTEND_URL=$(gcloud run services describe "$FRONTEND_SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')

echo
echo "=== Frontend deployed ==="
echo "URL: $FRONTEND_URL"
echo
echo "Now update the backend's CORS_ORIGIN — either in .env.production and"
echo "re-run deploy-backend.sh, or via:"
echo "  gcloud run services update $BACKEND_SERVICE --region=$REGION \\"
echo "    --update-env-vars=CORS_ORIGIN=$FRONTEND_URL"

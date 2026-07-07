#!/usr/bin/env bash
# Deploy the Wanderline frontend to Cloud Run.
# Run after the backend is deployed (it needs the backend URL).
#
# NOTE (open-core split): same caveat as deploy-backend.sh — this
# builds from the working tree. Instance-repo deployments should
# consume published GHCR images instead. See
# documents/INSTANCE-REPO-TEMPLATE/scripts/deploy-frontend.sh.
#
# Usage: PROJECT_ID=my-proj REGION=us-west1 ./scripts/deploy/deploy-frontend.sh

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID env var}"
: "${REGION:=us-west1}"
: "${SERVICE_NAME:=wanderline-frontend}"
: "${BACKEND_SERVICE:=wanderline-backend}"
: "${REPO_NAME:=wanderline}"

# Resolve the backend URL automatically
BACKEND_URL=$(gcloud run services describe "$BACKEND_SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)' 2>/dev/null)

if [ -z "$BACKEND_URL" ]; then
  echo "Error: backend service '$BACKEND_SERVICE' not found in $REGION."
  echo "Deploy the backend first with ./scripts/deploy/deploy-backend.sh"
  exit 1
fi

echo "=== Backend URL detected: $BACKEND_URL ==="

SHA=$(git rev-parse --short HEAD)
VERSION=$(node -p "require('./package.json').version")
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/frontend"
# Deploy by SHA (immutable); semver and `latest` ride along as additional pointers.
IMAGE="$IMAGE_BASE:$SHA"

echo
echo "=== Building & pushing $IMAGE_BASE (tags: $SHA, $VERSION, latest) ==="
CLOUDBUILD_CONFIG=$(mktemp)
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - frontend/Dockerfile.prod
      - -t
      - $IMAGE_BASE:$SHA
      - -t
      - $IMAGE_BASE:$VERSION
      - -t
      - $IMAGE_BASE:latest
      - .
images:
  - $IMAGE_BASE:$SHA
  - $IMAGE_BASE:$VERSION
  - $IMAGE_BASE:latest
EOF
gcloud builds submit \
  --project="$PROJECT_ID" \
  --config="$CLOUDBUILD_CONFIG" \
  .

echo
echo "=== Deploying to Cloud Run: $SERVICE_NAME ==="
gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --port=80 \
  --set-env-vars="BACKEND_URL=$BACKEND_URL,DNS_RESOLVER=8.8.8.8" \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3

URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')

echo
echo "=== Frontend deployed ==="
echo "URL: $URL"
echo
echo "Now update the backend's CORS_ORIGIN to allow this URL:"
echo "  gcloud run services update $BACKEND_SERVICE --region=$REGION --update-env-vars=CORS_ORIGIN=$URL"

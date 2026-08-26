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
# Same default as setup-gcp.sh / deploy-backend.sh so the bucket CORS
# step below finds the right bucket without extra configuration.
: "${GCS_BUCKET:=${PROJECT_ID}-wanderline-uploads}"

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

# Allow the freshly-deployed frontend to read signed audio URLs out of
# the uploads bucket. Skipped rather than fatal: a CORS failure here
# costs offline downloads, not playback, and shouldn't fail a deploy
# that otherwise succeeded.
if [ -n "${GCS_BUCKET:-}" ]; then
  GCS_BUCKET="$GCS_BUCKET" "$(dirname "$0")/configure-bucket-cors.sh" "$URL" || {
    echo "WARNING: could not apply bucket CORS. Offline download will fail for"
    echo "listeners until it's set: GCS_BUCKET=$GCS_BUCKET $(dirname "$0")/configure-bucket-cors.sh $URL"
  }
else
  echo "GCS_BUCKET unset — skipping bucket CORS. Offline download will fail unless"
  echo "the bucket already allows $URL."
fi

echo
echo "Now update the backend's CORS_ORIGIN to allow this URL:"
echo "  gcloud run services update $BACKEND_SERVICE --region=$REGION --update-env-vars=CORS_ORIGIN=$URL"
echo
echo "NOTE: Cloud Run serves BOTH URL formats for a service"
echo "  (<service>-<project-number>.<region>.run.app and <service>-<hash>-<abbrev>.a.run.app)"
echo "and a browser sends whichever the listener actually loaded. If readers may"
echo "reach either, pass both to CORS_ORIGIN (comma-separated) and to"
echo "configure-bucket-cors.sh, or API calls silently fail for half of them."

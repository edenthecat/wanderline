#!/usr/bin/env bash
# Deploy the Wanderline backend to Cloud Run.
#
# NOTE (open-core split): this script builds an image from the current
# working tree AND deploys it — historically the flow for the
# maintainer's own deployment. In the two-repo model, releases are
# built by CI (see .github/workflows/release.yml) and deployed by an
# instance repo (see documents/INSTANCE-REPO-TEMPLATE/). This script
# stays useful for a maintainer building + deploying an unreleased
# HEAD; anyone standing up their own instance should use the
# instance-repo pattern instead.
#
# Usage: PROJECT_ID=my-proj REGION=us-west1 ./scripts/deploy/deploy-backend.sh

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID env var}"
: "${REGION:=us-west1}"
: "${SQL_INSTANCE:=wanderline-db}"
: "${SERVICE_NAME:=wanderline-backend}"
: "${REPO_NAME:=wanderline}"
: "${DB_NAME:=wanderline}"
: "${DB_USER:=wanderline}"
: "${GCS_BUCKET:=${PROJECT_ID}-wanderline-uploads}"

INSTANCE_CONNECTION=$(gcloud sql instances describe "$SQL_INSTANCE" \
  --project="$PROJECT_ID" --format='value(connectionName)')

# Preserve env vars that are managed out-of-band (CORS_ORIGIN gets
# updated to the frontend URL after that service is deployed; SENTRY_DSN
# is set by the operator once a Sentry project exists). --set-env-vars
# replaces the *entire* list, so we have to read existing values back
# and re-supply them or they'll be wiped on each redeploy.
existing_env_var() {
  local name="$1"
  gcloud run services describe "$SERVICE_NAME" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format='value(spec.template.spec.containers[0].env)' 2>/dev/null \
    | tr ';' '\n' \
    | sed -n "s/.*'name': '$name', 'value': '\\([^']*\\)'.*/\\1/p" \
    | head -n 1 \
    || true
}
EXISTING_CORS=$(existing_env_var CORS_ORIGIN)
EXISTING_SENTRY_DSN=$(existing_env_var SENTRY_DSN)
EXISTING_SENTRY_ENV=$(existing_env_var SENTRY_ENVIRONMENT)
EXISTING_PUBLIC_BASE_URL=$(existing_env_var PUBLIC_BASE_URL)

SHA=$(git rev-parse --short HEAD)
VERSION=$(node -p "require('./package.json').version")
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/backend"
# Deploy by SHA (immutable); semver and `latest` ride along as additional pointers.
IMAGE="$IMAGE_BASE:$SHA"

echo "=== Building & pushing $IMAGE_BASE (tags: $SHA, $VERSION, latest) ==="
CLOUDBUILD_CONFIG=$(mktemp)
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - backend/Dockerfile.prod
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
# Custom delimiter (^~^) for --set-env-vars. The default comma would split
# CORS_ORIGIN (which can list multiple origins). We can't use `@` because
# Sentry DSNs always contain it (https://<key>@o<org>.sentry.io/<id>),
# and we can't use `:` because Cloud SQL connection names contain colons.
# `~` is safe — it doesn't appear in URLs, SHAs, bucket names, or paths
# we use here.
ENV_VARS="NODE_ENV=production~DB_USER=$DB_USER~DB_NAME=$DB_NAME~INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION~UPLOAD_DIR=/tmp/uploads~BUILDS_DIR=/tmp/exports~WHISPER_MODEL=skip~STORAGE_BACKEND=gcs~GCS_BUCKET=$GCS_BUCKET~SENTRY_RELEASE=$(git rev-parse --short HEAD)~USE_SIGNED_URL_DOWNLOADS=true"
# USE_SIGNED_URL_DOWNLOADS=true turns on the signed-URL
# 307 redirects for build downloads AND preview audio. Bytes go GCS →
# client directly instead of GCS → Cloud Run → client, so egress leaves
# the Cloud Run billing surface entirely. Requires the Cloud Run service
# account to have `iam.serviceAccountTokenCreator` on itself for the
# signBlob call — verify with:
#   gcloud iam service-accounts get-iam-policy \
#     <backend-sa>@$PROJECT_ID.iam.gserviceaccount.com
# The route degrades to streaming if signing throws (see
# storage.ts::GcsStorage.signedGetUrl), so a missing IAM permission
# would just log warnings and stream — the app stays up.
if [ -n "$EXISTING_CORS" ]; then
  ENV_VARS="$ENV_VARS~CORS_ORIGIN=$EXISTING_CORS"
fi
if [ -n "$EXISTING_SENTRY_DSN" ]; then
  ENV_VARS="$ENV_VARS~SENTRY_DSN=$EXISTING_SENTRY_DSN"
fi
if [ -n "$EXISTING_SENTRY_ENV" ]; then
  ENV_VARS="$ENV_VARS~SENTRY_ENVIRONMENT=$EXISTING_SENTRY_ENV"
fi
if [ -n "$EXISTING_PUBLIC_BASE_URL" ]; then
  ENV_VARS="$ENV_VARS~PUBLIC_BASE_URL=$EXISTING_PUBLIC_BASE_URL"
fi
gcloud run deploy "$SERVICE_NAME" \
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
  # right-sized from 2Gi/2cpu → 1Gi/1cpu now that   # bakes player-app/dist into the image and later dropped the
  # per-build `npm install` + `vite build` steps. Remaining heavy
  # step is ffmpeg WAV→MP3 conversion which fits comfortably in 1Gi
  # per-instance. Halving CPU roughly halves the active-request-
  # second billing on the backend — the biggest single-config win.
  # Watch memory during builds; bump to 2Gi if we see OOM-kill logs
  # in Cloud Run metrics.
  #
  # Historical note: original 2Gi/2cpu/900s was for the
  # npm-install-per-build path. That's gone since then

URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')

echo
echo "=== Backend deployed ==="
echo "URL: $URL"
echo
echo "Update CORS_ORIGIN with the frontend URL after that's deployed:"
echo "  gcloud run services update $SERVICE_NAME --region=$REGION --update-env-vars=CORS_ORIGIN=https://your-frontend-url.run.app"

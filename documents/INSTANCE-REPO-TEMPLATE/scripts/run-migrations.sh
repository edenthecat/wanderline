#!/usr/bin/env bash
# Run backend migrations against the instance's Cloud SQL DB. Uses a
# one-off Cloud Run Job from the same image the backend service runs,
# so the migrations always match the code that's about to be deployed.
#
# Run this BEFORE deploy-backend.sh on any release that includes
# schema changes.

set -euo pipefail

SCRIPT_DIR=$(dirname "$0")
if [ -f "$SCRIPT_DIR/../.env.production" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/../.env.production"; set +a
fi

: "${IMAGE_TAG:?Set IMAGE_TAG}"
: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:?Set REGION}"
: "${SQL_INSTANCE:?Set SQL_INSTANCE}"

JOB_NAME="${MIGRATION_JOB_NAME:-wanderline-migrate}"
IMAGE="ghcr.io/edenthecat/wanderline-backend:$IMAGE_TAG"
INSTANCE_CONNECTION=$(gcloud sql instances describe "$SQL_INSTANCE" \
  --project="$PROJECT_ID" --format='value(connectionName)')

# Create or update the Cloud Run Job that runs migrate.
gcloud run jobs deploy "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --command=npm \
  --args=run,migrate \
  --set-cloudsql-instances="$INSTANCE_CONNECTION" \
  --set-env-vars="^~^NODE_ENV=production~DB_USER=wanderline~DB_NAME=wanderline~INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION~DATABASE_URL=postgres:///wanderline?host=/cloudsql/$INSTANCE_CONNECTION" \
  --set-secrets="DB_PASSWORD=db-password:latest" \
  --max-retries=0 \
  --task-timeout=600 \
  --parallelism=1 \
  --tasks=1

echo "=== Executing migration job ==="
gcloud run jobs execute "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --wait

echo
echo "=== Migrations complete ==="

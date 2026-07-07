#!/usr/bin/env bash
# One-time GCP setup for Wanderline. Run after `gcloud auth login`.
#
# Usage: PROJECT_ID=my-proj REGION=us-west1 ./scripts/deploy/setup-gcp.sh
#
# Creates:
#   - Required APIs enabled (Cloud Run, Cloud SQL, Secret Manager, Cloud Build, Artifact Registry)
#   - Cloud SQL Postgres instance (db-f1-micro, smallest tier)
#   - Database + user
#   - Secrets in Secret Manager (SESSION_SECRET, DB password)
#   - Artifact Registry repo for Docker images

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID env var}"
: "${REGION:=us-west1}"
: "${SQL_INSTANCE:=wanderline-db}"
: "${DB_NAME:=wanderline}"
: "${DB_USER:=wanderline}"
: "${REPO_NAME:=wanderline}"
: "${GCS_BUCKET:=${PROJECT_ID}-wanderline-uploads}"

echo "=== Setting up GCP project: $PROJECT_ID in $REGION ==="

gcloud config set project "$PROJECT_ID"

echo
echo "=== Enabling required APIs ==="
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com

echo
echo "=== Creating Artifact Registry repo: $REPO_NAME ==="
if gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" >/dev/null 2>&1; then
  echo "Repo already exists, skipping."
else
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Wanderline Docker images"
fi

echo
echo "=== Creating Cloud SQL Postgres instance: $SQL_INSTANCE ==="
echo "(This takes ~5 minutes the first time.)"
if gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  echo "Instance already exists, skipping."
else
  gcloud sql instances create "$SQL_INSTANCE" \
    --edition=enterprise \
    --database-version=POSTGRES_16 \
    --tier=db-f1-micro \
    --region="$REGION" \
    --storage-type=SSD \
    --storage-size=10 \
    --backup \
    --backup-start-time=03:00
fi

echo
echo "=== Creating database: $DB_NAME ==="
if gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1; then
  echo "Database already exists, skipping."
else
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
fi

echo
echo "=== Creating database user + db-password secret: $DB_USER ==="
# Check user existence — fail loudly if `gcloud sql users list` itself errors,
# instead of silently treating that as "user doesn't exist".
USER_LIST=$(gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)')
if echo "$USER_LIST" | grep -qx "$DB_USER"; then
  USER_EXISTS=yes
else
  USER_EXISTS=no
fi

if gcloud secrets describe db-password >/dev/null 2>&1; then
  SECRET_EXISTS=yes
else
  SECRET_EXISTS=no
fi

if [ "$USER_EXISTS" = yes ] && [ "$SECRET_EXISTS" = yes ]; then
  echo "User and db-password secret both exist, skipping."
elif [ "$USER_EXISTS" = no ] && [ "$SECRET_EXISTS" = no ]; then
  DB_PASSWORD=$(openssl rand -base64 32)
  gcloud sql users create "$DB_USER" \
    --instance="$SQL_INSTANCE" \
    --password="$DB_PASSWORD"
  echo "Storing db-password in Secret Manager..."
  echo -n "$DB_PASSWORD" | gcloud secrets create db-password \
    --replication-policy=automatic \
    --data-file=-
else
  # One exists but not the other — we can't recover the password from
  # Cloud SQL, so reset the user's password and (re)create the secret.
  echo "User and secret are out of sync — resetting password and updating secret."
  DB_PASSWORD=$(openssl rand -base64 32)
  if [ "$USER_EXISTS" = no ]; then
    gcloud sql users create "$DB_USER" \
      --instance="$SQL_INSTANCE" \
      --password="$DB_PASSWORD"
  else
    gcloud sql users set-password "$DB_USER" \
      --instance="$SQL_INSTANCE" \
      --password="$DB_PASSWORD"
  fi
  if [ "$SECRET_EXISTS" = no ]; then
    echo -n "$DB_PASSWORD" | gcloud secrets create db-password \
      --replication-policy=automatic \
      --data-file=-
  else
    echo -n "$DB_PASSWORD" | gcloud secrets versions add db-password --data-file=-
  fi
fi

echo
echo "=== Creating session-secret ==="
if gcloud secrets describe session-secret >/dev/null 2>&1; then
  echo "Secret already exists, skipping."
else
  SESSION_SECRET=$(openssl rand -hex 32)
  echo -n "$SESSION_SECRET" | gcloud secrets create session-secret \
    --replication-policy=automatic \
    --data-file=-
fi

echo
echo "=== Creating Cloud Storage bucket: $GCS_BUCKET ==="
if gcloud storage buckets describe "gs://$GCS_BUCKET" >/dev/null 2>&1; then
  echo "Bucket already exists, skipping."
else
  gcloud storage buckets create "gs://$GCS_BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access
fi

echo
echo "=== Granting Cloud Run service account access to secrets ==="
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for secret in session-secret db-password; do
  if ! gcloud secrets describe "$secret" >/dev/null 2>&1; then
    echo "Secret $secret does not exist, skipping IAM binding."
    continue
  fi
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$COMPUTE_SA" \
    --role=roles/secretmanager.secretAccessor \
    --condition=None >/dev/null
  echo "Granted secretAccessor on $secret to $COMPUTE_SA"
done

echo
echo "=== Granting Cloud Run service account access to GCS bucket ==="
gcloud storage buckets add-iam-policy-binding "gs://$GCS_BUCKET" \
  --member="serviceAccount:$COMPUTE_SA" \
  --role=roles/storage.objectAdmin >/dev/null
echo "Granted objectAdmin on $GCS_BUCKET to $COMPUTE_SA"

INSTANCE_CONNECTION=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')

echo
echo "=== Setup complete ==="
echo
echo "Project ID:           $PROJECT_ID"
echo "Region:               $REGION"
echo "SQL instance:         $SQL_INSTANCE"
echo "Connection name:      $INSTANCE_CONNECTION"
echo "Artifact Registry:    $REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME"
echo "GCS bucket:           gs://$GCS_BUCKET"
echo
echo "Next: deploy backend with ./scripts/deploy/deploy-backend.sh"
echo "Then deploy frontend with ./scripts/deploy/deploy-frontend.sh"

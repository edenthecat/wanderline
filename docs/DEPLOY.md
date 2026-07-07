# Deploying Wanderline to GCP (build-from-source path)

This guide walks through deploying Wanderline to Google Cloud Platform using **Cloud Run** (containers) and **Cloud SQL** (Postgres). It builds the images from a local checkout of this repo.

> **If you just want to run a released version**, prefer the **[instance-repo pattern](../documents/INSTANCE-REPO-TEMPLATE/)** — copy the template, pin an `IMAGE_TAG` to a published release, and deploy the GHCR-hosted image. That path doesn't need a full source checkout or a Cloud Build setup. Come back here if you want to build from source (hacking on a fork, cutting a private patch build, or standing up an environment before a release exists).

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌──────────────┐
│  Frontend   │  /api/  │  Backend    │  Unix   │  Cloud SQL   │
│  Cloud Run  │ ──────▶ │  Cloud Run  │ socket  │  Postgres    │
│  (nginx)    │         │  (Express)  │ ──────▶ │              │
└─────────────┘         └─────────────┘         └──────────────┘
```

- Frontend is an nginx-served static SPA that proxies `/api/*` to the backend service.
- Backend is the Express API.
- Postgres runs on Cloud SQL, connected via Unix socket.
- Secrets (session secret, DB password) live in Secret Manager.

## Prerequisites

1. A GCP account with billing enabled.
2. `gcloud` CLI installed locally:
   ```
   brew install google-cloud-sdk
   gcloud auth login
   gcloud auth application-default login
   ```
3. Docker installed (only needed if you want to test the prod images locally).

## File storage

Audio uploads and build artifacts are stored in a Cloud Storage bucket
(`<project-id>-wanderline-uploads`) so they survive Cloud Run instance restarts.
The setup script provisions the bucket and grants the Cloud Run service account
`storage.objectAdmin` on it.

Local development uses the filesystem (under `/tmp/wanderline-storage` by
default, override with `STORAGE_ROOT`). Switch with `STORAGE_BACKEND=local|gcs`.

## Logging

The backend uses [pino](https://getpino.io) for structured logging. In
production, every log line is JSON written to stdout, which Cloud Logging
parses automatically:

- Pino's numeric level is mapped to a `severity` string Cloud Logging
  understands (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`).
- The message lives in `message` (not pino's default `msg`), which is the
  field Cloud Logging promotes into the entry's main display.
- Each request gets a child logger (`req.log`) with a generated request id
  via [pino-http](https://github.com/pinojs/pino-http), so all logs from a
  single request can be filtered together.

Locally, logs are pretty-printed with timestamps and colors via
`pino-pretty`. Set `LOG_LEVEL=debug` to see more detail; the default is
`info`. In tests (`NODE_ENV=test`) the logger is silent.

View production logs:

```
gcloud run services logs read wanderline-backend --region=us-west1 --limit=50
```

Or filter by severity in the Cloud Logging console:

```
resource.type="cloud_run_revision"
resource.labels.service_name="wanderline-backend"
severity>=ERROR
```

## Error tracking (Sentry)

Both the backend and the editor frontend integrate with Sentry, but
**only when DSNs are set** — without them, Sentry is a no-op, which is
the default for local dev and CI.

### Enabling Sentry in production

1. Create a Sentry project (Node.js for the backend, React for the
   frontend) and copy the DSN for each.
2. Set the backend DSN on the running Cloud Run service:
   ```
   gcloud run services update wanderline-backend \
     --region=us-west1 \
     --update-env-vars=SENTRY_DSN=https://...@sentry.io/123,SENTRY_ENVIRONMENT=production
   ```
   `deploy-backend.sh` preserves these env vars across redeploys; you only
   set them once. `SENTRY_RELEASE` is set automatically to the deployed
   commit's short SHA so Sentry can group errors by release.
3. For the frontend, build with the Sentry env vars baked in. Vite
   inlines anything prefixed `VITE_*`:
   ```
   VITE_SENTRY_DSN=https://...@sentry.io/456 \
   VITE_SENTRY_ENVIRONMENT=production \
     ./scripts/deploy/deploy-frontend.sh
   ```

### What gets captured

- Backend: unhandled exceptions in Express routes (via the Sentry error
  handler registered after all routes), plus anything explicitly passed
  to `Sentry.captureException()`.
- Frontend: errors caught by the top-level `Sentry.ErrorBoundary` in
  `main.tsx`, plus uncaught exceptions / unhandled promise rejections.

`sendDefaultPii` is set to `false` in both clients, so request bodies,
cookies, and user IPs are not sent to Sentry. Tracing is off by default
— set `SENTRY_TRACES_SAMPLE_RATE` (backend) or
`VITE_SENTRY_TRACES_SAMPLE_RATE` (frontend) to a value in `[0, 1]` to
turn it on. Vite only inlines `VITE_*` env vars, hence the prefix
difference; values outside that range or non-numeric strings fall back
to 0.

## Database migrations

Schema changes live in `backend/migrations/` as numbered SQL files using
[node-pg-migrate](https://salsita.github.io/node-pg-migrate/). The runner is
called from `initializeDatabase()` on backend startup, so any new migration in
the deployed image gets applied automatically before the server begins serving
traffic.

To create a new migration:

```
cd backend
npm run migrate:create -- add-some-column
```

This drops a `migrations/<timestamp>_add-some-column.sql` file. Edit it with
the schema change (`ALTER TABLE ...`, `CREATE INDEX ...`, etc.) and commit
alongside the code that depends on it.

To apply migrations against a local DB (without booting the backend):

```
DATABASE_URL=postgresql://wanderline:wanderline_dev@localhost:5432/wanderline \
  npm run migrate -- up
```

The migration tool tracks applied migrations in a `pgmigrations` table. On
first deploy against an existing database (one that pre-dates this tooling),
the bootstrap step marks the baseline migration as applied so the existing
schema isn't re-run.

## One-time setup

### 1. Create a GCP project

In the GCP console: create a new project and enable billing on it.

```
gcloud projects create wanderline-prod --name="Wanderline"
gcloud config set project wanderline-prod
```

(Use whatever project ID you like — `wanderline-prod` is just an example.)

Link a billing account in the console: **Billing → Link a billing account**.

### 2. Run the setup script

This enables required APIs, creates the Cloud SQL instance, the database, the user, and stores secrets in Secret Manager.

```
PROJECT_ID=wanderline-prod REGION=us-west1 ./scripts/deploy/setup-gcp.sh
```

**Region tip:** pick something close to your users. `us-west1`, `us-central1`, `europe-west1`, `northamerica-northeast1` (Montreal) all work. Whatever you pick, use the same value for backend and frontend deploys.

The script takes ~5 minutes the first time (Cloud SQL provisioning is slow).

### 3. Deploy the backend

```
PROJECT_ID=wanderline-prod REGION=us-west1 ./scripts/deploy/deploy-backend.sh
```

It builds the prod Docker image via Cloud Build, pushes to Artifact Registry (tagged with the git SHA, the `package.json` version, and `latest`), and deploys to Cloud Run with the Cloud SQL connection wired up. At the end you'll see:

```
URL: https://wanderline-backend-abc123-uw.a.run.app
```

### 4. Deploy the frontend

```
PROJECT_ID=wanderline-prod REGION=us-west1 ./scripts/deploy/deploy-frontend.sh
```

The script auto-detects the backend URL and bakes it into the nginx config at runtime. You'll get:

```
URL: https://wanderline-frontend-xyz789-uw.a.run.app
```

### 5. Update CORS to allow the frontend

The deploy script prints the exact command — run it with the frontend URL from step 4:

```
gcloud run services update wanderline-backend \
  --region=us-west1 \
  --update-env-vars=CORS_ORIGIN=https://wanderline-frontend-xyz789-uw.a.run.app
```

### 6. Visit the frontend URL

You should see the setup screen prompting you to create the first admin account.

## Updates

To redeploy after code changes:

```
./scripts/deploy/deploy-backend.sh    # if backend changed
./scripts/deploy/deploy-frontend.sh   # if frontend changed
```

Each deploy creates a new revision tagged with the current git SHA. Cloud Run keeps older revisions for instant rollback. Each push also publishes `:<package.json version>` and `:latest` tags in Artifact Registry, but Cloud Run is always pinned to the SHA tag (immutable) so a rollback or redeploy points at exactly the image that built from that commit.

## Custom domain

To use `wanderline.example.com` instead of the `.run.app` URL:

1. **Verify domain ownership** in the GCP console (Domain Mappings).
2. **Map the domain** to the frontend service:
   ```
   gcloud run domain-mappings create \
     --service=wanderline-frontend \
     --domain=wanderline.example.com \
     --region=us-west1
   ```
3. Add the DNS records GCP shows you (CNAME or A records).
4. Update the backend's `CORS_ORIGIN` to the new domain.

## Cost estimate

Rough monthly cost for low/idle traffic:

- **Cloud SQL db-f1-micro**: ~$8/mo (this is the dominant cost since it doesn't scale to zero)
- **Cloud Run frontend + backend**: ~$0–$2/mo at low traffic (scales to zero)
- **Secret Manager + Artifact Registry + Cloud Build**: pennies

Total: **~$10/mo** for a hobby-scale deployment with no traffic. Going to a `db-g1-small` instance roughly doubles the SQL cost.

## Troubleshooting

### "Permission denied" during setup

You probably need the `Owner` or `Editor` role on the project. The script needs to enable APIs and create resources across multiple services.

### Backend fails to connect to Cloud SQL

Check the Cloud Run service has the Cloud SQL instance attached:

```
gcloud run services describe wanderline-backend --region=us-west1 --format='value(spec.template.metadata.annotations)'
```

Look for `run.googleapis.com/cloudsql-instances`.

### Frontend can't reach backend

Check the deployed `BACKEND_URL` env var on the frontend service:

```
gcloud run services describe wanderline-frontend --region=us-west1 --format='value(spec.template.spec.containers[0].env)'
```

It should match the backend's `.run.app` URL exactly (with `https://`, no trailing slash).

### Session cookies don't persist

In production, cookies are set with `secure: true`. They only work over HTTPS — and Cloud Run URLs are always HTTPS, so this should "just work." If you're seeing 401s after login, check that `CORS_ORIGIN` includes the exact frontend URL (no trailing slash) and that the backend's session middleware sees the request.

## Tearing down

If you want to remove everything:

```
gcloud run services delete wanderline-backend --region=us-west1
gcloud run services delete wanderline-frontend --region=us-west1
gcloud sql instances delete wanderline-db
gcloud secrets delete session-secret
gcloud secrets delete db-password
gcloud artifacts repositories delete wanderline --location=us-west1
```

Or just delete the whole project to remove every resource and billing.

# Wanderline instance

This repo is a single Wanderline instance. It doesn't contain the app source — the app is [`wanderline`](https://github.com/edenthecat/wanderline), consumed here as published Docker images. This repo owns:

- Which release tag we're on
- The GCP project + Cloud SQL instance identifiers
- The Cloud Run service names + region
- Secret wiring
- The upgrade runbook

Story content (audio, ink source, characters) lives in Postgres + GCS at runtime — not in git.

## Deploying

Assumes you have:

- A GCP project with Cloud Run + Cloud SQL + GCS enabled
- A service account with permissions to deploy to Cloud Run + access the SQL instance
- The `gcloud` CLI authenticated (`gcloud auth login`)
- The secrets set up in Secret Manager (`session-secret`, `db-password`)

```bash
# Pin the release we're deploying.
export IMAGE_TAG=1.2.3

# The rest is instance config.
export PROJECT_ID=my-wanderline-instance
export REGION=us-west1
export BACKEND_SERVICE=wanderline-backend
export FRONTEND_SERVICE=wanderline-frontend

./scripts/deploy-backend.sh
./scripts/deploy-frontend.sh
```

## Upgrading

Same script, new tag. The workflow is:

1. Read the [core release notes](https://github.com/edenthecat/wanderline/releases) for the tag you're moving to. Look for breaking migration notes.
2. Update `IMAGE_TAG` in your deploy env / `.env.production`.
3. **Run migrations first** if the release includes DB changes:
   ```bash
   ./scripts/run-migrations.sh
   ```
4. Deploy backend, verify `/health` returns 200, then deploy frontend.
5. Watch Cloud Run + Sentry logs for the first few minutes.

## Rollback

Every published image also carries a `sha-XXXXXXXX` tag. To roll back to a specific commit (e.g. the previous release's SHA):

```bash
IMAGE_TAG=sha-abc12345 ./scripts/deploy-backend.sh
```

For a migration-inclusive rollback you'll need a Postgres restore too — schema changes generally don't reverse cleanly.

## Layout

```
.
├── README.md                    # this file
├── .env.production.example      # instance env vars (COPY, don't edit in place)
├── scripts/
│   ├── deploy-backend.sh        # gcloud run deploy for backend at $IMAGE_TAG
│   ├── deploy-frontend.sh       # same, for frontend
│   └── run-migrations.sh        # one-off Cloud Run Job that runs migrate
├── documents/
│   ├── gcp-cost-runbook.md      # cost controls (moved from core)
│   └── security-hardening-review.md
└── .github/
    └── workflows/
        └── auto-deploy.yml      # optional: on push to main, redeploy
```

**None of this repo's contents ship in a public release.** This is the private instance layer. If you're mirroring the model for your own deployment, fork this structure — don't fork the core repo.

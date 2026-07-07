# Release process

Wanderline follows a two-repo, open-core model:

- **Core (this repo)** — source, tests, images. A tag on `main` builds and publishes Docker images to GHCR.
- **Instance repo (private, per-deployment)** — no source, only config. Deploys pull the published image at a pinned tag.

This doc covers cutting a core release. See the instance-repo skeleton under [`documents/INSTANCE-REPO-TEMPLATE/`](./INSTANCE-REPO-TEMPLATE/) for how a deployment consumes the release.

## Semver conventions

- **`vMAJOR.MINOR.PATCH`** — production release. Gets tagged `MAJOR.MINOR.PATCH` + `latest`.
- **`vMAJOR.MINOR.PATCH-rc.N`** — release candidate. Gets tagged as-is, no `latest`.
- **`vMAJOR.MINOR.PATCH-alpha.N` / `-beta.N`** — pre-release. Same handling as `-rc.N`.

Every build also carries a `sha-XXXXXXXX` tag so an instance can pin to an exact commit when a rollback is needed between releases.

## Cutting a release

1. **Land the release-worthy commits on `main`.** Run the full test suite locally — CI budget is constrained.
2. **Bump the version** in `package.json` at the repo root:
   ```bash
   npm version --no-git-tag-version 1.2.3
   ```
3. **Update the changelog** if there is one (there isn't yet — TODO if we adopt one).
4. **Commit + tag + push:**
   ```bash
   git add package.json
   git commit -m "Release 1.2.3"
   git tag v1.2.3
   git push origin main v1.2.3
   ```
5. The [`Release`](../.github/workflows/release.yml) workflow triggers on the tag:
   - Builds `wanderline-backend:1.2.3` and `wanderline-frontend:1.2.3` in parallel.
   - Also tags each image as `sha-XXXXXXXX` and (for non-prereleases) `latest`.
   - Publishes to `ghcr.io/<owner>/wanderline-<service>`.
6. **After all three tags are published**, the workflow's `smoke` job stands up a fresh Postgres and runs `npm run migrate` from the published backend image against an empty DB. **If it fails, the release is broken.** Roll back by deleting the tag on GHCR (or leave it and cut a `-hotfix.1`).

## Local rebuild

Use [`scripts/release/build-images.sh`](../scripts/release/build-images.sh) to rebuild a release locally — handy when the CI environment shifts but the source hasn't:

```bash
docker login ghcr.io
REGISTRY=ghcr.io/edenthecat TAG=1.2.3 ./scripts/release/build-images.sh
```

Set `PUSH=false` to build-only for a smoke test.

## Publishing to Artifact Registry (Google Cloud)

Instances running on Cloud Run may prefer pulling from Artifact Registry instead of GHCR (per-project IAM, no PAT scoping). Same script, different registry:

```bash
gcloud auth configure-docker <region>-docker.pkg.dev
REGISTRY=<region>-docker.pkg.dev/<project>/wanderline TAG=1.2.3 \
  ./scripts/release/build-images.sh
```

## Verifying a release without publishing

Before cutting a real tag, you can dry-run the whole flow locally:

```bash
# Build without pushing
PUSH=false REGISTRY=local TAG=1.2.3 ./scripts/release/build-images.sh

# Smoke-test migrations against a throwaway Postgres
docker network create smoke && \
docker run -d --name pg --network smoke \
  -e POSTGRES_DB=wanderline -e POSTGRES_USER=wanderline -e POSTGRES_PASSWORD=x \
  postgres:16-alpine && \
sleep 5 && \
docker run --rm --network smoke \
  -e DATABASE_URL='postgres://wanderline:x@pg:5432/wanderline' \
  local/wanderline-backend:1.2.3 npm run migrate && \
docker rm -f pg && docker network rm smoke
```

## What a release does NOT include

- **Story content** — Wanderline stories (audio, ink source, characters) live in an instance's Postgres + GCS. They ship separately from the release.
- **Instance secrets** — session secrets, DB passwords, Sentry DSNs. Those live in the instance repo (Secret Manager, `.env.production`).
- **Instance-specific config** — Cloud Run service names, region, project ID. Instance repo territory.

See [`INSTANCE-REPO-TEMPLATE/`](./INSTANCE-REPO-TEMPLATE/) for what a deployment repo looks like.

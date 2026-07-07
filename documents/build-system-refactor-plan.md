# Build System Refactor Plan

## Current state (2026-07-01)

Since this plan was first drafted, several phases have shipped incrementally:

- **Phase 1 (Extract Services) — DONE.** `story-data-builder.ts`, `audio-processor.ts`, `ink-converter.ts`, `diff-reporter.ts` all live in `backend/src/services/`. `projects.ts` is now 496 lines.
- **Phase 2 (Split Routes) — DONE.** `projects-story.ts`, `projects-settings.ts`, `projects-export.ts`, `projects-builds.ts`, `projects-preview.ts`, `projects-snapshots.ts`, `projects-collaborators.ts` are all in place.
- **Phase 4 (Player app) — PARTIALLY DONE.** The player is canonical (`player-app/`) and its pre-built `dist/` is baked into the image (see `PLAYER_APP_DIST` in `build-service.ts`). Not yet done: versioned bundles in GCS, SRI hashes, per-build player-version pinning.
- **Everything else — NOT DONE.** Builds still run in-process (`executeBuild(...)` fired off with `.catch(...)` from the POST handler on `projects-builds.ts:258`); artifacts still live under `/tmp/wanderline-builds`; `MAX_BUILDS_PER_PROJECT = 5` is a hard constant; no `pinned` / `deleted_at` / `idempotency_key` / worker-lease columns; no signed-URL downloads; no SSE progress; no CSP on preview; no rate limits.

The remaining work in this doc — Phases 3, 5, 5.5, 6, 7, 8, 9 — is the actual scope of epic ****.

## Original problem statement (historical)

`projects.ts` was 4,941 lines containing ALL project routes + app generation + preview. The player code was implemented twice:
- `generatePlayerAppCode()` (~1,335 lines of React/TypeScript as a template string)
- `generatePreviewHtml()` (~870 lines of vanilla JS/HTML)

Story data building was duplicated 3x. Audio processing was duplicated 2x. All of that is fixed.

## Goals

1. **Unified code**: Generated apps and preview use identical player code
2. **Retention window of builds per project** (default 5, configurable per project; not a hard schema cap)
3. **Preview builds in-browser**: View any saved build, versioned against the player bundle it was built with
4. **Test suite**: Run tests on generated apps
5. **File size auditing**: Total, audio, code, plus a per-file manifest so authors can see which nodes/audio dominate the payload
6. **Download from index**: Browse and download builds

## Scalability constraints

Wanderline runs on **Cloud Run** (northamerica-northeast1) with autoscaling to N instances + **Postgres**. That environment shapes every design decision below:

- Cloud Run instances are **ephemeral** — anything on local disk vanishes at scale-down. Build artifacts must live in **GCS**, not the container filesystem.
- Cloud Run request timeout maxes at 60 min but defaults to ~5 min; a large build (100+ audio files + WAV→MP3) can exceed request lifetime. Build orchestration cannot happen inside the request that starts the build.
- With autoscaling, a naive job runner can **pick up the same job on two instances**. Every job transition needs a distributed lease.
- Downloads and preview traffic served through the Cloud Run app pay egress + CPU for every byte. Big files (archives, audio) should be **redirected to signed GCS URLs**, not streamed through the API.
- Postgres connections are precious under autoscaling — long polling for job status will eat the pool. Prefer SSE with an idle timeout, or short-poll with `If-None-Match`/ETag.

## Architecture

### Unified Player

Upgrade `player-app/` to be THE canonical player. Both preview and generated apps use the same code.

- **Generated apps**: Bundle `public/story.json` + `public/audio/*`, player fetches `./story.json`
- **Preview**: Backend injects `window.__WANDERLINE_STORY__ = {...}` and serves pre-built player bundle
- **Story data loading priority**: `window.__WANDERLINE_STORY__` > `?story=` URL param > `./story.json` > demo

The `audioBaseUrl` field in StoryData handles the path difference:
- Generated apps: `./audio/`
- Preview: `/api/projects/:id/preview/audio/`

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS project_builds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    build_number INTEGER NOT NULL,                       -- allocated via project_build_seq (below)
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    progress INTEGER NOT NULL DEFAULT 0,
    step TEXT,                                            -- structured step id, e.g. 'audio.convert' — for i18n + metrics
    message TEXT,                                         -- optional human-readable detail
    error TEXT,
    label VARCHAR(255),
    build_type VARCHAR(20) NOT NULL DEFAULT 'source'
        CHECK (build_type IN ('source', 'dist')),

    -- Sizing / audit
    total_size_bytes BIGINT,
    audio_size_bytes BIGINT,
    code_size_bytes BIGINT,
    audio_file_count INTEGER,
    node_count INTEGER,
    manifest_gcs_uri TEXT,                                -- per-file breakdown for the audit view

    -- Artifact storage (GCS, not local disk)
    artifact_gcs_uri TEXT,                                -- gs://wanderline-builds/{project_id}/{build_id}.zip
    artifact_content_hash VARCHAR(64),                    -- sha256 of artifact for dedup / integrity
    player_bundle_version VARCHAR(64) NOT NULL,           -- e.g. 'player-2026.06.16-a3f9b12' — the bundle this build shipped against

    -- Snapshots (both story graph AND settings, for reproducible re-preview)
    story_snapshot_hash VARCHAR(64) NOT NULL,             -- sha256 of canonical story_graph JSON
    story_snapshot_gcs_uri TEXT,                          -- pointer to the immutable snapshot blob
    settings_snapshot JSONB NOT NULL,

    -- Idempotency
    idempotency_key VARCHAR(128),                         -- client-supplied; scoped per (project_id, key)

    -- Distributed job coordination
    worker_id VARCHAR(64),                                -- Cloud Run instance id that leased the job
    leased_until TIMESTAMP WITH TIME ZONE,                -- lease expiry; another worker may steal after this
    attempt_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    UNIQUE(project_id, build_number),
    UNIQUE(project_id, idempotency_key)                   -- same key returns the same build row
);

-- Per-project build numbering — atomic allocation, no application-side races.
CREATE TABLE IF NOT EXISTS project_build_counters (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1
);

-- List/pagination and queue-scan queries.
CREATE INDEX idx_project_builds_project_created ON project_builds(project_id, created_at DESC);
CREATE INDEX idx_project_builds_queued          ON project_builds(status, created_at)
    WHERE status IN ('queued', 'processing');            -- partial index: worker scan is O(open jobs)

-- Content-hash dedup: same story + settings hash → reuse artifact.
CREATE INDEX idx_project_builds_dedup ON project_builds(project_id, story_snapshot_hash, artifact_content_hash)
    WHERE status = 'completed';
```

### Artifact storage (GCS)

- Bucket: `gs://wanderline-builds/` (versioning ON, lifecycle rules ON)
- Layout:
  - `snapshots/{project_id}/{story_snapshot_hash}.json` — canonical story JSON, dedup-friendly
  - `builds/{project_id}/{build_id}.zip` — the artifact
  - `builds/{project_id}/{build_id}.manifest.json` — per-file sizing breakdown
  - `player-bundles/{version}/player.js` (+ `.css`, `.html` shell) — served with `Cache-Control: public, max-age=31536000, immutable`
- Downloads: API returns a **307 redirect to a V4 signed URL** (~10 min TTL) rather than streaming through Cloud Run.
- Audio preview: same signed-URL redirect pattern (no more `IMMUTABLE_AUDIO_CACHE_CONTROL` proxying through the API).
- Retention: lifecycle rule deletes objects when the DB row is deleted (soft-delete flag on the row → nightly reconciliation job hard-deletes GCS objects).

### Job execution (out-of-band worker)

Builds do NOT run inside the HTTP request that creates them.

- `POST /builds` enqueues by INSERTing a row with `status='queued'` and either publishes to Pub/Sub `wanderline-builds` OR relies on the worker poll below (Pub/Sub preferred).
- A **Cloud Run Job** (or a dedicated Cloud Run service with min-instances=1) runs the worker loop:
  1. Claim: `UPDATE project_builds SET status='processing', worker_id=$1, leased_until=NOW()+interval '5 min', started_at=NOW(), attempt_count=attempt_count+1 WHERE id = (SELECT id FROM project_builds WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *;`
  2. Renew lease every 60s while running.
  3. On success: `status='completed'`, write artifact URIs, publish `build.completed` to Pub/Sub.
  4. On crash / lease expiry: another worker picks it up. `attempt_count` bounds retries (max 3, then `status='failed'`).
- **Idempotency**: the enqueue endpoint accepts `Idempotency-Key` header. Duplicate keys return the existing build row's `202` instead of creating a new one.
- **Dedup**: before enqueue, look up completed builds with matching `(project_id, story_snapshot_hash, settings_snapshot_hash)` — if the story + settings haven't changed since the last successful build, return that build's ID with `X-Wanderline-Dedup: story-hash-match`.

### Player bundle versioning

- Each release of `player-app/` builds to `player-bundles/{version}/` at CI time, uploaded to GCS by the deploy script.
- `project_builds.player_bundle_version` records the exact bundle used, so previewing an old build reconstructs its original player — no regressions when the player evolves.
- The preview HTML shell for a build references the bundle by that version; `Cache-Control: immutable` because filenames are content-hashed.
- Current-state preview (`/preview`) always uses the latest bundle.

### Progress streaming

- Client uses **SSE**: `GET /builds/:id/events` streams `{status, progress, step, message}` frames.
- Server side: worker writes updates to Postgres AND publishes to a Redis pub/sub channel `build:{id}` (or Postgres `LISTEN/NOTIFY` for a lower-dep stack). SSE handler subscribes and forwards.
- Fallback: `GET /builds/:id` returns the latest row snapshot with an `ETag` header; clients that can't use SSE short-poll with `If-None-Match`.

### Retention & quotas

- Per-project retention window (default 5) enforced by a nightly job (not the enqueue path): soft-delete builds beyond N, keep any explicitly `pinned=TRUE` build.
- Add `pinned BOOLEAN NOT NULL DEFAULT FALSE` to `project_builds` — user-marked builds are exempt from retention.
- Soft-delete: `deleted_at TIMESTAMP` on the row; GCS objects are removed by the reconciliation job 24h later so accidental deletes have a recovery window.
- Per-org quota (org-wide max builds, max artifact bytes) enforced at enqueue.

### Observability

Every build emits structured events:
- `build.queued`, `build.started`, `build.step.{start,end}`, `build.completed`, `build.failed`
- Labels: `project_id`, `build_id`, `player_bundle_version`, `attempt_count`, `duration_ms`, `total_size_bytes`
- Cloud Monitoring dashboard: p50/p95 build duration, queue depth, worker lease-expiry rate, dedup hit rate.
- Alerts: queue depth > N for > 5 min, worker lease-expiry rate > 5%, failure rate > 10%.

## Security review

Findings against the architecture above. Severity: **H** (must fix before ship), **M** (fix in initial rollout), **L** (harden over time).

### Authorization

- **[H] ACL check on every build endpoint.** Every route in the endpoints table — enqueue, list, get, events, cancel, pin, delete, download, manifest, preview — must verify `req.user` has role on `project_id`. This is currently implicit; make it a route-level middleware (`requireProjectRole('editor')`) so it can't be forgotten. Enqueue + mutations require editor; get/list/preview/download require viewer.
- **[H] Signed-URL issuance re-checks ACL.** The `/download` and `/preview` handlers must re-check ACL immediately before signing. A stale session that lost project access must not be able to sign a URL.
- **[M] Cross-project ID confusion.** Reject if `:buildId` doesn't belong to `:projectId` (400, not 404 — 404 leaks existence). Same rule for the story snapshot hash: never expose it in responses to callers without access to the owning project.
- **[M] Preview session as a capability.** Preview HTML fetches signed audio URLs. Prefer server-signed URLs proxied at each play (307 → signed) with the caller's session cookie proving authz, over inlining long-lived signed URLs into the story JSON. The latter turns the preview URL into a shareable capability that outlives revocation.

### Signed URLs

- **[H] Short TTL, per-object scope.** V4 signed URLs, 10-min TTL, `GET`-only, scoped to the specific object path. Never sign a prefix or bucket-level URL.
- **[H] No `public-read` fallback on the builds bucket.** Enforce uniform bucket-level access; disable object ACLs; block all public access at the bucket level. `player-bundles/` is the *only* public-cacheable prefix, and even that should be served through a CDN with authenticated origin, not directly public.
- **[M] Bind to content when it matters.** For the artifact download, sign with `x-goog-content-md5` so a URL that leaks can't be swapped to a different artifact by an attacker with bucket-write access.
- **[M] Suppress referrer.** Preview HTML sets `<meta name="referrer" content="no-referrer">` so signed URLs don't leak via `Referer` when the story links out.
- **[L] Audit signed-URL issuance.** Log `{user_id, project_id, build_id, resource, exp}` for every signing call. This is the forensics path if a URL leaks.

### Bucket configuration

- **[H] Uniform bucket-level access ON.** Disables object ACLs, single source of truth for permissions.
- **[H] CORS locked to app origins.** The builds bucket's CORS `AllowedOrigins` is `https://wanderline-frontend-*.run.app` + the custom domain, not `*`. Player bundles bucket: same list.
- **[H] Bucket-level `publicAccessPrevention = enforced`.** Belt-and-braces against a future misconfig accidentally making an object public.
- **[M] Access logging enabled** on the builds bucket, exported to a log bucket with retention.
- **[M] Retention lifecycle rules keyed to a label, not age.** Lifecycle rule "delete objects older than 30 days" will nuke live-referenced snapshots. Instead, the reconciliation job sets a `pending-delete=true` label and lifecycle deletes objects with that label after 24h. Guarantees no live object is auto-collected.
- **[L] Separate buckets for snapshots vs. artifacts vs. player bundles.** Different sensitivity + different lifecycle. Simpler perms.

### Worker & least privilege

- **[H] Separate service account per component.**
  - Backend (Cloud Run): read/write `project_builds`, sign URLs, read snapshots + player bundles. NO delete on GCS objects.
  - Worker (Cloud Run Job): read snapshots, write builds + manifests, update `project_builds`. NO ability to sign URLs.
  - Reconciliation job: delete GCS objects with `pending-delete=true` label only. Scoped by object prefix.
  - CI (player bundle upload): write to `player-bundles/{version}/` only, no delete.
- **[H] Separate Postgres roles.** Backend role: full CRUD on the app tables. Worker role: `SELECT` on `projects` / `project_stories`, `SELECT/UPDATE` on `project_builds` (no `DELETE`), `SELECT/UPDATE` on `project_build_counters`. Reconciliation role: `SELECT/UPDATE` on `project_builds` (soft-delete → hard-delete transition only).
- **[H] Worker network egress restricted.** Worker only needs Postgres (private IP via VPC connector) + GCS. Deny all other egress via a VPC egress firewall — prevents a compromised transcoder from exfiltrating.
- **[M] Cloud Run per-request memory + CPU caps** on the worker; separate limits for the transcode step vs. the pack step.

### Input validation & parser hardening

- **[H] Uploaded audio must be sandboxed for transcode.** `ffmpeg` history includes CVEs where crafted input triggers heap corruption. Run transcoding with:
  - Wall-clock timeout per file (10 s default)
  - Memory ulimit (256 MB per file)
  - Output size cap (100 MB per file — cut off early on decompression bombs)
  - `ffmpeg` invoked with the file path as a single argv element via `execFile`, never a shell string. No user input in flags.
  - Input format allow-list (`.wav`, `.mp3`, `.ogg`); rejected by content sniff, not just extension.
- **[H] Zip slip / zip bomb defense.** When reading uploaded `.wanderline` archives with `yauzl`: reject entries whose normalized path escapes the target dir (`..` segments, absolute paths, drive letters, `//`), reject entries with `compressed_size < uncompressed_size / 100` (bomb heuristic), cap total uncompressed size.
- **[H] Ink / Twee parser DoS.** Parsers must have:
  - Max source size (5 MB pre-parse cap)
  - Max nesting depth (guard against choice-in-choice bombs)
  - Regex timeouts / re2 for any regex over user input (Node has no built-in — use `re2` or add a wall-clock timeout in the worker)
  - Max node count (10k) — reject at parse time, not at DB write time
- **[M] Directive allow-list.** Ink `INCLUDE` and any URL-fetching directives must be disabled or restricted to project-local paths. Twee `<<include>>` similarly.
- **[M] Reject non-UTF-8 source with a clear error.** Prevents encoding-based smuggling.

### Player bundle integrity

- **[H] Subresource Integrity (SRI) on the bundle.** Preview HTML shell references `player-bundles/{version}/player.js` with a `sha384-<hash>` SRI attribute. The bundle version row in `player_bundle_versions` (or wherever it's tracked) stores `sri_hash`. If someone tampers with the bundle in GCS, browsers refuse to run it.
- **[H] CI writes bundles once and never overwrites.** GCS "object generation" versioning ON; the CI SA has `storage.objects.create` but not `storage.objects.delete` or `storage.objects.update` on the bundles bucket. A malicious CI can add a new version but can't quietly replace an old one.
- **[M] Two-key promotion for the `latest` alias** (production player pointer). CI can upload; a manual step (or Cloud Deploy approval) flips `latest`. Prevents a compromised CI from instantly serving malicious player code to all users.

### Preview XSS + CSP

- **[H] Preview page CSP.** Serve the preview HTML with:
  ```
  Content-Security-Policy:
    default-src 'none';
    script-src 'self' https://storage.googleapis.com;
    style-src 'self';
    media-src 'self' https://storage.googleapis.com;
    img-src 'self' data: https://storage.googleapis.com;
    connect-src 'self' https://storage.googleapis.com;
    frame-ancestors 'none';
    base-uri 'none';
  ```
  Adjust origins to whatever CDN fronts GCS. No `'unsafe-inline'`, no `'unsafe-eval'`, no inline event handlers.
- **[H] Story content is untrusted.** Node text, choice labels, tags, node names — all user-authored, all rendered by the player. Player must render as text nodes (`textContent`) or React children, never `innerHTML` / `dangerouslySetInnerHTML`. Inline validator: unit test that renders a story containing `<script>` and `javascript:` URLs and asserts they appear as literal strings.
- **[H] `X-Frame-Options: DENY` on preview and download responses.** `frame-ancestors 'none'` above covers CSP-aware browsers; XFO covers legacy.
- **[M] Sanitize story name / label in HTML title.** The `<title>` of the preview shell should HTML-encode the project name; ditto anywhere user-provided text is interpolated into the shell.
- **[L] Player never follows arbitrary URLs.** If a story contains an audio URL field, restrict to the app's audio origins. Log + drop others.

### Idempotency abuse

- **[M] Scope idempotency key to `(project_id, created_by, key)`, not `(project_id, key)`.** Otherwise a collaborator with editor role could return a different user's build result via key collision. Update the UNIQUE constraint accordingly.
- **[M] Idempotency window.** Only match keys created in the last 7 days. Older keys don't dedup; they mint a new build. Prevents ancient stale results from resurfacing.
- **[L] Reject empty / all-whitespace keys.** Also cap length (128 chars already, enforce at validation layer).

### Rate limiting & abuse

- **[H] Per-user + per-project rate limits on `POST /builds`.** Suggested defaults: 10 builds / user / hour, 20 / project / hour. Return `429` with `Retry-After`. Enforce at middleware, before enqueue.
- **[H] Per-user cap on concurrent SSE connections.** Cap at ~5. SSE holds a Cloud Run request slot; without a cap, a single user can exhaust instance connection budget.
- **[M] Per-org artifact-bytes quota.** Prevents runaway builds from bankrupting the storage budget. Enforce at enqueue.
- **[M] Cancel + delete rate-limited too.** Anti-thrash: no more than 60 mutations / user / hour across the builds surface.
- **[L] Cloud Armor** at the LB layer for coarse IP-level rate limiting on unauthenticated paths (there shouldn't be any on the builds surface, but defense-in-depth).

### Reconciliation & race conditions

- **[H] Re-read row inside the delete transaction.** The reconciliation job must re-check `deleted_at IS NOT NULL AND deleted_at < NOW() - interval '24 hours'` inside the same transaction that deletes the GCS object, and only issue the delete if the row is still soft-deleted. Protects against un-delete races.
- **[M] Lease steal only after true expiry.** When a worker steals a lease, the `WHERE leased_until < NOW()` predicate must be inside the `UPDATE ... FOR UPDATE` — not fetched then updated separately. Otherwise two workers can both "steal" from an alive worker.
- **[M] Idempotent artifact writes.** Worker writes to `builds/{project_id}/{build_id}.zip` — that path is unique per build. But a retry after partial write must overwrite deterministically; use `x-goog-if-generation-match: 0` on first write, and delete + retry on retry. Prevents corrupt half-written artifacts from being served.

### Logging & PII

- **[M] Never log story content, source, audio URLs, or signed URLs.** Progress `message` field originates in the worker — must be a template ID + labels, not free text derived from user content. If it must include a filename, hash it.
- **[M] User IDs as UUIDs only.** Never email in labels/logs.
- **[L] Redact `Idempotency-Key` from request logs.** Not secret per se, but reduces cross-contamination risk if logs leak.

### Phase impact

- Phase 3 (artifact storage): implement CORS lock-down, uniform bucket-level access, `publicAccessPrevention`, per-component service accounts, signed-URL helper with 10-min TTL + content-md5 binding.
- Phase 4 (player app): compute + persist SRI hash per bundle version; CI SA no-delete/no-update.
- Phase 5 (worker): sandbox transcode + parser hardening + separate Postgres roles + VPC egress lock-down.
- Phase 6 (unified preview): CSP + XFO headers; verify no `dangerouslySetInnerHTML` reaches story content.
- Phase 7 (frontend): render every user-authored string as text; unit test asserts `<script>` in story content renders as literal text.
- Phase 8 (observability + limits): rate limits, quotas, per-signing audit log.
- Add a **Phase 5.5: Security hardening review** — internal review before opening builds to real projects. Checklist derived from this section.

### File Structure After Refactor

```
backend/src/routes/
  projects.ts           -- ~400 lines: CRUD only
  projects-story.ts     -- ink upload, story editing
  projects-settings.ts  -- settings get/patch
  projects-export.ts    -- .wanderline archive, ink export, script-diff
  projects-builds.ts    -- build management routes

backend/src/services/
  story-data-builder.ts  -- builds StoryData from DB (was duplicated 3x)
  audio-processor.ts     -- audio collection, WAV-to-MP3 conversion (was duplicated 2x)
  build-service.ts       -- orchestrates build pipeline
  preview-service.ts     -- generates preview HTML shell
  ink-converter.ts       -- extracted convertStoryGraphToInk()
  diff-reporter.ts       -- extracted diff report generation
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/projects/:id/builds` | Enqueue a build. Accepts `Idempotency-Key` header. Returns `202` with the build row (existing row if key matches, or dedup match on story+settings hash). |
| `GET` | `/api/projects/:id/builds` | Paginated list. Supports `?cursor=` (opaque) and `?pinned_only=1`. Excludes soft-deleted. |
| `GET` | `/api/projects/:id/builds/:buildId` | Row snapshot with `ETag`; supports `If-None-Match` for cheap polling. |
| `GET` | `/api/projects/:id/builds/:buildId/events` | **SSE** stream of `{status, progress, step, message}` frames until terminal state, then closes. |
| `POST` | `/api/projects/:id/builds/:buildId/cancel` | Cooperative cancel — sets `status='cancelled'`; worker checks between steps. |
| `POST` | `/api/projects/:id/builds/:buildId/pin` | Toggle `pinned` (exempts from retention). |
| `DELETE` | `/api/projects/:id/builds/:buildId` | Soft-delete (24h reconciliation removes GCS objects). |
| `GET` | `/api/projects/:id/builds/:buildId/download` | **307 → signed GCS URL** for the `.zip` artifact. |
| `GET` | `/api/projects/:id/builds/:buildId/manifest` | Per-file sizing breakdown JSON. |
| `GET` | `/api/projects/:id/builds/:buildId/preview` | HTML shell hard-coded to the build's `player_bundle_version`; injects `story_snapshot_gcs_uri` via signed URL, not inline JSON. |
| `GET` | `/api/projects/:id/preview` | Live preview (current state) — uses latest bundle. |

## Implementation Phases

Order chosen so that in-request builds are eliminated before the surface area grows. Every phase leaves the app shippable.

### Phase 1: Extract Services
1. Create `story-data-builder.ts` — extract duplicated story data building
2. Create `audio-processor.ts` — extract duplicated audio processing
3. Create `ink-converter.ts` — extract `convertStoryGraphToInk()`
4. Create `diff-reporter.ts` — extract diff report functions
5. Update `projects.ts` to call services
6. Bug fix: return proper 404/400 (via `StoryDataError`) instead of generic 500 for missing project / missing story

### Phase 2: Split Routes
1. Create `projects-story.ts` — move ink upload + story editing routes
2. Create `projects-settings.ts` — move settings routes
3. Create `projects-export.ts` — move export routes
4. Slim down `projects.ts` to CRUD + delegation

### Phase 3: Artifact storage foundation (new, scalability prerequisite)
1. Provision `gs://wanderline-builds` with versioning + lifecycle rules
2. Add `services/gcs.ts` — signed-URL helper, upload helper, delete helper
3. Add `services/snapshot-store.ts` — content-addressed storage for story JSON + settings
4. Migrate the existing preview audio path to signed-URL redirects (behind a feature flag so we can revert)
5. Load test: signed-URL redirect vs. proxied stream — confirm egress + p95 wins

### Phase 4: Upgrade Player App
1. Port features from `generatePlayerAppCode` into `player-app/src/App.tsx`
2. Extract hooks: `useAudioCache.ts`, `useBackgroundMusic.ts`, `useVoiceover.ts`
3. Add `storyLoader.ts` with loading priority logic
4. CI: build player-app on tag, upload to `player-bundles/{version}/`
5. Write tests

### Phase 5: DB schema + out-of-band worker
1. Migrate `project_builds` + `project_build_counters` + indexes
2. Add `build-service.ts` (enqueue + dedup + idempotency logic)
3. Add `build-worker.ts` — separate Cloud Run Job / service that leases from `project_builds` with `FOR UPDATE SKIP LOCKED`
4. Wire Pub/Sub (or `LISTEN/NOTIFY`) for lease-wakeup + progress fanout
5. Add `projects-builds.ts` with the endpoints above (redirect-based downloads, SSE progress)
6. Retention job (Cloud Scheduler → Cloud Run Job): enforce per-project retention window
7. Reconciliation job: hard-delete GCS objects for rows soft-deleted > 24h ago

### Phase 6: Unified Preview
1. Serve player bundle + HTML shell instead of inline JS
2. Build-preview endpoint pins the shell to the build's `player_bundle_version`
3. Story JSON delivered via signed-URL fetch, not inline injection
4. Remove `generatePreviewHtml()` and `generatePlayerAppCode()`

### Phase 7: Frontend Build Management UI
1. Build index panel in project view (pagination via cursor, pin toggle)
2. SSE progress with polling fallback
3. Download → follow 307 redirect to GCS
4. File-size audit display: total + per-file breakdown from manifest
5. Cancel + delete affordances

### Phase 8: Observability + limits
1. Structured event emission (`build.queued` → `build.completed`)
2. Cloud Monitoring dashboard + alerts (queue depth, lease-expiry rate, failure rate)
3. Per-org quotas (max builds, max artifact bytes) enforced at enqueue
4. Rate limiting on `POST /builds` (per-user + per-project)

### Phase 9: Cleanup
1. Remove old generate routes
2. Remove in-memory `generationJobs` Map
3. Clean up old build directories from local disk / any leftover Cloud Run volumes
4. Remove the Phase-3 feature flag on signed-URL audio (assuming it stuck)
5. Update API docs

## Deliberately out of scope (candidates for v2)

- **Cross-region GCS replication** — one-region storage until we have EU/APAC authors
- **Streaming preview** (no zip step for the preview path) — nice, not required
- **Per-user player-bundle A/B testing** — requires bundle version to be a request param rather than a build column
- **Public share links for builds** — signed URL infra is ready, but the auth surface is a separate ticket

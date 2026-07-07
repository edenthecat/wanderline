# Wanderline

[![CI](https://github.com/edenthecat/wanderline/actions/workflows/ci.yml/badge.svg)](https://github.com/edenthecat/wanderline/actions/workflows/ci.yml)
[![CodeQL](https://github.com/edenthecat/wanderline/actions/workflows/codeql.yml/badge.svg)](https://github.com/edenthecat/wanderline/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Wanderline turns branching-narrative source files into audio-first, choice-driven web apps. You upload an [**Ink**](https://www.inklestudios.com/ink/) (`.ink`) or [**Twee 3**](https://github.com/iftechfoundation/twine-specs/blob/master/twee-3-specification.md) (`.tw*`) story, attach voiceover / music / choice-indicator audio, and the tooling generates a standalone player app the reader can listen to and navigate with keyboard, on-screen buttons, or Bluetooth headphone controls with no screen at all.

The project is a single npm-workspaces monorepo covering four packages:

| Package       | What it is                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`    | Express + Postgres API. Ink / Twee parsers, story graph storage, [Whisper](https://github.com/ggerganov/whisper.cpp) transcription, audio ingest, Yjs collab server, build pipeline, GCS-backed downloads. |
| `frontend/`   | React + Vite editor UI. Uploads, node-detail editor, real-time collaborative editing (Yjs), theme designer, preview.                                                                                       |
| `player-app/` | Standalone React player. Ships as a static bundle inside every generated project. Handles playback, keyboard / MediaSession / wired-IEM headphone controls, save slots, and offline caching.               |
| `shared/`     | Types + helpers cross-consumed by the three above.                                                                                                                                                         |

The player runtime and editor are decoupled: the editor uploads source + audio; a build job produces a versioned player bundle + story data; the reader loads the bundle from the built project's URL.

## Capabilities

- **Ink 3 + Twee 3 in the same editor.** The parser branch determines the source language and the emitter round-trips back to the format you uploaded (with cross-format export as an escape hatch).
- **Audio-first playback.** Voiceover per node, background music per project, distinct indicators for each choice. Choice selection maps to configurable Bluetooth transport actions (`nexttrack` / `previoustrack` / `play`).
- **Real-time collaborative editing.** Node content, choice text, and settings edits sync across every editor tab open on the project (Yjs + WebSocket + Postgres persistence via a shadow-saver).
- **Theme designer.** Per-component CSS-variable overrides (page / header / storyCard / choiceButton / instructionsCard / startButton / settingsPanel / resumePicker / errorBanner) with a font picker (any Google Font), live preview, and light/dark surface variants.
- **Build pipeline.** Each build is a pinnable, downloadable snapshot: story JSON + audio + player bundle + integrity hashes. Retention + soft-delete + idempotent dedup keep the pipeline fast under repeat edits.
- **Deploy-ready.** Ships as two published Docker images (backend / frontend); the player-app bundle bakes into the backend. Deploy targets Google Cloud Run + Cloud SQL — see the [Release process](documents/RELEASE-PROCESS.md) and [instance-repo skeleton](documents/INSTANCE-REPO-TEMPLATE/).

## Quick start

The fastest path is Docker Compose — Postgres + backend + frontend come up together:

```bash
docker compose up
```

This starts:

- **PostgreSQL** on port 5432
- **Backend API** on http://localhost:3001
- **Frontend editor** on http://localhost:3000

You'll be walked through creating an admin account on first load.

## Local dev without Docker

If you'd rather run the pieces on the host:

```bash
# Prereqs: Node 20, Postgres 16, ffmpeg on PATH.
# .env files in each workspace; see .env.example for the shape.

npm ci
npm run build --workspace=shared

# Terminal 1: Postgres via Docker
docker compose up postgres

# Terminal 2: backend
npm run dev --workspace=backend        # http://localhost:3001

# Terminal 3: editor
npm run dev --workspace=frontend       # http://localhost:3000

# Terminal 4: player (only if you want to iterate on player-runtime code)
npm run dev --workspace=player-app     # http://localhost:3002
```

## Running the tests

CI runs the same commands:

```bash
npm run lint
npm run format:check
npm run build                          # builds all four workspaces
npm test --workspace=backend           # jest — parsers, routes, services
npm test --workspace=frontend          # vitest — hooks + api client
npm test --workspace=player-app        # vitest — player runtime bits
npm run test:e2e                       # cypress — needs a running stack
```

## Environment variables

Both apps read from `.env` files at their workspace root; commit-safe examples are checked in as `.env.example`.

**Backend:**

- `PORT` — default `3001`
- `DATABASE_URL` — PostgreSQL connection string
- `NODE_ENV` — `development` / `production`
- `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS` — audio storage in prod; local dev writes to `uploads/`
- `USE_SIGNED_URL_DOWNLOADS` — when `true`, download endpoints return 307 redirects to GCS-signed URLs (cost mitigation for high-bandwidth downloads)

**Frontend:**

- `VITE_API_URL` — backend API URL. Leave empty to use relative URLs via the nginx proxy in production.
- `VITE_API_TARGET` — dev-server proxy target (default `http://localhost:3001`)

**Player-app:**

- Reads its story data at runtime from a `window.STORY_DATA` global that the preview / build routes inject, so it has no build-time env vars beyond `VITE_API_URL` for asset paths.

## Ink + Twee handling (short version)

A project can be authored in either **Ink** or **Twee 3**. Both feed the same internal `story_graph` shape.

- Upload endpoints: `POST /api/projects/:id/ink`, `POST /api/projects/:id/ink-json`, `POST /api/projects/:id/twine`
- Export endpoints: `GET /api/projects/:id/exports/ink`, `GET /api/projects/:id/exports/twee` (cross-format re-emits from the graph)
- The UI adapts vocabulary to the source language (Ink: _knot / stitch / choice / divert_; Twee: _passage / link / continue_), overridable via `Settings → Nomenclature`.

The uploader sniffs by extension **and** content. Twine 2 published `.html` archives (`<tw-storydata>` wrapper) are rejected up front with a targeted "export as Twee 3 first" message.

## API surface

The full OpenAPI spec is generated from `@openapi` JSDoc blocks and available at `/api/docs` when the backend runs (`GET /api` returns the routing map).

Top-level: `/api/projects`, `/api/audio`, `/api/builds`, `/api/preview`, `/api/invitations`, `/api/auth`, `/api/setup`.

Health check: `GET /health`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, style expectations, and testing setup.

For security issues, please **do not** open a public GitHub issue. See [SECURITY.md](SECURITY.md) for the private disclosure path.

## Deployment

Wanderline follows an **open-core** model: this repo is the core (source, tests, images); an **instance repo** holds config + secrets and consumes published images from GHCR. Cutting a `v*.*.*` tag on `main` triggers CI to build `wanderline-backend` and `wanderline-frontend` at that tag, publish both to `ghcr.io/<owner>/wanderline-*`, and smoke-test the migrations against a fresh Postgres.

- **[Release process](documents/RELEASE-PROCESS.md)** — semver conventions, tag → publish, local rebuild, cross-registry publishing.
- **[Instance repo skeleton](documents/INSTANCE-REPO-TEMPLATE/)** — copy-paste starting point for standing up a deployment against published images.
- **[Build-from-source deploy guide](docs/DEPLOY.md)** — end-to-end walkthrough for building images from a local checkout and deploying to Cloud Run + Cloud SQL. Use when you're hacking on a fork or want to deploy before a release exists.

## License

[MIT](LICENSE). Copyright © 2026 Eden Rohatensky.

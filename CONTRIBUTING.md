# Contributing to Wanderline

Thanks for looking at Wanderline. This is a small project maintained by one person in evenings and weekends — contributions are welcome but please expect a slower response rhythm than a full-time OSS project.

## Getting set up

The project is a single npm-workspaces monorepo covering four packages:

- `backend/` — Express API + Postgres (audio ingest, story graph, Whisper transcription, Yjs collab server)
- `frontend/` — React editor UI (Vite)
- `player-app/` — Standalone React app that plays generated stories
- `shared/` — Cross-package types + helpers

Node 20 pinned via `engines`. Fastest path:

```bash
# Docker Compose — spins up Postgres + backend + frontend
docker compose up

# Or run pieces individually:
npm ci
npm run build --workspace=shared
npm run dev --workspace=backend       # http://localhost:3001
npm run dev --workspace=frontend      # http://localhost:3000
npm run dev --workspace=player-app    # http://localhost:3002
```

## Filing issues

- **Bug reports**: use the [Bug report](.github/ISSUE_TEMPLATE/bug_report.md) template. Include reproduction steps, browser/OS, and a minimal Ink or Twee story if the parser or player is involved.
- **Feature requests**: use the [Feature request](.github/ISSUE_TEMPLATE/feature_request.md) template. If you're not sure whether an idea fits, open a discussion first — it's easier to iterate on scope than on a landed PR.

## Sending PRs

- Fork, branch, PR against `main`. Small focused PRs merge faster than large ones.
- Prefix commits + PR titles with the issue key when there is one (e.g. `Fix #42:` or the private ticket ref if you have access), otherwise a short descriptive prefix is fine.
- Run the checks locally before pushing — CI budget is constrained:
  ```bash
  npm run lint
  npm run format:check
  npm run test               # runs backend + player-app + frontend suites
  npm run build              # builds all four workspaces
  ```
- Open PRs as **drafts** while you're iterating. Un-draft when you're ready for review + CI.

## Style + conventions

- **Comments**: describe the _why_, not the _what_. Well-named identifiers cover the what. Skip narrating the current task or which PR added a line — that belongs in the PR description and rots as the code evolves.
- **Tests**: real integration where practical (backend hits a real Postgres via Docker Compose in CI). Unit tests via Jest (backend) or Vitest (frontend + player-app).
- **No `any`** without a written reason. `strictNullChecks` is on.
- **No committed secrets, ever.** `.env*` is gitignored and there's a `pr-safety` workflow gate. If a secret leaks, rotate first, then rewrite history.

## Security

Please **do not** file security issues as public GitHub issues. See [SECURITY.md](SECURITY.md) for the private disclosure path.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

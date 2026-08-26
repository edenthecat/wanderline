// What version of Wanderline is this process actually running?
//
// Added after a production incident of a very boring kind: the
// instance repo recorded IMAGE_TAG=1.0.2 while the running services
// had been deployed to 1.4.0 by hand. Nothing surfaced the mismatch,
// so the only way to establish the truth was to diff the live API
// surface against a local checkout. A deployment that can't tell you
// what it's running makes every rollback a guess.
//
// Deliberately does NOT use import.meta.url to locate package.json:
// ts-jest's default-esm preset can't parse it, which is why
// build-service.ts can't be imported from a test at all (see the note
// atop build-html.test.ts). Candidate paths off process.cwd() cover
// both layouts we actually ship:
//
//   prod  — WORKDIR /app, `node backend/dist/index.js`  -> backend/package.json
//   dev   — docker-compose mounts ./backend at /app     -> package.json

import { readFileSync } from 'fs';
import { join } from 'path';

export interface AppVersion {
  /** Semver from backend/package.json, or 'unknown' if unreadable. */
  version: string;
  /** Git SHA the image was built from; null when not deployed by the scripts. */
  commit: string | null;
  /** 'production' / 'development' / 'test'. */
  environment: string;
}

const PACKAGE_JSON_CANDIDATES = ['backend/package.json', 'package.json'];

/**
 * Pure resolver, exported for tests: takes a reader so a suite can
 * exercise the fallback chain without touching the filesystem.
 */
export function resolveAppVersion(
  readFile: (path: string) => string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): AppVersion {
  let version = 'unknown';
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      const parsed = JSON.parse(readFile(join(cwd, candidate))) as { version?: unknown };
      // Guard the shape: a package.json without a version string is
      // more likely the wrong file (the repo root's, say) than a
      // package we should report 'undefined' for.
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        version = parsed.version;
        break;
      }
    } catch {
      // Missing or malformed — try the next candidate.
    }
  }

  // deploy-backend.sh sets SENTRY_RELEASE to the deployed commit's
  // short SHA. Reusing it avoids inventing a second env var that the
  // deploy scripts would have to learn to set.
  const commit = env.SENTRY_RELEASE?.trim() || null;

  return {
    version,
    commit,
    environment: env.NODE_ENV || 'development',
  };
}

// Resolved once: package.json can't change under a running process,
// and this is read on every editor page load.
let cached: AppVersion | null = null;

export function getAppVersion(): AppVersion {
  if (!cached) {
    cached = resolveAppVersion((p) => readFileSync(p, 'utf-8'), process.env, process.cwd());
  }
  return cached;
}

/** Test seam — drops the memoised value. */
export function resetAppVersionForTests(): void {
  cached = null;
}

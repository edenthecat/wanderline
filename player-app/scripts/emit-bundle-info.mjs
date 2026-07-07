#!/usr/bin/env node
// DEV-132: emit dist/bundle-info.json after `vite build`.
//
// Purpose: give the backend a deterministic way to record which player
// bundle each project build shipped against. Slice 1 of Phase 4 only
// reads `version` + the main script's SRI hash and writes them into
// project_builds. Later slices (SRI in the preview shell, per-build
// preview pinned to a bundle version) consume the same file.
//
// Output shape (dist/bundle-info.json):
//   {
//     "version": "0.1.0-abc1234"   | "0.1.0"      (see below),
//     "mainScript": "assets/index-<hash>.js",
//     "sriAlgorithm": "sha384",
//     "sriHash": "sha384-<base64>",
//     "scripts": [
//       { "path": "assets/index-<hash>.js", "sriHash": "sha384-<base64>", "sizeBytes": 12345 }
//     ]
//   }
//
// Deliberately no buildTime / other clock-driven fields — the emitter
// output must be byte-identical for two `vite build` runs off the
// same commit + env so a CI cache keyed on dist/ still hits. Identity
// info that varies per run belongs in the build LOG, not the artifact.
//
// Version resolution order:
//   1. PLAYER_APP_VERSION env var — CI injects this (e.g. release tag).
//   2. `<pkgVersion>-<gitShortSha>` — local dev + PR builds; git is
//      available and reproducible per-commit.
//   3. `<pkgVersion>` bare — final fallback when no git and no env.
//
// SRI: sha384 over the raw file bytes, base64-encoded. Matches the
// `integrity` attribute browsers verify on <script> / <link> tags.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep as pathSep } from 'node:path';

// Every path we ship in bundle-info.json is web-style (forward slash),
// matching the "assets/index-<hash>.js" documentation above. On Linux/
// macOS this is what node.path returns already; on Windows the same
// APIs use `\`, which would corrupt the JSON and break the pattern
// matching in findMainScript(). Normalise at every emission point.
function toWebPath(p) {
  return pathSep === '/' ? p : p.split(pathSep).join('/');
}

const __filename = fileURLToPath(import.meta.url);
const projectRoot = join(dirname(__filename), '..');
const distDir = join(projectRoot, 'dist');
const pkgPath = join(projectRoot, 'package.json');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function shortGitSha() {
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function resolveVersion() {
  const envVersion = process.env.PLAYER_APP_VERSION;
  if (envVersion && envVersion.trim()) return envVersion.trim();
  const pkgVersion = readPackageVersion();
  const gitSha = shortGitSha();
  if (gitSha) return `${pkgVersion}-${gitSha}`;
  return pkgVersion;
}

// Walk dist/ recursively and yield every regular file path.
function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (entry.isFile()) yield p;
  }
}

function sriForFile(path) {
  const bytes = readFileSync(path);
  const digest = createHash('sha384').update(bytes).digest('base64');
  return { sriHash: `sha384-${digest}`, sizeBytes: bytes.length };
}

function findMainScript() {
  // Vite emits the entry chunk as assets/index-<hash>.js. Match on
  // that pattern; fall back to any .js under assets/ so a Vite config
  // change to `build.rollupOptions.output.entryFileNames` doesn't
  // silently drop main-script identification. Match on a web-path
  // COPY so the includes() check + regex behave identically on
  // Windows and POSIX; keep the original platform-native path for
  // file I/O below.
  const distDirWeb = toWebPath(distDir);
  const scripts = [];
  for (const p of walkFiles(distDir)) {
    const webPath = toWebPath(p);
    if (webPath.endsWith('.js') && webPath.includes(`${distDirWeb}/assets/`)) {
      scripts.push({ native: p, web: webPath });
    }
  }
  if (scripts.length === 0) return null;
  // Sort by web path so the readdirSync-order-dependent fallback is
  // deterministic — two `vite build` runs off the same commit must
  // produce the same mainScript pick even when the entry-chunk regex
  // misses.
  scripts.sort((a, b) => a.web.localeCompare(b.web));
  const indexed = scripts.find(({ web }) => /\/assets\/index-[^/]+\.js$/.test(web));
  return (indexed ?? scripts[0]).native;
}

function main() {
  try {
    statSync(distDir);
  } catch {
    console.error(`emit-bundle-info: dist/ not found at ${distDir}. Run 'vite build' first.`);
    process.exit(1);
  }

  const mainScript = findMainScript();
  if (!mainScript) {
    console.error('emit-bundle-info: no JS bundle found under dist/assets/.');
    process.exit(1);
  }

  const scripts = [];
  for (const p of walkFiles(distDir)) {
    if (p.endsWith('.js')) {
      const { sriHash, sizeBytes } = sriForFile(p);
      scripts.push({
        // Every persisted path is web-style — see toWebPath's rationale.
        path: toWebPath(relative(distDir, p)),
        sriHash,
        sizeBytes,
      });
    }
  }
  scripts.sort((a, b) => a.path.localeCompare(b.path));

  // Renamed from `main` to avoid shadowing the enclosing function.
  const mainEntry = sriForFile(mainScript);

  const info = {
    version: resolveVersion(),
    mainScript: toWebPath(relative(distDir, mainScript)),
    sriAlgorithm: 'sha384',
    sriHash: mainEntry.sriHash,
    scripts,
  };

  const outPath = join(distDir, 'bundle-info.json');
  writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n');
  console.log(
    `emit-bundle-info: wrote ${relative(projectRoot, outPath)} (version=${info.version}, main=${info.mainScript})`,
  );
}

main();

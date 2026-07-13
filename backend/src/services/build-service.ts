import { Pool } from 'pg';
import archiver from 'archiver';
import { logger } from '../logger.js';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { buildStoryData } from './story-data-builder.js';
import { collectUsedAudioFilenames, processAudioForBuild } from './audio-processor.js';
import { getStorage, audioKey, buildArtifactKey, isStorageKey } from './storage.js';
import { deleteBuildPreviewCache } from './build-preview-audio.js';
import { storyHash } from './story-hash.js';
import { bundleGoogleFonts, renderThemeCss, type ThemeConfig } from './theme-render.js';
import { prepareDistHtml } from './build-html.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// The player-app dist baked into the image. Every deploy target
// (prod Dockerfile, dev docker-compose start-dev.sh) produces this
// before the backend starts. Missing dist is a deployment-config
// error, not a runtime fallback.
const PLAYER_APP_DIST =
  process.env.PLAYER_APP_DIST ||
  (existsSync('/player-app/dist')
    ? '/player-app/dist'
    : join(__dirname, '..', '..', '..', 'player-app', 'dist'));
const BUILDS_DIR = process.env.BUILDS_DIR || '/tmp/wanderline-builds';

/**
 * parse an env-var integer with a safe fallback + optional
 * lower-bound clamp. `parseInt('abc')` is NaN, and the ambient
 * `|| default` idiom only fires on empty string / null / undefined,
 * so an env var set to a non-integer string would slip through and
 * poison downstream math (Math.max(1, NaN) is NaN; comparisons
 * against NaN are always false). This helper returns the fallback
 * whenever the value doesn't produce a finite integer, and clamps
 * the result to `min` (default 1) so a `BUILD_RETENTION=0` or
 * `BUILD_RETENTION=-5` misconfig also lands at a sensible floor
 * instead of quietly disabling retention.
 *
 * Exported so unit tests can pin the fallback + clamp behaviour.
 */
export function parseIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

// retention default reduced from 5 → 3 and made
// env-configurable. Storage is small vs Cloud Run in the current
// bill (see documents/gcp-cost-runbook.md) but it's still recurring
// cost per project × time and the smaller cap means the
// auto-cull fires sooner, keeping the ext4 disk footprint down too.
// Ops override: BUILD_RETENTION=<n> on the Cloud Run env.
const MAX_BUILDS_PER_PROJECT = parseIntEnv('BUILD_RETENTION', 3);

export { MAX_BUILDS_PER_PROJECT, BUILDS_DIR };

/**
 * minimal shape of player-app/dist/bundle-info.json — the
 * post-build script (player-app/scripts/emit-bundle-info.mjs) writes
 * a superset of these fields. We only read version + sriHash today,
 * but the full schema is documented in that script's header comment.
 */
export interface PlayerBundleInfo {
  version: string;
  sriHash: string;
}

/**
 * read player-app/dist/bundle-info.json and pluck the
 * version + main-script SRI hash. Returns null on any failure
 * (file missing, JSON invalid, expected fields absent) so a bad
 * player release can't wedge the project build pipeline — the
 * project build succeeds without recording bundle metadata, and
 * a warn surfaces in logs.
 */
// Expected SRI algorithm for the persisted hash. sha384 balances
// browser support with collision resistance; keep in sync with
// emit-bundle-info.mjs's `sriAlgorithm` field. A mismatch here means
// the emitter drifted from the reader — surface it as a null return
// so a wrong-shape record never lands in project_builds.
const EXPECTED_SRI_PREFIX = 'sha384-';

export function readPlayerBundleInfo(distDir: string = PLAYER_APP_DIST): PlayerBundleInfo | null {
  const infoPath = join(distDir, 'bundle-info.json');
  if (!existsSync(infoPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(infoPath, 'utf8'));
  } catch (err) {
    logger.warn({ err, infoPath }, 'readPlayerBundleInfo: failed to parse bundle-info.json');
    return null;
  }
  // Shape violations are as alarming as parse failures — they mean
  // the emitter and reader disagree on schema. Warn consistently so
  // drift is visible in logs during a rollout.
  function reject(reason: string): null {
    logger.warn({ infoPath, reason }, 'readPlayerBundleInfo: shape violation');
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return reject('root is not an object');
  const rec = parsed as Record<string, unknown>;
  const version = rec.version;
  const sriHash = rec.sriHash;
  if (typeof version !== 'string' || typeof sriHash !== 'string') {
    return reject('version or sriHash is not a string');
  }
  const trimmedVersion = version.trim();
  const trimmedSri = sriHash.trim();
  if (!trimmedVersion || !trimmedSri) return reject('version or sriHash is blank');
  if (!trimmedSri.startsWith(EXPECTED_SRI_PREFIX)) {
    // Missing algorithm prefix = emitter shipped a hash under a
    // different (or unknown) algorithm. Don't persist a value the
    // preview shell will hand to <script integrity=...> unchanged.
    return reject(`sriHash missing expected "${EXPECTED_SRI_PREFIX}" prefix`);
  }
  return { version: trimmedVersion, sriHash: trimmedSri };
}

export interface BuildRecord {
  id: string;
  project_id: string;
  build_number: number;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
  label: string | null;
  // BIGINT columns — node-postgres returns these as strings to preserve
  // precision past Number.MAX_SAFE_INTEGER.
  total_size_bytes: string | null;
  audio_size_bytes: string | null;
  code_size_bytes: string | null;
  audio_file_count: number | null;
  node_count: number | null;
  artifact_path: string | null;
  created_at: string;
  completed_at: string | null;
  created_by: string | null;
  // pinning + soft-delete groundwork. Optional so test
  // fixtures don't have to declare the columns to type-check, and so
  // formatBuild's `pinned ?? false` fallback isn't a lie about the
  // BuildRecord shape. (At runtime the migration is applied before
  // any query fires — a real production row always has both columns.)
  pinned?: boolean;
  deleted_at?: string | null;
  // player bundle identity. Nullable because pre-migration
  // rows lack the columns and because readPlayerBundleInfo returns
  // null (best-effort) when dist/bundle-info.json can't be read —
  // recording bundle metadata never blocks the build from completing.
  player_bundle_version?: string | null;
  player_bundle_sri_hash?: string | null;
  // idempotency + attempt tracking + lease groundwork.
  // Optional because pre-migration rows lack the columns.
  idempotency_key?: string | null;
  attempt_count?: number;
  worker_id?: string | null;
  leased_until?: string | null;
}

// soft-deleted builds get this many hours before the reconciliation
// sweep hard-deletes them. Exposed for tests.
export const SOFT_DELETE_GRACE_HOURS = 24;

// (Phase 5): idempotency-key retries within this many days
// replay the same result. Older matches don't (the enqueue handler
// filters by created_at). 7 days matches the plan's contract.
export const IDEMPOTENCY_WINDOW_DAYS = 7;

// hard cap on retry attempts for a wedged input. On the third
// failure we stop and mark the row 'failed' so a poison input can't
// loop forever consuming worker capacity.
export const MAX_BUILD_ATTEMPTS = 3;

// For build sizes in bytes we're nowhere near MAX_SAFE_INTEGER (9 PB),
// so it's safe to coerce the BIGINT-as-string to a JS number for
// ergonomic downstream use in JSON responses.
function bigintToNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatBuild(row: BuildRecord) {
  return {
    id: row.id,
    buildNumber: row.build_number,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    label: row.label,
    totalSizeBytes: bigintToNumber(row.total_size_bytes),
    audioSizeBytes: bigintToNumber(row.audio_size_bytes),
    codeSizeBytes: bigintToNumber(row.code_size_bytes),
    audioFileCount: row.audio_file_count,
    nodeCount: row.node_count,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    pinned: row.pinned ?? false,
    // exposed so preview shells + the frontend build UI can
    // pin an SRI + display which bundle a historical build shipped
    // against. Both null for earlier rows.
    playerBundleVersion: row.player_bundle_version ?? null,
    playerBundleSriHash: row.player_bundle_sri_hash ?? null,
    // attempts + idempotency key surface. attempt_count is
    // always ≥1 on any live build (initial UPDATE bumps from 0), so
    // ?? 0 defends pre-migration rows only.
    attemptCount: row.attempt_count ?? 0,
    idempotencyKey: row.idempotency_key ?? null,
  };
}

export { formatBuild };

/**
 * Mark any builds left in pending/processing state as failed.
 * This handles server restarts/crashes during a build.
 */
export async function cleanupStaleBuilds(pool: Pool): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE project_builds SET status = 'failed', error = 'Server restarted during build', message = 'Build interrupted', completed_at = CURRENT_TIMESTAMP
       WHERE status IN ('pending', 'processing')
       RETURNING id`,
    );
    if (result.rows.length > 0) {
      logger.info({ count: result.rows.length }, 'Marked stale builds as failed');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup stale builds');
  }
}

/**
 * hard-delete a single build's DB row, then best-effort clean
 * up its artifact + preview cache.
 *
 * Ordering matters. The DB DELETE runs first, guarded by the
 * `deleted_at IS NOT NULL AND pinned = FALSE` invariant inside the
 * same statement. Only when that DELETE actually removes a row do we
 * touch external state — the `RETURNING artifact_path` gives us the
 * DB's authoritative artifact key, so a concurrent restore path
 * (planned) that clears `deleted_at` between the sweep's
 * SELECT and this call cannot leave a restored build with missing
 * files: the guarded DELETE returns zero rows, we short-circuit, and
 * the storage + preview cache stay untouched.
 *
 * Returns `true` when the DB row was actually deleted (i.e. the
 * cleanup path fired). Extracted for the reconciliation sweep + any
 * future admin-force-delete path.
 */
export async function hardDeleteBuild(pool: Pool, buildId: string): Promise<boolean> {
  const result = await pool.query<{ artifact_path: string | null }>(
    `DELETE FROM project_builds
      WHERE id = $1
        AND deleted_at IS NOT NULL
        AND pinned = FALSE
      RETURNING artifact_path`,
    [buildId],
  );
  if (result.rows.length === 0) {
    // Row didn't match the guard — likely restored between the sweep's
    // SELECT and this DELETE (or never soft-deleted / never existed).
    // Do NOT touch external state.
    return false;
  }
  const artifactPath = result.rows[0].artifact_path;
  if (artifactPath) {
    if (isStorageKey(artifactPath)) {
      try {
        await getStorage().delete(artifactPath);
      } catch (err) {
        logger.warn({ err, buildId }, 'hardDeleteBuild: storage delete failed');
      }
    } else if (existsSync(artifactPath)) {
      try {
        unlinkSync(artifactPath);
      } catch (err) {
        logger.warn({ err, buildId }, 'hardDeleteBuild: legacy artifact unlink failed');
      }
    }
  }
  // deleteBuildPreviewCache swallows internally; the try/catch is
  // belt-and-braces in case that contract ever changes.
  try {
    deleteBuildPreviewCache(buildId);
  } catch (err) {
    logger.warn({ err, buildId }, 'hardDeleteBuild: preview cache cleanup failed');
  }
  return true;
}

/**
 * reconciliation sweep — hard-delete builds soft-deleted more
 * than SOFT_DELETE_GRACE_HOURS ago. Runs alongside cleanupStaleBuilds
 * at server startup; a scheduled variant (Cloud Scheduler → Cloud Run
 * Job) is planned as part of but this startup-only sweep is
 * enough while builds sit on local disk.
 *
 * Pinned rows are irrelevant here — a build can only end up with a
 * non-null deleted_at via the soft-delete route, which unpins as it
 * marks deleted (see route handler). Explicit `AND pinned = FALSE`
 * defends against a future path that bypasses that.
 */
export async function reconcileSoftDeletedBuilds(pool: Pool): Promise<void> {
  try {
    // We SELECT only the ids of eligible rows; hardDeleteBuild
    // re-checks `deleted_at IS NOT NULL AND pinned = FALSE` inside its
    // guarded DELETE, so a row that gets restored / pinned between
    // this SELECT and the DELETE won't lose its DB row OR its files.
    // make_interval(hours => $1::int) instead of concatenating the
    // hours value into a string interval: safer if this ever becomes
    // env-driven (no SQL-injection footgun on the interval literal).
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM project_builds
        WHERE deleted_at IS NOT NULL
          AND deleted_at < NOW() - make_interval(hours => $1::int)
          AND pinned = FALSE`,
      [SOFT_DELETE_GRACE_HOURS],
    );
    let deletedCount = 0;
    for (const row of result.rows) {
      try {
        if (await hardDeleteBuild(pool, row.id)) deletedCount++;
      } catch (err) {
        logger.warn({ err, buildId: row.id }, 'reconcileSoftDeletedBuilds: row cleanup failed');
      }
    }
    if (deletedCount > 0) {
      logger.info(
        { count: deletedCount, considered: result.rows.length },
        'Reconciled soft-deleted builds',
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to reconcile soft-deleted builds');
  }
}

/**
 * Execute the build pipeline for a project.
 * Updates the build record in the database as it progresses.
 */
export async function executeBuild(pool: Pool, projectId: string, buildId: string): Promise<void> {
  const buildDir = join(BUILDS_DIR, `build_${buildId}`);
  const outputPath = join(BUILDS_DIR, `${buildId}.zip`);

  try {
    // Ensure builds directory exists
    mkdirSync(BUILDS_DIR, { recursive: true });

    // increment attempt_count on each executeBuild kickoff.
    // Also gates the transition on the current status being one that
    // hasn't reached a terminal state — a cancelled row must not be
    // silently transitioned back to 'processing'. Every subsequent
    // UPDATE in this function follows the same status-guard pattern.
    await pool.query(
      `UPDATE project_builds
          SET status = 'processing',
              progress = 10,
              message = 'Loading project data...',
              attempt_count = attempt_count + 1
        WHERE id = $1
          AND status IN ('pending', 'processing')`,
      [buildId],
    );

    const { storyData, audioFiles, fileMap, project } = await buildStoryData(pool, projectId, {
      audioBaseUrl: './audio/',
    });
    const projectName = (project as Record<string, unknown>).name as string;

    await pool.query(
      `UPDATE project_builds SET progress = 20, message = 'Processing audio files...' WHERE id = $1 AND status IN ('pending', 'processing')`,
      [buildId],
    );

    // Copy the prebuilt player dist baked into the image. Every
    // deploy target (prod Dockerfile, dev docker-compose
    // start-dev.sh) produces the dist before the backend starts;
    // a missing dist is a deployment-config error, not a runtime
    // fallback.
    if (!existsSync(join(PLAYER_APP_DIST, 'index.html'))) {
      throw new Error(
        `Player-app dist not found at ${PLAYER_APP_DIST}. Build player-app before starting the backend (see backend/start-dev.sh / Dockerfile).`,
      );
    }
    mkdirSync(join(buildDir, 'dist', 'audio'), { recursive: true });

    // Process audio files (copy + convert WAV to MP3)
    const settings = (project as Record<string, unknown>).settings || {};
    const usedFilenames = collectUsedAudioFilenames(
      storyData,
      settings as Record<string, unknown>,
      fileMap,
      storyData.backgroundMusic ?? [],
    );

    // Stage audio files from durable storage into the build's local audio dir.
    // processAudioForBuild expects local files (it runs ffmpeg on WAVs).
    const projectAudioDir = join(buildDir, '_audio_src');
    mkdirSync(projectAudioDir, { recursive: true });
    const storage = getStorage();
    for (const filename of usedFilenames) {
      // Defensive: filenames in audio_files should be UUID-derived (sanitized
      // by the upload route), but reject path separators here too so a bad
      // row can't escape projectAudioDir.
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        logger.warn({ filename }, 'Build: skipping audio file with unsafe name');
        continue;
      }
      try {
        const stream = await storage.downloadStream(audioKey(projectId, filename));
        await pipeline(stream, createWriteStream(join(projectAudioDir, filename)));
      } catch (err) {
        logger.warn({ err, filename }, 'Build: missing audio file in storage');
      }
    }

    const processedAudio = processAudioForBuild(storyData, audioFiles, fileMap, usedFilenames, {
      projectAudioDir,
      tempConvertDir: join(buildDir, '_audio_temp'),
      outputAudioDir: join(buildDir, 'dist', 'audio'),
    });

    writeFileSync(join(buildDir, 'dist', 'story.json'), JSON.stringify(storyData, null, 2));

    await pool.query(
      `UPDATE project_builds SET progress = 40, message = 'Writing project files...' WHERE id = $1 AND status IN ('pending', 'processing')`,
      [buildId],
    );

    const escapedName = escapeHtml(projectName);

    // Copy the prebuilt player dist. Skips the old npm install +
    // vite build (which OOM-killed Cloud Run on 512Mi and added
    // 60-90s of CPU/IO to every build).
    await pool.query(
      `UPDATE project_builds SET progress = 60, message = 'Copying player template...' WHERE id = $1 AND status IN ('pending', 'processing')`,
      [buildId],
    );
    copyDirRecursive(PLAYER_APP_DIST, join(buildDir, 'dist'));

    // Post-process index.html for file:// URL compatibility
    const distIndexPath = join(buildDir, 'dist', 'index.html');
    let distHtml = readFileSync(distIndexPath, 'utf-8');
    distHtml = prepareDistHtml(distHtml, {
      rewriteForPrebuiltDist: true,
      title: escapedName,
      storyData,
    });

    // bake the project's theme into the built bundle. Google
    // Fonts woff2 files (if any) are downloaded into public/fonts/
    // so the generated game works offline. The CSS sets variables on
    // :root + appends customCss; the player reads those variables via
    // `var(--wl-...)` for its themed surfaces.
    const themeConfig = (storyData as { settings?: { theme?: ThemeConfig } }).settings?.theme;
    if (themeConfig) {
      const fontsCss = await bundleGoogleFonts(themeConfig, join(buildDir, 'dist', 'fonts'));
      const themeCss = renderThemeCss(themeConfig);
      const parts: string[] = [];
      if (fontsCss) parts.push(`<style data-wanderline-fonts>\n${fontsCss}\n</style>`);
      if (themeCss) parts.push(`<style data-wanderline-theme>\n${themeCss}\n</style>`);
      if (parts.length > 0) {
        // Replacer function so any $-sequences inside the theme CSS
        // (e.g. a font name or custom CSS containing literal `$&`)
        // aren't interpreted as String.replace back-references.
        const injected = `${parts.join('\n')}\n</head>`;
        distHtml = distHtml.replace('</head>', () => injected);
      }
    }
    writeFileSync(distIndexPath, distHtml);

    // bake a self-contained smoke-test page into the build so
    // listeners (and the author) can open smoke.html in the unzipped
    // build and verify that story.json loads, every node target
    // resolves, and every referenced audio file is reachable from the
    // bundle. The runner is a single inline-JS page so it works on
    // file:// URLs and doesn't need any extra plumbing in the player.
    const smokeHtml = renderSmokeHtml(storyData);
    writeFileSync(join(buildDir, 'dist', 'smoke.html'), smokeHtml);

    await pool.query(
      `UPDATE project_builds SET progress = 90, message = 'Creating archive...' WHERE id = $1 AND status IN ('pending', 'processing')`,
      [buildId],
    );

    // Zip only the dist/ folder (ready-to-deploy artifact)
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = createWriteStream(outputPath);

    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);

      // Add dist files
      const distDir = join(buildDir, 'dist');
      const addDirToArchive = (dir: string, prefix: string = '') => {
        for (const file of readdirSync(dir)) {
          const filePath = join(dir, file);
          const archivePath = prefix ? `${prefix}/${file}` : file;
          if (statSync(filePath).isDirectory()) {
            addDirToArchive(filePath, archivePath);
          } else {
            archive.append(createReadStream(filePath), { name: archivePath });
          }
        }
      };
      addDirToArchive(distDir);

      // Add README
      archive.append(
        `# ${projectName}\n\nA Wanderline audio narrative.\n\n## Run Locally\n\nThis app needs a web server to run. Open a terminal in this folder and run:\n\n\`\`\`\nnpx serve\n\`\`\`\n\nThen open http://localhost:3000 in your browser.\n\n## Deploy Online\n\nUpload this entire folder to any static hosting service:\n- **Netlify**: Drag & drop at netlify.com/drop\n- **GitHub Pages**: Push to a repo and enable Pages\n\nNo build step required - these files are ready to serve!\n`,
        { name: 'README.md' },
      );

      archive.finalize();
    });

    // Upload zip to durable storage so it survives Cloud Run instance restarts.
    // artifact_path stores the storage key (e.g. "builds/<buildId>.zip"), which
    // the configured storage backend resolves to a GCS object or local file.
    const storageKey = buildArtifactKey(buildId);
    await getStorage().uploadFile(storageKey, outputPath, 'application/zip');

    // Calculate sizes and mark build complete BEFORE cleanup
    const zipStats = statSync(outputPath);
    const totalSizeBytes = zipStats.size;
    const nodeCount = Object.keys(storyData.nodes).length;

    // capture the player bundle identity the artifact shipped
    // against. Missing / invalid bundle-info yields null (best-
    // effort) plus a warning — the field is an audit trail, not a
    // build gate.
    const bundleInfo = readPlayerBundleInfo();
    if (!bundleInfo) {
      logger.warn(
        { buildId, playerAppDist: PLAYER_APP_DIST },
        ': bundle-info.json missing or invalid; player_bundle_version + sri unrecorded',
      );
    }

    // dedup hash over the raw story graph. Same input the
    // enqueue path hashes at incoming build time; a match on that
    // column short-circuits the whole pipeline. Nullish check (rather
    // than the earlier `!== undefined`) matches storyHash's own guard
    // — nulls come from the DB when the row is genuinely empty.
    const rawStoryGraph = (project as Record<string, unknown>).story_graph;
    const dedupHash = rawStoryGraph != null ? storyHash(rawStoryGraph) : null;

    try {
      // gate the completion UPDATE on the row still being
      // in a non-terminal state. If the user cancelled while the
      // pipeline ran, this UPDATE matches zero rows and we log the
      // completed-but-orphaned artifact for reclamation instead of
      // overwriting the 'cancelled' status.
      const completionResult = await pool.query(
        `UPDATE project_builds SET
          status = 'completed',
          progress = 100,
          message = 'Build complete',
          artifact_path = $2,
          total_size_bytes = $3,
          audio_size_bytes = $4,
          code_size_bytes = $5,
          audio_file_count = $6,
          node_count = $7,
          story_snapshot = $8::jsonb,
          player_bundle_version = $9,
          player_bundle_sri_hash = $10,
          story_snapshot_hash = $11,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND status IN ('pending', 'processing')
        RETURNING id`,
        [
          buildId,
          storageKey,
          totalSizeBytes,
          processedAudio.audioSizeBytes,
          Math.max(0, totalSizeBytes - processedAudio.audioSizeBytes),
          processedAudio.copiedCount,
          nodeCount,
          // Persist the exact story payload that landed in
          // public/story.json so /builds/:buildId/preview can render
          // the snapshot without unpacking the artifact.
          JSON.stringify(storyData),
          bundleInfo?.version ?? null,
          bundleInfo?.sriHash ?? null,
          dedupHash,
        ],
      );
      if (completionResult.rows.length === 0) {
        // Row was moved to a terminal state (cancelled) while the
        // pipeline was running. Ditch the artifact — no completed row
        // will ever point at it, so nobody can download it, and
        // leaving it behind wastes storage.
        logger.info(
          { event: 'build.orphan.reap', buildId, storageKey },
          ': build reached completion but row was already terminal; reaping orphan artifact',
        );
        await getStorage()
          .delete(storageKey)
          .catch(() => {});
      } else {
        logger.info({ event: 'build.completed', buildId, totalSizeBytes }, 'Build completed');
      }
    } catch (dbErr) {
      // DB update failed after we already pushed the zip to storage —
      // delete the orphaned object so we don't accumulate junk.
      logger.error({ err: dbErr }, 'Failed to record build, cleaning up orphaned artifact');
      await getStorage()
        .delete(storageKey)
        .catch(() => {});
      throw dbErr;
    }

    // Best-effort cleanup: remove build dir and the local zip (it's in storage now)
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {}
    try {
      unlinkSync(outputPath);
    } catch {}
  } catch (error) {
    // Cleanup on error
    if (existsSync(buildDir)) {
      try {
        rmSync(buildDir, { recursive: true, force: true });
      } catch {}
    }
    if (existsSync(outputPath)) {
      try {
        unlinkSync(outputPath);
      } catch {}
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // gate the failure UPDATE too — if the user cancelled
    // and we crashed after that, keep the 'cancelled' terminal state.
    await pool
      .query(
        `UPDATE project_builds SET status = 'failed', error = $2, message = 'Build failed', completed_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('pending', 'processing')`,
        [buildId, errorMessage],
      )
      .catch(() => {});

    logger.error({ event: 'build.failed', buildId, err: error }, 'Build failed');
  }
}

/**
 * Recursively copy `src` to `dst`. Used by the fast path to
 * stage the prebuilt player dist into a per-build directory we can
 * then template + zip. Filesystem-level copy is cheap (single-digit
 * milliseconds for the player bundle) compared to the npm-install
 * path it replaces (60-90s + 500MB+ of memory).
 */

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const srcPath = join(src, name);
    const dstPath = join(dst, name);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * — self-contained smoke-test page baked into every build.
 *
 * Renders a single HTML doc that, on load, walks the inlined story
 * data and reports three things to the page (and to console):
 *   1) Every node has either content, a divert, or choices.
 *   2) Every divert / choice target resolves to a real node (or one
 *      of the synthetic END/DONE sinks).
 *   3) Every referenced audio file is reachable from the bundle
 *      (GET request to ./audio/<filename> with cache:no-cache; HEAD
 *      isn't reliably allowed on file:// URLs so we use the smallest
 *      method that works in all target browsers).
 *
 * Designed to run on file://  — no fetch of story.json, no React, no
 * imports, no build step. Just paste into a browser, get a green
 * checkmark or a red list of issues.
 */
// Exported for the build-service unit tests; not part of the public
// build API (callers go through executeBuild).
export function renderSmokeHtml(storyData: unknown): string {
  const storyJsonStr = JSON.stringify(storyData)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const title = escapeHtml(
    ((storyData as { title?: string }).title ?? 'Wanderline build') + ' — smoke test',
  );
  // The runner is inlined as a regular <script> so file:// pages can
  // execute it without module-loader gymnastics.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
           background: #1a1a2e; color: #f5f5f5; margin: 0; padding: 2rem; }
    h1 { margin-top: 0; }
    .check { padding: 0.5rem 0.75rem; border-radius: 6px; margin: 0.5rem 0; }
    .check.pass { background: rgba(76,175,80,0.15); border-left: 3px solid #4caf50; }
    .check.fail { background: rgba(244,67,54,0.15); border-left: 3px solid #f44336; }
    .check h2 { margin: 0 0 0.25rem; font-size: 1rem; }
    ul.problems { margin: 0.25rem 0 0; padding-left: 1.25rem; font-size: 0.85rem; opacity: 0.85; }
    code { background: rgba(255,255,255,0.07); padding: 0 0.25rem; border-radius: 3px; }
    .summary { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
    .summary strong { font-size: 1.5rem; display: block; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="summary" id="summary">Running…</div>
  <div id="results"></div>
  <script>window.__WANDERLINE_STORY__=${storyJsonStr};</script>
  <script>
  (function () {
    var story = window.__WANDERLINE_STORY__ || {};
    var nodes = story.nodes || {};
    var nodeIds = Object.keys(nodes);
    var SYNTHETIC = { END: true, DONE: true };
    var checks = [];
    var passCount = 0;
    function record(label, problems) {
      var ok = problems.length === 0;
      if (ok) passCount++;
      checks.push({ label: label, ok: ok, problems: problems });
    }

    // 1) Node completeness
    var emptyNodes = [];
    nodeIds.forEach(function (id) {
      var n = nodes[id];
      var hasContent = Array.isArray(n.content) && n.content.length > 0;
      var hasChoices = Array.isArray(n.choices) && n.choices.length > 0;
      var hasDivert = typeof n.divert === 'string' && n.divert.length > 0;
      if (!hasContent && !hasChoices && !hasDivert) emptyNodes.push(id);
    });
    record('Every node has content, a divert, or choices', emptyNodes.map(function (id) {
      return 'Empty node: ' + id;
    }));

    // 2) Target resolution — Ink-style scoping. END / DONE are
    // synthetic; otherwise a target matches either a top-level node
    // id or a sibling stitch under the source's parent knot.
    var missingTargets = [];
    function resolveTarget(sourceId, target) {
      if (SYNTHETIC[target]) return true;
      if (Object.prototype.hasOwnProperty.call(nodes, target)) return true;
      var src = nodes[sourceId] || {};
      var knot = src.parent || sourceId;
      return Object.prototype.hasOwnProperty.call(nodes, knot + '.' + target);
    }
    nodeIds.forEach(function (id) {
      var n = nodes[id];
      if (n.divert && !resolveTarget(id, n.divert)) {
        missingTargets.push(id + ' diverts to ' + n.divert);
      }
      (n.choices || []).forEach(function (c, idx) {
        if (c && c.target && !resolveTarget(id, c.target)) {
          missingTargets.push(id + ' choice ' + (idx + 1) + ' → ' + c.target);
        }
      });
    });
    record('Every divert / choice target resolves', missingTargets);

    // 3) Audio reachability — fire HEAD requests in parallel and wait.
    var audioRefs = [];
    var seen = {};
    nodeIds.forEach(function (id) {
      var a = (nodes[id] || {}).audio || {};
      Object.keys(a).forEach(function (k) {
        var v = a[k];
        if (typeof v === 'string' && v && !seen[v]) {
          seen[v] = true;
          audioRefs.push(v);
        }
      });
    });
    var base = (story.audioBaseUrl || './audio/').replace(/\\/?$/, '/');
    Promise.all(audioRefs.map(function (filename) {
      // file:// HEAD isn't allowed in every browser; fall back to a
      // GET with no-cache and only treat network errors as failures.
      return fetch(base + filename, { method: 'GET', cache: 'no-cache' })
        .then(function (r) { return r.ok ? null : filename + ' (HTTP ' + r.status + ')'; })
        .catch(function () { return filename + ' (network error)'; });
    })).then(function (results) {
      var missing = results.filter(function (r) { return r !== null; });
      record('Every referenced audio file is reachable', missing);
      render();
    });

    function render() {
      var sum = document.getElementById('summary');
      sum.innerHTML = '<strong>' + passCount + ' / ' + checks.length + ' checks passing</strong>' +
        '<div>' + nodeIds.length + ' nodes · ' + audioRefs.length + ' audio refs</div>';
      var out = document.getElementById('results');
      out.innerHTML = checks.map(function (c) {
        var problemHtml = c.problems.length
          ? '<ul class="problems">' + c.problems.map(function (p) {
              return '<li><code>' + p.replace(/[<>&]/g, function (ch) {
                return ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' })[ch];
              }) + '</code></li>';
            }).join('') + '</ul>'
          : '';
        return '<div class="check ' + (c.ok ? 'pass' : 'fail') + '">' +
          '<h2>' + (c.ok ? '✓ ' : '✗ ') + c.label + '</h2>' + problemHtml + '</div>';
      }).join('');
      // Also log to console so headless smoke runners can capture it.
      console.log('[wanderline-smoke]', JSON.stringify({
        passing: passCount, total: checks.length,
        problems: checks.filter(function (c) { return !c.ok; })
      }));
    }
  })();
  </script>
</body>
</html>`;
}

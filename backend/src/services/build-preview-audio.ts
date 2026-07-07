import yauzl, { ZipFile, Entry } from 'yauzl';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import { join, dirname } from 'path';
import { Pool } from 'pg';
import { getStorage, isStorageKey } from './storage.js';
import { BUILDS_DIR } from './build-service.js';
import { logger } from '../logger.js';

// lazy audio extraction from build artifact zips.
//
// ships per-build preview that resolves audio against the
// CURRENT project's audio_files rows. That's fine for unchanged
// files, but a deleted clip or a WAV→MP3 conversion that happened
// at build time produces silent 404s in the preview. This module
// extracts the requested file out of the artifact zip on demand
// and caches it on local disk so subsequent requests are cheap.
//
// Cache layout: ${BUILDS_DIR}/preview_cache/<buildId>/<filename>
// (cleaned up by deleteBuildPreviewCache, called from DELETE
// /api/projects/:id/builds/:buildId).
//
// Concurrent extraction is de-duped via an in-flight Map keyed on
// the (buildId, filename) pair so two simultaneous /preview/audio/
// requests for the same file don't both open the zip.

const PREVIEW_CACHE_ROOT = () => join(BUILDS_DIR, 'preview_cache');
const previewCacheDir = (buildId: string) => join(PREVIEW_CACHE_ROOT(), buildId);

interface InFlight {
  promise: Promise<string | null>;
}
const inFlight = new Map<string, InFlight>();

function flightKey(buildId: string, filename: string) {
  return `${buildId}::${filename}`;
}

async function ensureArtifactOnDisk(artifactPath: string, buildId: string): Promise<string | null> {
  // Build artifacts live either on local disk (legacy / dev) or in
  // durable storage. For zip extraction we need a real file path; if
  // it's a storage key, materialise it into the per-build cache root.
  if (!isStorageKey(artifactPath)) {
    return existsSync(artifactPath) ? artifactPath : null;
  }
  const cacheDir = PREVIEW_CACHE_ROOT();
  mkdirSync(cacheDir, { recursive: true });
  const localZip = join(cacheDir, `${buildId}.zip`);
  if (existsSync(localZip)) return localZip;
  try {
    const stream = await getStorage().downloadStream(artifactPath);
    await pipeline(stream, createWriteStream(localZip));
    return localZip;
  } catch (err) {
    logger.warn({ err, buildId, artifactPath }, 'Failed to materialise build artifact for preview');
    try {
      rmSync(localZip, { force: true });
    } catch {
      // ignore
    }
    return null;
  }
}

function safeFilename(filename: string): boolean {
  // Build audio filenames are UUID-derived at upload time, so a
  // legitimate request never contains slashes or .. — reject anything
  // that does to avoid zip-slip via crafted requests.
  return !filename.includes('/') && !filename.includes('\\') && !filename.includes('..');
}

async function extractAudioEntry(
  zipPath: string,
  filename: string,
  destPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        logger.warn({ err, zipPath }, 'Failed to open build zip');
        resolve(false);
        return;
      }
      const closeAndResolve = (result: boolean) => {
        try {
          (zip as ZipFile).close();
        } catch {
          // ignore
        }
        resolve(result);
      };
      const target = `audio/${filename}`;
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName !== target) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (entryErr, readStream) => {
          if (entryErr || !readStream) {
            logger.warn({ err: entryErr }, 'Failed to read audio entry from build zip');
            closeAndResolve(false);
            return;
          }
          mkdirSync(dirname(destPath), { recursive: true });
          const writeStream = createWriteStream(destPath);
          readStream.on('error', () => closeAndResolve(false));
          writeStream.on('error', () => closeAndResolve(false));
          writeStream.on('close', () => closeAndResolve(true));
          readStream.pipe(writeStream);
        });
      });
      zip.on('end', () => closeAndResolve(false));
      zip.on('error', (zErr) => {
        logger.warn({ err: zErr }, 'Build zip error');
        closeAndResolve(false);
      });
      zip.readEntry();
    });
  });
}

/**
 * Resolve a single audio filename from a build's artifact zip,
 * caching the extracted bytes under preview_cache/<buildId>/. Returns
 * the absolute path to the cached file, or null if the file isn't in
 * the zip (or the zip can't be opened).
 */
export async function resolveBuildPreviewAudio(
  pool: Pool,
  buildId: string,
  filename: string,
): Promise<string | null> {
  if (!safeFilename(filename)) return null;

  const cachePath = join(previewCacheDir(buildId), filename);
  if (existsSync(cachePath)) return cachePath;

  const key = flightKey(buildId, filename);
  const existing = inFlight.get(key);
  if (existing) return existing.promise;

  const promise = (async (): Promise<string | null> => {
    const buildResult = await pool.query(
      `SELECT artifact_path, status FROM project_builds WHERE id = $1 LIMIT 1`,
      [buildId],
    );
    if (buildResult.rows.length === 0) return null;
    const row = buildResult.rows[0];
    if (row.status !== 'completed' || !row.artifact_path) return null;
    const zipPath = await ensureArtifactOnDisk(row.artifact_path, buildId);
    if (!zipPath) return null;
    const ok = await extractAudioEntry(zipPath, filename, cachePath);
    return ok ? cachePath : null;
  })();
  inFlight.set(key, { promise });
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Drop the per-build preview cache when a build is deleted. */
export function deleteBuildPreviewCache(buildId: string): void {
  const dir = previewCacheDir(buildId);
  const zip = join(PREVIEW_CACHE_ROOT(), `${buildId}.zip`);
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (existsSync(zip)) rmSync(zip, { force: true });
  } catch (err) {
    logger.warn({ err, buildId }, 'Failed to delete build preview cache');
  }
}

// Re-export so tests can resolve the expected on-disk path without
// reaching into the module's internals.
export const _testing = {
  previewCacheDir,
  cacheRoot: PREVIEW_CACHE_ROOT,
};

// Re-import for createReadStream consumers — yauzl returns a stream
// but the route handler also wants to stream the cached file back to
// the client. Export the helper so the route stays terse.
export { createReadStream };

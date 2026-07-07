import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import type { Pool } from 'pg';
import {
  resolveBuildPreviewAudio,
  deleteBuildPreviewCache,
  _testing,
} from '../build-preview-audio.js';

// verify the zip cache. The service is filesystem-heavy, so
// the suite builds a real artifact zip in a tmp dir and confirms the
// extractor pulls the right bytes out + caches them under
// preview_cache/<buildId>/.

let tmpRoot: string;
let prevBuildsDir: string | undefined;

async function makeZip(audioFiles: Array<{ name: string; content: string }>): Promise<string> {
  const zipPath = join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.zip`);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    for (const f of audioFiles) {
      archive.append(f.content, { name: `audio/${f.name}` });
    }
    archive.finalize();
  });
  return zipPath;
}

function makePool(handlers: Array<(sql: string, params: unknown[]) => unknown>): Pool {
  let i = 0;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const fn = handlers[i++];
    if (!fn) throw new Error(`unexpected query #${i}: ${sql.slice(0, 60)}`);
    return fn(sql, params ?? []);
  });
  return { query } as unknown as Pool;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wanderline-build-cache-'));
  prevBuildsDir = process.env.BUILDS_DIR;
  process.env.BUILDS_DIR = tmpRoot;
});

afterAll(() => {
  process.env.BUILDS_DIR = prevBuildsDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveBuildPreviewAudio', () => {
  it('returns null when the build does not exist', async () => {
    const pool = makePool([() => ({ rows: [] })]);
    const result = await resolveBuildPreviewAudio(pool, 'missing-build', 'a.mp3');
    expect(result).toBeNull();
  });

  it('returns null when the build is not completed', async () => {
    const pool = makePool([
      () => ({ rows: [{ artifact_path: '/whatever.zip', status: 'pending' }] }),
    ]);
    const result = await resolveBuildPreviewAudio(pool, 'b1', 'a.mp3');
    expect(result).toBeNull();
  });

  it('extracts the matching audio file from the build zip into the cache', async () => {
    const zipPath = await makeZip([
      { name: 'voice-1.mp3', content: 'bytes-for-voice-1' },
      { name: 'voice-2.mp3', content: 'bytes-for-voice-2' },
    ]);
    const pool = makePool([() => ({ rows: [{ artifact_path: zipPath, status: 'completed' }] })]);
    const result = await resolveBuildPreviewAudio(pool, 'b2', 'voice-1.mp3');
    expect(result).not.toBeNull();
    expect(readFileSync(result!, 'utf-8')).toBe('bytes-for-voice-1');
    // Path lives under preview_cache/<buildId>/
    expect(result).toBe(join(_testing.previewCacheDir('b2'), 'voice-1.mp3'));
  });

  it('serves a second request from the cache without re-querying the DB', async () => {
    const zipPath = await makeZip([{ name: 'cached.mp3', content: 'cache-me' }]);
    // First call uses 1 query; second call should bypass entirely
    // because the cached file exists on disk.
    const handlers = [() => ({ rows: [{ artifact_path: zipPath, status: 'completed' }] })];
    const pool = makePool(handlers);
    const first = await resolveBuildPreviewAudio(pool, 'b3', 'cached.mp3');
    expect(first).not.toBeNull();
    // No more handlers seeded — a second DB query would throw.
    const second = await resolveBuildPreviewAudio(pool, 'b3', 'cached.mp3');
    expect(second).toBe(first);
  });

  it('returns null when the requested filename is not in the zip', async () => {
    const zipPath = await makeZip([{ name: 'present.mp3', content: 'hi' }]);
    const pool = makePool([() => ({ rows: [{ artifact_path: zipPath, status: 'completed' }] })]);
    const result = await resolveBuildPreviewAudio(pool, 'b4', 'absent.mp3');
    expect(result).toBeNull();
  });

  it('rejects path-escaping filenames (zip-slip defence)', async () => {
    const zipPath = await makeZip([{ name: 'ok.mp3', content: 'hi' }]);
    const pool = makePool([() => ({ rows: [{ artifact_path: zipPath, status: 'completed' }] })]);
    // Even though the build row would otherwise be valid, a request
    // for ../etc/passwd must short-circuit BEFORE the DB roundtrip.
    const pool2 = makePool([]); // no handlers — any DB query would throw
    expect(await resolveBuildPreviewAudio(pool2, 'b5', '../etc/passwd')).toBeNull();
    expect(await resolveBuildPreviewAudio(pool2, 'b5', 'sub/dir.mp3')).toBeNull();
    // Sanity: the safe filename still works.
    const ok = await resolveBuildPreviewAudio(pool, 'b5', 'ok.mp3');
    expect(ok).not.toBeNull();
  });

  it('deleteBuildPreviewCache removes the extracted dir', async () => {
    const zipPath = await makeZip([{ name: 'del.mp3', content: 'bye' }]);
    const pool = makePool([() => ({ rows: [{ artifact_path: zipPath, status: 'completed' }] })]);
    const path = await resolveBuildPreviewAudio(pool, 'b6', 'del.mp3');
    expect(existsSync(path!)).toBe(true);
    deleteBuildPreviewCache('b6');
    expect(existsSync(path!)).toBe(false);
  });

  it('returns null when the artifact zip file is missing on disk', async () => {
    const pool = makePool([
      () => ({ rows: [{ artifact_path: join(tmpRoot, 'nope.zip'), status: 'completed' }] }),
    ]);
    expect(await resolveBuildPreviewAudio(pool, 'b7', 'a.mp3')).toBeNull();
  });
});

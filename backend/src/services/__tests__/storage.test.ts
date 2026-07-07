import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

import {
  getStorage,
  audioKey,
  buildArtifactKey,
  isStorageKey,
  resetStorageForTests,
  SIGNED_URL_MAX_TTL_SECONDS,
  SIGNED_URL_MIN_TTL_SECONDS,
  signedUrlDefaultTtlSeconds,
  useSignedUrlDownloads,
} from '../storage.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wanderline-storage-test-'));
  process.env.STORAGE_BACKEND = 'local';
  process.env.STORAGE_ROOT = tmpRoot;
  resetStorageForTests();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.STORAGE_BACKEND;
  delete process.env.STORAGE_ROOT;
});

describe('audioKey / buildArtifactKey', () => {
  it('builds the audio key from project id + filename', () => {
    expect(audioKey('proj-1', 'voice.mp3')).toBe('audio/proj-1/voice.mp3');
  });

  it('builds the build artifact key from build id', () => {
    expect(buildArtifactKey('build-1')).toBe('builds/build-1.zip');
  });
});

describe('isStorageKey', () => {
  it('accepts relative paths', () => {
    expect(isStorageKey('audio/proj/file.mp3')).toBe(true);
    expect(isStorageKey('builds/abc.zip')).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(isStorageKey('/tmp/wanderline-builds/abc.zip')).toBe(false);
    expect(isStorageKey('/etc/passwd')).toBe(false);
  });

  it('rejects paths with traversal segments', () => {
    expect(isStorageKey('../etc/passwd')).toBe(false);
    expect(isStorageKey('audio/../../../etc/passwd')).toBe(false);
  });

  it('rejects mid-path traversal that path.normalize would collapse', () => {
    // path.normalize('a/../b') === 'b' — make sure we still reject it
    expect(isStorageKey('a/../b')).toBe(false);
    expect(isStorageKey('audio/proj/../escape')).toBe(false);
    expect(isStorageKey('a\\..\\b')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isStorageKey('')).toBe(false);
  });
});

describe('LocalStorage', () => {
  function srcFile(name: string, contents: string): string {
    const path = join(tmpRoot, '_src', name);
    mkdirSync(join(tmpRoot, '_src'), { recursive: true });
    writeFileSync(path, contents);
    return path;
  }

  it('uploads and downloads a file by key', async () => {
    const storage = getStorage();
    const src = srcFile('hello.txt', 'hi world');
    await storage.uploadFile('audio/proj/hello.txt', src);

    expect(existsSync(join(tmpRoot, 'audio/proj/hello.txt'))).toBe(true);

    const stream = await storage.downloadStream('audio/proj/hello.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream as Readable) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hi world');
  });

  it('reports exists / size correctly', async () => {
    const storage = getStorage();
    const src = srcFile('hello.txt', 'abc');
    await storage.uploadFile('a/b.txt', src);

    expect(await storage.exists('a/b.txt')).toBe(true);
    expect(await storage.size('a/b.txt')).toBe(3);
    expect(await storage.exists('does/not/exist')).toBe(false);
    expect(await storage.size('does/not/exist')).toBe(null);
  });

  it('deletes a file', async () => {
    const storage = getStorage();
    const src = srcFile('hello.txt', 'data');
    await storage.uploadFile('a/b.txt', src);

    await storage.delete('a/b.txt');
    expect(await storage.exists('a/b.txt')).toBe(false);
  });

  it('delete is idempotent on missing files', async () => {
    const storage = getStorage();
    await expect(storage.delete('not/here')).resolves.toBeUndefined();
  });

  it('rejects absolute keys', async () => {
    const storage = getStorage();
    const src = srcFile('hello.txt', 'data');
    await expect(storage.uploadFile('/etc/passwd', src)).rejects.toThrow('absolute path');
    await expect(storage.delete('/etc/passwd')).rejects.toThrow('absolute path');
    await expect(storage.downloadStream('/tmp/foo')).rejects.toThrow('absolute path');
  });

  it('rejects path-traversal keys', async () => {
    const storage = getStorage();
    const src = srcFile('hello.txt', 'data');
    await expect(storage.uploadFile('../escape', src)).rejects.toThrow('path traversal');
    await expect(storage.delete('audio/../../../etc/passwd')).rejects.toThrow('path traversal');
  });

  it('rejects null bytes in keys', async () => {
    const storage = getStorage();
    await expect(storage.exists('a\0b')).rejects.toThrow('null byte');
  });

  it('throws when downloading a non-existent file', async () => {
    const storage = getStorage();
    await expect(storage.downloadStream('missing/file')).rejects.toThrow('Object not found');
  });
});

describe('getStorage backend selection', () => {
  it('throws when STORAGE_BACKEND=gcs but GCS_BUCKET is unset', () => {
    process.env.STORAGE_BACKEND = 'gcs';
    delete process.env.GCS_BUCKET;
    resetStorageForTests();
    expect(() => getStorage()).toThrow('GCS_BUCKET');
  });

  it('throws on unknown backend', () => {
    process.env.STORAGE_BACKEND = 'wat';
    resetStorageForTests();
    expect(() => getStorage()).toThrow('Unknown STORAGE_BACKEND');
  });
});

// signed-URL helper + feature flag.
describe('signedGetUrl (LocalStorage)', () => {
  it('always returns null — no meaningful signed URL for a local file', async () => {
    const storage = getStorage();
    await expect(storage.signedGetUrl('audio/proj/file.mp3')).resolves.toBeNull();
  });
});

describe('signedUrlDefaultTtlSeconds', () => {
  afterEach(() => {
    delete process.env.STORAGE_SIGNED_URL_TTL;
  });

  it('defaults to 600s when the env var is unset', () => {
    delete process.env.STORAGE_SIGNED_URL_TTL;
    expect(signedUrlDefaultTtlSeconds()).toBe(600);
  });

  it('returns the env value when it is a valid integer inside the range', () => {
    process.env.STORAGE_SIGNED_URL_TTL = '900';
    expect(signedUrlDefaultTtlSeconds()).toBe(900);
  });

  it(`clamps values above the max (${SIGNED_URL_MAX_TTL_SECONDS}s)`, () => {
    process.env.STORAGE_SIGNED_URL_TTL = '86400';
    expect(signedUrlDefaultTtlSeconds()).toBe(SIGNED_URL_MAX_TTL_SECONDS);
  });

  it(`clamps values below the min (${SIGNED_URL_MIN_TTL_SECONDS}s)`, () => {
    process.env.STORAGE_SIGNED_URL_TTL = '5';
    expect(signedUrlDefaultTtlSeconds()).toBe(SIGNED_URL_MIN_TTL_SECONDS);
  });

  it('falls back to default on garbage input', () => {
    process.env.STORAGE_SIGNED_URL_TTL = 'not-a-number';
    expect(signedUrlDefaultTtlSeconds()).toBe(600);
  });

  it('rejects partially-numeric input like "900s" or scientific notation', () => {
    // parseInt would happily accept these — we want a real integer or
    // the default. Prevents an ops "just append a unit" habit from
    // silently truncating the TTL.
    for (const raw of ['900s', '1e3', '600.5', '0x1A', ' 600 ']) {
      process.env.STORAGE_SIGNED_URL_TTL = raw;
      expect(signedUrlDefaultTtlSeconds()).toBe(600);
    }
  });
});

describe('useSignedUrlDownloads', () => {
  // Function-shaped so route handlers see env changes without a
  // module reload — that's the whole reason it's not a const.
  afterEach(() => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
  });

  it('returns false by default (unset)', () => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
    expect(useSignedUrlDownloads()).toBe(false);
  });

  it('returns true only for the exact string "true"', () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    expect(useSignedUrlDownloads()).toBe(true);
  });

  it('rejects other truthy strings', () => {
    // "1", "yes", "TRUE" etc. all mean OFF — matches the plan's
    // "explicit opt-in" semantics and avoids surprise-on-by-default.
    for (const raw of ['1', 'yes', 'TRUE', 'y', 'on']) {
      process.env.USE_SIGNED_URL_DOWNLOADS = raw;
      expect(useSignedUrlDownloads()).toBe(false);
    }
  });
});

/**
 * Object storage abstraction.
 *
 * Two backends:
 *   - "local": files live on the local filesystem (default; used for docker-compose dev)
 *   - "gcs": files live in a Google Cloud Storage bucket (production on Cloud Run)
 *
 * Selected via STORAGE_BACKEND env var. When unset, defaults to local.
 *
 * The abstraction uses opaque "keys" rather than filesystem paths, e.g.
 *   - audio/<projectId>/<filename>
 *   - builds/<buildId>.zip
 *
 * Each backend translates the key into the appropriate native location.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { dirname, join, isAbsolute } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Validate a storage key to prevent path traversal in the local backend.
 * Keys must be relative POSIX-style paths without any `..` segments.
 *
 * Important: we check the RAW key (not path.normalize'd) because normalize
 * collapses `a/../b` to `b`, hiding traversal attempts.
 */
function validateKey(key: string): void {
  if (!key) throw new Error('Storage key must be non-empty');
  if (key.includes('\0')) throw new Error('Invalid storage key (null byte)');
  if (isAbsolute(key) || key.startsWith('/') || key.startsWith('\\')) {
    throw new Error(`Invalid storage key (absolute path): ${key}`);
  }
  // Reject `..` anywhere in the raw key, before normalize collapses it.
  const segments = key.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error(`Invalid storage key (path traversal): ${key}`);
  }
}

export interface ObjectStorage {
  /** Upload from a local file. The local file is left in place. */
  uploadFile(key: string, localPath: string, contentType?: string): Promise<void>;
  /** Open a read stream for the object. Throws if the object doesn't exist. */
  downloadStream(key: string): Promise<NodeJS.ReadableStream>;
  /** Delete the object. No error if it doesn't exist. */
  delete(key: string): Promise<void>;
  /** Whether the object exists. */
  exists(key: string): Promise<boolean>;
  /** Size of the object in bytes, or null if it doesn't exist. */
  size(key: string): Promise<number | null>;
  /**
   * Time-limited, GET-only signed URL for direct-from-storage
   * downloads. Contract:
   *
   *   - Returns null ONLY when the backend structurally doesn't support
   *     signed URLs (the LocalStorage dev backend). A null return means
   *     "callers should fall back to downloadStream", never "the object
   *     is missing" — supporting backends still return a URL for
   *     absent keys (the client following it gets a 404 from the
   *     backend). Skipping the extra existence round-trip keeps common-
   *     case download latency down; callers that need the API's 410
   *     JSON shape on missing objects can pre-check via exists().
   *
   *   - Throws on signing errors (auth misconfig, network, IAM). The
   *     download route catches, logs a triage-friendly warn, and
   *     degrades to streaming so a signing outage doesn't take the
   *     endpoint down. Silently returning null on signing failure
   *     would hide production auth misconfigs.
   *
   * TTL defaults to signedUrlDefaultTtlSeconds() and is clamped to
   * [SIGNED_URL_MIN_TTL_SECONDS, SIGNED_URL_MAX_TTL_SECONDS] inside
   * the implementation, so callers can't pass a longer-than-policy
   * TTL by accident.
   */
  signedGetUrl(key: string, ttlSeconds?: number): Promise<string | null>;
}

/**
 * Signed-URL TTL (seconds) for GET redirects. 10 min is short
 * enough that a leaked URL isn't a durable capability + long enough to
 * absorb a slow client. Overridable via STORAGE_SIGNED_URL_TTL — the
 * value is read via a function (not a module-load const) so an ops
 * change to the env var takes effect on the next request without a
 * restart, matching the semantics of useSignedUrlDownloads() below.
 */
export const SIGNED_URL_MIN_TTL_SECONDS = 60;
export const SIGNED_URL_MAX_TTL_SECONDS = 3600;
function clampTtl(n: number): number {
  return Math.min(SIGNED_URL_MAX_TTL_SECONDS, Math.max(SIGNED_URL_MIN_TTL_SECONDS, n));
}
export function signedUrlDefaultTtlSeconds(): number {
  const raw = process.env.STORAGE_SIGNED_URL_TTL;
  if (!raw) return 600;
  // parseInt is loose enough to accept "900s" → 900 or "1e3" → 1;
  // for an ops-controlled env var we want a real integer or fallback.
  if (!/^-?\d+$/.test(raw)) return 600;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 600;
  return clampTtl(n);
}

/**
 * feature flag: opt-in to 307 → signed-URL redirects for the
 * high-egress download / audio paths. Off by default while we shake
 * this out; production sets USE_SIGNED_URL_DOWNLOADS=true once the
 * bucket's IAM allows the Cloud Run service account to sign blobs
 * (iam.serviceAccounts.signBlob on itself).
 *
 * When off, or when the backend's signedGetUrl returns null, callers
 * fall through to the existing stream-through-Cloud-Run path.
 *
 * Read as a function (not a const) so tests can flip the env var
 * between cases without a module reload. Cost per call is trivial —
 * `process.env` is a plain object.
 */
export function useSignedUrlDownloads(): boolean {
  return process.env.USE_SIGNED_URL_DOWNLOADS === 'true';
}

class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  private path(key: string): string {
    validateKey(key);
    return join(this.root, key);
  }

  async uploadFile(key: string, localPath: string): Promise<void> {
    const dest = this.path(key);
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(createReadStream(localPath), createWriteStream(dest));
  }

  async downloadStream(key: string): Promise<NodeJS.ReadableStream> {
    const path = this.path(key);
    if (!existsSync(path)) throw new Error(`Object not found: ${key}`);
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* race; ignore */
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  async size(key: string): Promise<number | null> {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    return statSync(path).size;
  }

  async signedGetUrl(): Promise<string | null> {
    // Local dev backend serves files off the host filesystem; there is
    // no meaningful signed URL. Returning null tells callers to fall
    // back to downloadStream — matching the interface contract that
    // null means "backend doesn't support signing", never "the object
    // is missing" (that would throw / redirect-then-404 in GCS).
    return null;
  }
}

class GcsStorage implements ObjectStorage {
  // Lazy import so the GCS SDK is only loaded when STORAGE_BACKEND=gcs.
  // This avoids the SDK's startup cost (and Application Default Credentials
  // resolution) for local-backend processes.
  private bucketPromise: Promise<import('@google-cloud/storage').Bucket>;

  constructor(bucketName: string) {
    this.bucketPromise = (async () => {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage();
      return storage.bucket(bucketName);
    })();
  }

  async uploadFile(key: string, localPath: string, contentType?: string): Promise<void> {
    validateKey(key);
    const bucket = await this.bucketPromise;
    await bucket.upload(localPath, {
      destination: key,
      metadata: contentType ? { contentType } : undefined,
      resumable: false,
    });
  }

  async downloadStream(key: string): Promise<NodeJS.ReadableStream> {
    validateKey(key);
    const bucket = await this.bucketPromise;
    const file = bucket.file(key);
    const [exists] = await file.exists();
    if (!exists) throw new Error(`Object not found: ${key}`);
    return file.createReadStream() as unknown as Readable;
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    const bucket = await this.bucketPromise;
    await bucket.file(key).delete({ ignoreNotFound: true });
  }

  async exists(key: string): Promise<boolean> {
    validateKey(key);
    const bucket = await this.bucketPromise;
    const [exists] = await bucket.file(key).exists();
    return exists;
  }

  async size(key: string): Promise<number | null> {
    validateKey(key);
    const bucket = await this.bucketPromise;
    const file = bucket.file(key);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    return typeof meta.size === 'string' ? parseInt(meta.size, 10) : (meta.size ?? null);
  }

  async signedGetUrl(key: string, ttlSeconds?: number): Promise<string> {
    validateKey(key);
    // Coerce non-finite TTLs (NaN from a garbled Number()/arithmetic,
    // etc.) back to the default before clamping — clampTtl(NaN) is
    // NaN and would flow into `expires: NaN` and break signing.
    const requested =
      ttlSeconds !== undefined && Number.isFinite(ttlSeconds)
        ? ttlSeconds
        : signedUrlDefaultTtlSeconds();
    // Clamp per-call, not just at env-parse time. A future caller
    // passing ttlSeconds directly must not be able to bypass the
    // [60, 3600] ceiling that the module docs promise.
    const clamped = clampTtl(requested);
    const bucket = await this.bucketPromise;
    const file = bucket.file(key);
    // NO existence pre-check: skips a full GCS round-trip on the
    // common (object-present) path. If the object was reaped between
    // the DB read and this call, the signed URL still gets issued and
    // the client sees a 404 from GCS — the caller (route handler) can
    // pre-check via exists() when it needs the API's own error shape
    // instead. Any signing failure (auth, network, IAM) propagates —
    // the route catches, logs a warn, and degrades to streaming.
    const [url] = await file.getSignedUrl({
      // V4 is the current signing algorithm — V2 URLs would still work
      // but V4 has a shorter surface for downgrade tricks.
      version: 'v4',
      // GET-only. Never sign for uploads or deletes from a read path
      // — a leaked GET URL can't mutate the object.
      action: 'read',
      // Absolute expiry (ms epoch). Clamped above.
      expires: Date.now() + clamped * 1000,
    });
    return url;
  }
}

let cached: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (cached) return cached;

  const backend = process.env.STORAGE_BACKEND || 'local';
  if (backend === 'gcs') {
    const bucket = process.env.GCS_BUCKET;
    if (!bucket) {
      throw new Error('STORAGE_BACKEND=gcs requires GCS_BUCKET to be set');
    }
    cached = new GcsStorage(bucket);
  } else if (backend === 'local') {
    const root = process.env.STORAGE_ROOT || '/tmp/wanderline-storage';
    cached = new LocalStorage(root);
  } else {
    throw new Error(`Unknown STORAGE_BACKEND: ${backend}`);
  }
  return cached;
}

/** Reset the cached storage instance — used in tests. */
export function resetStorageForTests(): void {
  cached = null;
}

/**
 * Inject a mock storage instance for route-level tests. Named
 * with the leading underscore to match _validateKeyForTests below —
 * the underscore is a hard signal that this is not a runtime API and
 * should never be imported by production code. Callers MUST call
 * resetStorageForTests() afterwards to avoid leaking the mock into
 * unrelated tests via the module-level cache.
 *
 * Also gates on NODE_ENV so a stray production import is a loud crash
 * rather than a silent misconfiguration.
 */
export function _setStorageForTests(mock: ObjectStorage): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setStorageForTests must not be called outside NODE_ENV=test');
  }
  cached = mock;
}

// Key helpers — keep key conventions in one place.
export const audioKey = (projectId: string, filename: string): string =>
  `audio/${projectId}/${filename}`;

export const buildArtifactKey = (buildId: string): string => `builds/${buildId}.zip`;

/**
 * Cache-Control value for audio/asset responses keyed on a content-
 * addressed filename. `private` (not `public`) because the responses
 * are auth-gated — a shared cache (CDN, intermediate proxy) shouldn't
 * serve them across users, and a browser cache shouldn't survive
 * permission revocation (the browser still serves cached `private`
 * bodies to the same user even after logout, but at least a different
 * profile / shared cache can't). `immutable` means clients won't
 * revalidate; safe because the URL embeds a UUID-derived filename
 * that never changes for a given content blob.
 *
 * Centralising this here means the three audio-serving endpoints all
 * share the same value — a tuning change happens in one place.
 */
export const IMMUTABLE_AUDIO_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * Returns true if the given value looks like a storage key (relative path),
 * false if it looks like a legacy absolute filesystem path that shouldn't
 * be passed to storage.delete/downloadStream.
 */
export function isStorageKey(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) return false;
  // Check raw segments — see validateKey for why normalize is unsafe here.
  const segments = value.split(/[/\\]/);
  if (segments.includes('..')) return false;
  return true;
}

// Re-export for use in tests.
export { validateKey as _validateKeyForTests };

// Wanderline player service worker.
//
// Two jobs:
//   1) Make the app shell (index.html, JS bundle, CSS, story.json,
//      indicator audio) available offline so a user who already
//      loaded the page once can re-open it from their home screen
//      on the subway and at least get past the splash.
//   2) On explicit opt-in (the "Download for offline" button in
//      the player), fetch every audio file the story references
//      and put it in the audio-cache. That turns the whole game
//      into a true offline experience.
//
// Why two caches: the app shell is small (<200KB) and changes
// per-deploy, so we bump CACHE_VERSION when shipping a new player
// to evict stale shells. Audio files are large but content-addressed
// by filename (UUIDs); they never change, so we keep them in a
// separate cache that survives shell upgrades.
//
// This SW only registers on secure contexts (https or localhost),
// which is enforced by the registration code in main.tsx. On
// file:// (a zipped build opened locally) the registration is
// skipped — but the zip already has every audio file alongside
// the HTML, so the offline story works without us doing anything.

const CACHE_VERSION = 'v3';
const SHELL_CACHE = `wl-shell-${CACHE_VERSION}`;
const AUDIO_CACHE = 'wl-audio'; // unversioned: filenames are UUIDs, so contents never change

// Files we know exist at install time. The hashed JS/CSS bundles
// vary per build, so we don't list them here — they're cached the
// first time the page fetches them (see the fetch handler).
const APP_SHELL_URLS = ['./', './index.html', './story.json', './manifest.webmanifest'];

// Path-segment tests instead of substring includes(): an /assets/
// chunk named `audio-controls-abc.js` should NOT be treated as
// audio (cache-first forever), and an /api/audio-config route
// shouldn't either. Match only when /audio/ is a path segment,
// not just a substring.
const AUDIO_PATH_RE = /(^|\/)audio\//;
const ASSETS_PATH_RE = /(^|\/)assets\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort precache: a single 404 (e.g. on story.json mid-
      // deploy) shouldn't abort the SW install.
      await Promise.all(
        APP_SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] shell precache skipped:', url, err && err.message);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop old SHELL caches from previous deploys. Audio cache
      // is unversioned so it carries over.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('wl-shell-') && n !== SHELL_CACHE)
          .map((n) => caches.delete(n)),
      );
      // Deliberately do NOT call clients.claim(): if a user is
      // mid-playback when a new deploy lands, hijacking their
      // open tab can evict the JS chunk they're about to lazy-
      // load and break playback on a flaky connection. Let the
      // new SW take over on next navigation; the open tab keeps
      // running the previous version until reload.
    })(),
  );
});

// Cache-first for audio (UUID-named, never changes).
// Stale-while-revalidate for the app shell (so the user sees
// SOMETHING on the subway, but a fresh shell loads in the
// background when there's network).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  const isAudio = AUDIO_PATH_RE.test(url.pathname);
  const isShell =
    !isAudio &&
    (url.pathname.endsWith('/') ||
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/story.json') ||
      url.pathname.endsWith('/manifest.webmanifest') ||
      ASSETS_PATH_RE.test(url.pathname));

  if (!isAudio && !isShell) return;

  // For the shell SWR path we need to register `event.waitUntil`
  // SYNCHRONOUSLY with the FetchEvent — calling it later from a
  // .then() that runs after respondWith has already settled throws
  // InvalidStateError. So we kick off the network fetch + put
  // pipeline up front and just hand respondWith whichever of
  // cached/network resolves usefully.
  if (!isAudio && isShell) {
    const cachePromise = caches.open(SHELL_CACHE);
    const networkFetch = fetch(event.request);
    const revalidate = (async () => {
      try {
        const [cache, response] = await Promise.all([cachePromise, networkFetch]);
        if (response.ok) {
          try {
            await cache.put(event.request, response.clone());
          } catch {
            // quota / put failure is best-effort; swallow.
          }
        }
      } catch {
        // Network failed — page falls back to whatever's cached.
      }
    })();
    event.waitUntil(revalidate);
    event.respondWith(
      (async () => {
        const cache = await cachePromise;
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await networkFetch;
          // If we get here, network came back fine — return it.
          // (Don't re-await revalidate — it's the same fetch, and
          // we've already cloned the response in the waitUntil path.)
          return response;
        } catch {
          // Offline AND cold cache: don't leave the user staring
          // at a generic network-error page. Return a tiny HTML
          // body so the browser renders something on file:// or
          // standalone PWA contexts where there's no native
          // offline page.
          return new Response(
            '<!doctype html><meta charset=utf-8><title>Offline</title>' +
              '<style>body{font-family:system-ui;background:#1a1a2e;color:#fff;display:flex;height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}</style>' +
              '<p>You&rsquo;re offline. Reconnect and reload to start the story.</p>',
            { status: 504, statusText: 'Offline', headers: { 'Content-Type': 'text/html' } },
          );
        }
      })(),
    );
    return;
  }

  // Audio path: cache-first, network-fallback. The waitUntil here
  // is safe because it's registered before the IIFE returns the
  // response — FetchEvent is still active.
  event.respondWith(
    (async () => {
      const cache = await caches.open(AUDIO_CACHE);
      const cached = await cache.match(event.request);
      if (cached) {
        // Safari issues a Range request for every <audio> source and
        // refuses a bare 200 in reply: the element errors and the
        // story goes silent even though the bytes are sitting right
        // here in the cache. Serve the slice it actually asked for.
        const range = event.request.headers.get('range');
        if (range) return buildRangeResponse(cached, range);
        return cached;
      }
      try {
        const response = await fetch(event.request);
        // Cache.put() rejects outright on a 206, and a partial body is
        // useless as a whole-file entry, so only store complete ones.
        if (response.ok && response.status !== 206) {
          event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
        }
        return response;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })(),
  );
});

// Turn a complete cached response into the 206 slice a Range request
// asked for. Only the single-range `bytes=start-end` form is handled
// (including the open-ended and suffix variants) — that is what
// browser media elements actually send; anything exotic falls back to
// the full body, which is still better than erroring.
async function buildRangeResponse(cached, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return cached;
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return cached;

  let start;
  let end;
  if (!hasStart) {
    // Suffix form `bytes=-N`: the last N bytes.
    const suffix = parseInt(match[2], 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = hasEnd ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response('', {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }

  const headers = new Headers(cached.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}

// Opt-in bulk precache. The page sends a PRECACHE_AUDIO message
// with a list of URLs to download. We validate each URL is
// same-origin + path-prefixed under /audio/ so a hostile
// in-page script can't trick the SW into caching arbitrary
// content (or exfiltrating cross-origin endpoints into the cache).
self.addEventListener('message', (event) => {
  const data = event.data;

  // Status query: how much of this story is actually on the device?
  // Answered from the cache itself rather than from a counter the page
  // kept, because the page's counter dies with the tab and the whole
  // point is telling someone on a platform at 8am whether last night's
  // download is still there.
  if (data && data.type === 'CHECK_AUDIO_CACHE') {
    const src = event.source;
    if (!src || src.url == null || new URL(src.url).origin !== self.location.origin) return;
    event.waitUntil(reportAudioCacheStatus(Array.isArray(data.urls) ? data.urls : []));
    return;
  }

  if (!data || data.type !== 'PRECACHE_AUDIO') return;
  // Only accept messages from same-origin window clients.
  const src = event.source;
  if (!src || src.url == null || new URL(src.url).origin !== self.location.origin) {
    console.warn('[sw] rejecting PRECACHE_AUDIO from non-window or cross-origin source');
    return;
  }
  const rawUrls = Array.isArray(data.urls) ? data.urls : [];
  const validUrls = rawUrls.filter((u) => {
    if (typeof u !== 'string') return false;
    try {
      const parsed = new URL(u, self.location.href);
      return parsed.origin === self.location.origin && AUDIO_PATH_RE.test(parsed.pathname);
    } catch {
      return false;
    }
  });
  event.waitUntil(precacheAudio(validUrls));
});

// How many audio files to pull at once. The original sequential loop
// was correct but pathologically slow on a long story over mobile
// data — slow enough that the page's stall watchdog fired and
// reported a failure while the precache was still working fine.
const PRECACHE_CONCURRENCY = 4;

async function precacheAudio(urls) {
  const cache = await caches.open(AUDIO_CACHE);
  const total = urls.length;
  let done = 0;
  let failed = 0;
  // Tracked separately from `failed` because it has a completely
  // different remedy. A deployment that 307s /audio/* to a signed
  // cross-origin storage URL will fail EVERY file here unless that
  // bucket sends CORS headers — media elements don't care, but
  // fetch() does. Reported as a generic failure it looks like a flaky
  // network; named, it points straight at the bucket's CORS policy.
  let corsBlocked = 0;
  let quotaExceeded = false;
  let aborted = false;

  const fetchOne = async (url) => {
    const cached = await cache.match(url);
    if (cached) {
      done++;
      return;
    }
    const response = await fetch(url, { cache: 'reload' });
    if (!response.ok) {
      // An opaque response means the request crossed an origin we
      // aren't allowed to read — status is 0 and the body is sealed.
      if (response.type === 'opaque' || response.type === 'opaqueredirect') corsBlocked++;
      failed++;
      return;
    }
    // Cache.put() rejects on 206 and a partial body is useless as a
    // whole-file entry.
    if (response.status === 206) {
      failed++;
      return;
    }
    try {
      await cache.put(url, response.clone());
      done++;
    } catch (err) {
      if (err && err.name === 'QuotaExceededError') {
        // Every subsequent put would fail too — stop the workers.
        quotaExceeded = true;
        aborted = true;
      }
      failed++;
    }
  };

  let index = 0;
  const worker = async () => {
    while (index < urls.length && !aborted) {
      const url = urls[index++];
      try {
        await fetchOne(url);
      } catch (err) {
        // A cross-origin redirect with no CORS headers rejects the
        // fetch outright rather than returning an opaque response.
        if (err && err.name === 'TypeError') corsBlocked++;
        failed++;
      }
      await broadcastProgress(done, failed, total, quotaExceeded, corsBlocked);
    }
  };

  await Promise.all(Array.from({ length: Math.min(PRECACHE_CONCURRENCY, total) }, worker));

  // Explicit terminal message so the page doesn't have to infer
  // completion from a tally — covers the case where a single message
  // in the middle was dropped and the tally never lined up.
  await broadcastComplete(done, failed, total, quotaExceeded, corsBlocked);
}

async function reportAudioCacheStatus(urls) {
  const cache = await caches.open(AUDIO_CACHE);
  let cached = 0;
  let bytes = 0;
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    try {
      const hit = await cache.match(url);
      if (!hit) continue;
      cached++;
      // Read the declared length rather than the body: summing
      // arrayBuffer() over a whole story would pull every file back
      // through memory just to draw a label.
      const len = Number(hit.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0) bytes += len;
    } catch {
      // A single unreadable entry shouldn't sink the whole report.
    }
  }
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'AUDIO_CACHE_STATUS',
      cached,
      total: urls.length,
      bytes,
    });
  }
}

async function broadcastProgress(loaded, failed, total, quotaExceeded, corsBlocked) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'PRECACHE_PROGRESS',
      loaded,
      failed,
      total,
      quotaExceeded: !!quotaExceeded,
      corsBlocked: corsBlocked || 0,
    });
  }
}

async function broadcastComplete(loaded, failed, total, quotaExceeded, corsBlocked) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'PRECACHE_COMPLETE',
      loaded,
      failed,
      total,
      quotaExceeded: !!quotaExceeded,
      corsBlocked: corsBlocked || 0,
    });
  }
}

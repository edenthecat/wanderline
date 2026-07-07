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

const CACHE_VERSION = 'v2';
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
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
        }
        return response;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })(),
  );
});

// Opt-in bulk precache. The page sends a PRECACHE_AUDIO message
// with a list of URLs to download. We validate each URL is
// same-origin + path-prefixed under /audio/ so a hostile
// in-page script can't trick the SW into caching arbitrary
// content (or exfiltrating cross-origin endpoints into the cache).
self.addEventListener('message', (event) => {
  const data = event.data;
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

async function precacheAudio(urls) {
  const cache = await caches.open(AUDIO_CACHE);
  const total = urls.length;
  let done = 0;
  let failed = 0;
  let quotaExceeded = false;
  for (const url of urls) {
    try {
      const cached = await cache.match(url);
      if (cached) {
        done++;
      } else {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) {
          try {
            await cache.put(url, response.clone());
            done++;
          } catch (err) {
            if (err && err.name === 'QuotaExceededError') {
              quotaExceeded = true;
              failed++;
              // Bail out of the loop — every subsequent put will
              // fail too. Surface a distinct signal to the page.
              await broadcastProgress(done, failed, total, true);
              await broadcastComplete(done, failed, total, true);
              return;
            }
            failed++;
          }
        } else {
          failed++;
        }
      }
    } catch {
      failed++;
    }
    await broadcastProgress(done, failed, total, quotaExceeded);
  }
  // Explicit terminal message so the page doesn't have to infer
  // completion from a tally — covers the case where a single
  // message in the middle was dropped and the tally never lined up.
  await broadcastComplete(done, failed, total, quotaExceeded);
}

async function broadcastProgress(loaded, failed, total, quotaExceeded) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'PRECACHE_PROGRESS',
      loaded,
      failed,
      total,
      quotaExceeded: !!quotaExceeded,
    });
  }
}

async function broadcastComplete(loaded, failed, total, quotaExceeded) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'PRECACHE_COMPLETE',
      loaded,
      failed,
      total,
      quotaExceeded: !!quotaExceeded,
    });
  }
}

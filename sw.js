/*
 * Pixel Veil service worker: makes the app work with no connection.
 *
 * Every file the app needs is copied into a cache at install time. After that the app
 * is served from the cache and the network is only a fallback.
 *
 * The worker answers for the app's own page and its own files, and for nothing else.
 * Any other page or request on the same site goes to the network untouched.
 *
 * Every URL here is relative, and a relative URL in a service worker resolves against
 * the worker's own address. The app therefore works at a site root and in a sub-path
 * such as https://example.github.io/pixel-veil/ with no changes.
 */
'use strict';

// tools/build.mjs rewrites the next line with a hash of the precached files.
// A new hash means a new cache name, which is how an update reaches people.
const CACHE_VERSION = 'dd2dfb6a823a';

const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'face.js',
  'zip.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/mediapipe/vision_bundle.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/face_detection_full_range.tflite',
];

// Where the app lives, e.g. https://example.com/ or https://example.com/pixel-veil/.
const APP_ROOT = new URL('./', self.location.href);
const APP_SHELL = new URL('index.html', APP_ROOT).href;

// The full addresses of the app's own files. The worker answers these and nothing else.
const PRECACHE_URLS = new Set(PRECACHE.map((path) => new URL(path, APP_ROOT).href));

// Cache Storage is shared by the whole origin, so the cache name carries this copy's path.
// '#' never appears in a URL path, so one copy's prefix can never match another copy's.
const CACHE_PREFIX = 'pixel-veil-' + APP_ROOT.pathname + '#';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
// Names used before the path was part of the name.
const LEGACY_CACHE = /^pixel-veil-[0-9a-f]{12}$/;

// The precached copies were stored by requests made in here, which carry none of a
// page's headers. A host that sends "Vary: User-Agent", "Accept" or "Origin" would
// otherwise never match them, so every lookup ignores Vary.
const MATCH = { ignoreVary: true };

/**
 * Fetch one file past the browser's HTTP cache and store it.
 *
 * Some hosts answer "index.html" with a redirect to "./". A browser refuses to use a
 * redirected response for a page load, so a redirected response is rebuilt as a plain
 * response before it is stored.
 */
async function precacheOne(cache, path) {
  const url = new URL(path, APP_ROOT).href;
  // The cache name is a hash of these files, so an entry already stored by an earlier,
  // failed install is the right bytes. Keep it and only fetch what is missing.
  if (await cache.match(url, MATCH)) return;
  let response = await fetch(new Request(url, { cache: 'reload' }));
  if (!response.ok) {
    throw new Error('Precache failed for ' + path + ' (HTTP ' + response.status + ')');
  }
  if (response.redirected) {
    response = new Response(await response.blob(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  await cache.put(url, response);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // If any file fails, the install fails and the browser tries again on a later
      // visit. The previous version keeps working until then. Every file is given
      // the chance to finish first, and what was stored is kept, so the retry only
      // downloads the files that are still missing.
      const results = await Promise.allSettled(PRECACHE.map((path) => precacheOne(cache, path)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Remove this copy's older caches. Another copy of the app on the same site
      // (in another folder) has its own prefix, and its caches are left alone.
      const names = await caches.keys();
      await Promise.all(
        names.map(async (name) => {
          if (name === CACHE_NAME) return;
          let mine = name.startsWith(CACHE_PREFIX);
          // An old-style cache is only removed if it holds this copy's own page.
          if (!mine && LEGACY_CACHE.test(name)) {
            mine = Boolean(await (await caches.open(name)).match(APP_SHELL, MATCH));
          }
          if (mine) await caches.delete(name);
        })
      );
      await self.clients.claim();
    })()
  );
});

function offlineResponse() {
  return new Response('Pixel Veil is offline and this file is not in its cache.', {
    status: 504,
    statusText: 'Gateway Timeout',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** True when a page load is asking for the app itself (the folder or its index.html). */
function isAppPage(url) {
  return url.pathname === APP_ROOT.pathname || url.pathname === APP_ROOT.pathname + 'index.html';
}

/** The app's own page comes from the cache. The network is only used if the cache was cleared. */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const shell = await cache.match(APP_SHELL, MATCH);
  if (shell) return shell;
  try {
    return await fetch(request);
  } catch (error) {
    return offlineResponse();
  }
}

/**
 * One of the app's own files: from the cache, with the network as a fallback. A network
 * answer is passed on but not stored. The cache only ever holds what install put there.
 */
async function handleAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (error) {
    return offlineResponse();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Anything on another origin is left alone. The browser handles it as if this
  // worker did not exist.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Only the app's own page is answered here. Any other page in scope, such as
    // dist/pixel-veil.html, is left to the browser: served under that address, the
    // app shell's relative links would point at the wrong folder.
    if (isAppPage(url)) event.respondWith(handleNavigation(request));
    return;
  }
  // Only the app's own files are answered here. Any other request on this site is
  // left alone, as if this worker did not exist.
  if (!PRECACHE_URLS.has(url.origin + url.pathname)) return;
  event.respondWith(handleAsset(request));
});

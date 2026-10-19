// Bump FONTS_CACHE when files in fonts/ or media/ change
const FONTS_CACHE = 'virgulas-fonts-v6'
// Bump APP_CACHE when the built app (bundle, HTML, CSS, manifest) changes
const APP_CACHE = 'virgulas-app-v127'

const KNOWN_CACHES = new Set([FONTS_CACHE, APP_CACHE])

// Font and icon assets — served cache-first; bump FONTS_CACHE on any change
const FONTS_SHELL = [
  './fonts/inter/inter-google.css',
  './fonts/inter/inter-cyrillic.woff2',
  './fonts/inter/inter-greek.woff2',
  './fonts/inter/inter-latin.woff2',
  './fonts/inter/inter-latin-ext.woff2',
  './fonts/inter/inter-cyrillic-ext.woff2',
  './fonts/inter/inter-vietnamese.woff2',
  './fonts/inter/inter-greek-ext.woff2',
  './media/favicon.svg',
  './media/favicon.ico',
  './media/favicon-96x96.png',
  './media/apple-touch-icon.png',
  './media/web-app-manifest-192x192.png',
  './media/web-app-manifest-512x512.png',
  './media/quick-capture-96x96.png',
  './media/quick-capture-192x192.png'
]

// App shell — served stale-while-revalidate; bump APP_CACHE to force immediate refresh
const APP_SHELL = [
  './',
  './index.html',
  './version.json',
  './js/app.css',
  './site.webmanifest',
  './js/app.js'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(FONTS_CACHE).then((cache) => cache.addAll(FONTS_SHELL)),
      caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL))
    ]).then(() => self.skipWaiting())
  )
})

// Pathnames the worker may keep in Cache Storage: the precached shells plus the
// runtime-fetched assets. Every other same-origin request passes straight
// through the fetch handler (never intercepted, never cached), and the activate
// sweep below removes any copy an earlier build left behind. This keeps Cache
// Storage limited to what the app needs to boot offline.
const PRECACHE_PATHS = new Set(
  [...APP_SHELL, ...FONTS_SHELL].map((entry) => new URL(entry, self.location).pathname)
)
// Needed offline but impossible to precache: the content-hashed Supabase chunk
// (its filename changes every build) and the Memory-mode tour.
const RUNTIME_PATHS = new Set(['/intro.vmd', '/favicon.ico'])
const isChunkPath = (pathname) => /\/js\/chunk-[^/]+\.js$/.test(pathname)
const isCacheablePath = (pathname) =>
  PRECACHE_PATHS.has(pathname) || RUNTIME_PATHS.has(pathname) || isChunkPath(pathname)

// Only navigations to the app shell itself are cached, under the one canonical
// key. `/privacy.html` (or any other real path) must never overwrite the shell.
const isShellNavigation = (pathname) => pathname === '/' || pathname.endsWith('/index.html')

// Delete entries inside the current caches that are not on the allowlist, so
// junk an older stale-while-revalidate catch-all stored (robots.txt, llms.txt,
// a stale chunk) does not wait for the next version bump to disappear.
async function pruneStaleEntries() {
  const cacheNames = (await caches.keys()).filter((name) => KNOWN_CACHES.has(name))
  await Promise.all(
    cacheNames.map(async (name) => {
      const cache = await caches.open(name)
      const requests = await cache.keys()
      await Promise.all(
        requests
          .filter((request) => !isCacheablePath(new URL(request.url).pathname))
          .map((request) => cache.delete(request))
      )
    })
  )
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !KNOWN_CACHES.has(key))
          .map((key) => caches.delete(key))
      )
    ).then(() => pruneStaleEntries()).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  const path = url.pathname
  if (path.includes('/fonts/') || path.includes('/media/') || path === '/favicon.ico') {
    event.respondWith(cacheFirst(request, FONTS_CACHE))
    return
  }

  // Content-hashed Supabase chunk: immutable, so cache-first. Not precached so
  // Local/Memory/File users never download it; Remote users get it offline.
  if (isChunkPath(path)) {
    event.respondWith(cacheFirst(request, APP_CACHE))
    return
  }

  // Network-first so a version bump or a tour edit is picked up on the next
  // visit instead of waiting for a revalidation, with the cache as the offline
  // fallback.
  if (path.endsWith('/version.json') || path.endsWith('/intro.vmd')) {
    event.respondWith(networkFirst(request, APP_CACHE))
    return
  }

  // The rest of the app shell keeps its stale-while-revalidate strategy (see
  // SPEC.vmd → SERVICE WORKER).
  if (PRECACHE_PATHS.has(path)) {
    event.respondWith(staleWhileRevalidate(request, APP_CACHE, event))
    return
  }

  // Everything else passes straight through: not intercepted, not cached.
})

// Navigations are cached under this one canonical key, never under the
// requested URL. A quick-capture visit (`/?quick-add=…`, share-target params)
// or a `#<nodeId>` zoom link would otherwise write the captured text or the
// node id into Cache Storage in plaintext, and give every distinct URL its own
// entry. The app shell is identical for all of them, so one key is enough.
const SHELL_CACHE_KEY = './index.html'

async function networkFirstNavigation(request) {
  const { pathname } = new URL(request.url)
  try {
    const response = await fetch(request)
    // Cache only a successful *shell* navigation, under the canonical key. A
    // 404/5xx must not become the offline page, and a visit to /privacy.html
    // (a real target="_blank" link) must not overwrite the cached app shell.
    if (response.ok && isShellNavigation(pathname)) {
      const cache = await caches.open(APP_CACHE)
      await cache.put(SHELL_CACHE_KEY, response.clone())
    }
    return response
  } catch {
    const cachedPage = await caches.match(SHELL_CACHE_KEY)
    if (cachedPage) return cachedPage

    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    // Awaited (not floated) so the browser cannot stop the worker before the
    // entry lands.
    await cache.put(request, response.clone())
  }
  return response
}

// Network-first for version.json and intro.vmd, so a version bump or a tour edit
// is picked up on the next visit instead of waiting for a background
// revalidation, with the cached copy as the offline fallback.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) {
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached

    return new Response('', { status: 504, statusText: 'Gateway Timeout' })
  }
}

async function staleWhileRevalidate(request, cacheName, event) {
  // Everything here runs synchronously until the first `await` (the
  // `await cachePromise` below). That matters: event.waitUntil() must be called
  // while the fetch event is still being dispatched, so it is invoked before any
  // await — otherwise the browser could terminate the worker before the
  // background revalidation writes the fresh copy (the perf-06 bug).
  const cachePromise = caches.open(cacheName)

  // One network fetch. The response is cloned the instant it arrives, before
  // either consumer reads the body, so the background cache write and the copy
  // we serve never contend over the same stream.
  const networkPromise = fetch(request).then(
    (response) => {
      if (!response.ok) return { response, cacheWrite: undefined }
      const cacheWrite = cachePromise
        .then((cache) => cache.put(request, response.clone()))
        .catch(() => undefined)
      return { response, cacheWrite }
    },
    () => ({ response: null, cacheWrite: undefined })
  )

  // Hold the event open until the revalidation write settles.
  event.waitUntil(
    networkPromise.then(({ cacheWrite }) => cacheWrite).catch(() => undefined)
  )

  const cache = await cachePromise
  const cached = await cache.match(request)
  if (cached) return cached

  const { response } = await networkPromise
  return response || new Response('', { status: 504, statusText: 'Gateway Timeout' })
}

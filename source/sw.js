// Bump FONTS_CACHE when files in fonts/ or media/ change
const FONTS_CACHE = 'virgulas-fonts-v6'
// Bump APP_CACHE when the built app (bundle, HTML, CSS, manifest) changes
const APP_CACHE = 'virgulas-app-v112'

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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !KNOWN_CACHES.has(key))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
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
  if (path.includes('/fonts/') || path.includes('/media/')) {
    event.respondWith(cacheFirst(request, FONTS_CACHE))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

// Navigations are cached under this one canonical key, never under the
// requested URL. A quick-capture visit (`/?quick-add=…`, share-target params)
// or a `#<nodeId>` zoom link would otherwise write the captured text or the
// node id into Cache Storage in plaintext, and give every distinct URL its own
// entry. The app shell is identical for all of them, so one key is enough.
const SHELL_CACHE_KEY = './index.html'

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request)
    // Only cache successful navigations: a 404 or a 5xx must not be pinned as
    // the offline shell.
    if (response.ok) {
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
    cache.put(request, response.clone())
  }
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(APP_CACHE)
  const cached = await cache.match(request)

  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => null)

  if (cached) {
    return cached
  }

  const networkResponse = await networkFetch
  if (networkResponse) {
    return networkResponse
  }

  return new Response('', { status: 504, statusText: 'Gateway Timeout' })
}

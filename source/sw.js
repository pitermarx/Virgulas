// Bump VENDOR_CACHE when vendor/ files change (after npm install / sync-vendor)
const VENDOR_CACHE = 'virgulas-vendor-v4'
// Bump FONTS_CACHE when files in fonts/ or media/ change
const FONTS_CACHE = 'virgulas-fonts-v2'
// Bump APP_CACHE when app JS, CSS, or HTML changes
const APP_CACHE = 'virgulas-app-v9'

const KNOWN_CACHES = new Set([VENDOR_CACHE, FONTS_CACHE, APP_CACHE])

// Pinned library files — served cache-first; bump VENDOR_CACHE on any change
const VENDOR_SHELL = [
  './vendor/preact.module.js',
  './vendor/hooks.module.js',
  './vendor/htm.module.js',
  './vendor/htm-preact.module.js',
  './vendor/signals-core.module.js',
  './vendor/signals.module.js',
  './vendor/marked.esm.js',
  './vendor/purify.es.mjs',
  './vendor/supabase.js'
]

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
  './media/web-app-manifest-512x512.png'
]

// App shell — served stale-while-revalidate; bump APP_CACHE to force immediate refresh
const APP_SHELL = [
  './',
  './index.html',
  './version.json',
  './css/style.css',
  './site.webmanifest',
  './js/app.js',
  './js/crypto2.js',
  './js/outline.js',
  './js/persistence.js',
  './js/search.js',
  './js/shortcuts.js',
  './js/sync.js',
  './js/markdown.js',
  './js/ui.js',
  './js/utils.js'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(VENDOR_CACHE).then((cache) => cache.addAll(VENDOR_SHELL)),
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
  if (path.includes('/vendor/')) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE))
    return
  }
  if (path.includes('/fonts/') || path.includes('/media/')) {
    event.respondWith(cacheFirst(request, FONTS_CACHE))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request)
    const cache = await caches.open(APP_CACHE)
    cache.put(request, response.clone())
    return response
  } catch {
    const cachedPage = await caches.match(request)
    if (cachedPage) return cachedPage

    const appShell = await caches.match('./index.html')
    if (appShell) return appShell

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

const APP_CACHE = 'virgulas-app-v1'
const RUNTIME_CACHE = 'virgulas-runtime-v1'

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './fonts/inter/inter-google.css',
  './fonts/inter/inter-cyrillic.woff2',
  './fonts/inter/inter-greek.woff2',
  './fonts/inter/inter-latin.woff2',
  './fonts/inter/inter-latin-ext.woff2',
  './fonts/inter/inter-cyrillic-ext.woff2',
  './fonts/inter/inter-vietnamese.woff2',
  './fonts/inter/inter-greek-ext.woff2',
  './site.webmanifest',
  './js/app.js',
  './js/crypto2.js',
  './js/node.js',
  './js/outline.js',
  './js/persistence.js',
  './js/search.js',
  './js/shortcuts.js',
  './js/sync.js',
  './js/ui.js',
  './js/utils.js',
  './vendor/preact.module.js',
  './vendor/hooks.module.js',
  './vendor/htm.module.js',
  './vendor/htm-preact.module.js',
  './vendor/signals-core.module.js',
  './vendor/signals.module.js',
  './vendor/supabase.js'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_CACHE && key !== RUNTIME_CACHE)
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

  event.respondWith(staleWhileRevalidate(request))
})

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request)
    const cache = await caches.open(RUNTIME_CACHE)
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

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE)
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

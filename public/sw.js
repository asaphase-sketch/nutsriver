/*
 * NutsRiver offline-shell service worker.
 *
 * Strategy:
 *  - Navigations: network-first, fall back to the cached app shell ('/').
 *    Online users always get the freshest build; offline users get the SPA,
 *    which shows its own 'you are offline' banner and reconnects sockets.
 *  - Content-hashed static assets (/_next/static/*) and brand icons:
 *    cache-first (immutable content).
 *  - /api/*: NEVER cached — the game must be live. WebSocket upgrades are
 *    not intercepted by service workers at all.
 *
 * Bump VERSION when the shell contract changes (e.g. renamed icon files) to
 * invalidate every old cache on the next activate.
 */
/* global clients */
const VERSION = 'v1'
const SHELL_CACHE = `nutsriver-shell-${VERSION}`
const RUNTIME_CACHE = `nutsriver-runtime-${VERSION}`

const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // allSettled: one missing asset must not break the whole install
      await Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset)))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // The game is live-only: auth, lobby, tables, ledger — never cached.
  if (url.pathname.startsWith('/api/')) return

  // --- app shell for navigations ---
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req)
          const cache = await caches.open(SHELL_CACHE)
          cache.put('/', fresh.clone())
          return fresh
        } catch {
          const cache = await caches.open(SHELL_CACHE)
          const shell =
            (await cache.match('/')) ??
            (await cache.match(req.url)) ??
            new Response('NutsRiver is offline — reconnect to play.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          return shell
        }
      })(),
    )
    return
  }

  // --- immutable hashed assets + brand files: cache-first ---
  const cacheFirst =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/logo.svg' ||
    url.pathname === '/manifest.webmanifest'
  if (cacheFirst) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        const fresh = await fetch(req)
        const cache = await caches.open(SHELL_CACHE)
        cache.put(req, fresh.clone())
        return fresh
      })(),
    )
    return
  }

  // --- everything else: network-first with runtime-cache fallback ---
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req)
        const cache = await caches.open(RUNTIME_CACHE)
        cache.put(req, fresh.clone())
        return fresh
      } catch {
        const cached = await caches.match(req)
        if (cached) return cached
        return new Response('Offline', { status: 504 })
      }
    })(),
  )
})

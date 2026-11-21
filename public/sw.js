/* Minimal service worker for Spotify.
   Purpose: satisfy the PWA install criteria (installable app) WITHOUT caching
   assets — a stale cache was the reason the old SW was removed. We take control
   immediately and always serve from the network, so updates are never stale. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
/* Pure network pass-through (no offline cache). Skip streaming/Range requests
   so background <audio> playback and seeking never stall through SW. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || event.request.headers.has('range')) return;
  event.respondWith(fetch(event.request).catch(() => Response.error()));
});

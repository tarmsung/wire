'use strict';
// Service worker: makes Wirelink installable and lets the app shell load
// offline. Strategy is network-first so a fresh deploy is always picked up when
// online, with the cache as an offline fallback. Dynamic/live endpoints
// (/ice, /lan) and non-GET/cross-origin requests are never touched — the
// WebRTC signalling runs over WebSocket, which service workers don't intercept.
const CACHE = 'wirelink-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/wire-lib.js',
  '/app.js',
  '/logo.png',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/ice' || url.pathname === '/lan') return; // always live

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
  );
});

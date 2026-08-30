// No-op service worker — satisfies browser registration requests without caching anything
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

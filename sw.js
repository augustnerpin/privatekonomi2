// Service worker: gör appen installerbar och startbar utan nät.
// - Själva appen (index.html): nätet först, så att nya versioner kommer direkt; sparad kopia utan nät.
// - Ikoner och manifest: sparad kopia först.
// - Bibliotek och typsnitt från CDN: sparad kopia direkt, uppdateras i bakgrunden.
// - AI (Anthropic), Supabase och Firebase går alltid direkt till nätet och sparas aldrig.
const VERSION = 'ekonomi-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Appen själv: nätet först, sparad kopia om nätet saknas
  if (req.mode === 'navigate' || (url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith(
      fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); } return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Ikoner, manifest m.m. från samma webbplats
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Bibliotek och typsnitt: sparad kopia direkt, uppdatera i bakgrunden
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
  // Allt annat (AI, Supabase, Firebase): hanteras inte här → går direkt till nätet
});

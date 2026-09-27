// Service worker: gör appen installerbar och startbar utan nät.
// - Själva appen (index.html): nätet först, så att nya versioner kommer direkt; sparad kopia utan nät.
// - Ikoner och manifest: sparad kopia direkt, uppdateras i bakgrunden (så att nya ikoner kommer fram).
// - Bibliotek och typsnitt från CDN: sparad kopia direkt, uppdateras i bakgrunden.
// - AI (Anthropic), Supabase och Firebase går alltid direkt till nätet och sparas aldrig.
// - Notiser (push) visas här även när appen är stängd.
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
        // Bara riktiga sidor sparas som appens offlinekopia (inte t.ex. en ikon som öppnats direkt)
        .then(res => { if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); } return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Ikoner, manifest m.m. från samma webbplats
  if (url.origin === location.origin) {
    const net = fetch(req).then(async res => {
      if (res.ok) { const c = await caches.open(VERSION); await c.put(req, res.clone()); }
      return res;
    });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(caches.match(req).then(hit => hit || net));
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

// Notiser från servern (supabase/functions/bank → nattens sammanfattning). Tryck öppnar appen.
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Ekonomi', {
    body: m.body || '', tag: m.tag, icon: './icons/icon-192.png', badge: './icons/favicon-32.png', data: { url: m.url || './' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});

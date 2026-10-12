/* Service Worker: オフラインキャッシュ + FCM バックグラウンド通知 */
const VER = 'v1.0.3';
const SHELL = `shell-${VER}`, TILES = 'tiles-v1', LIBS = 'libs-v1';
const SHELL_FILES = ['./', './index.html', './css/app.css', './js/app.js', './js/geo.js', './js/stats.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const LIB_FILES = ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'];

/* ---------- FCM（config.js に設定がある場合のみ） ---------- */
try {
  importScripts('./config.js');
  const fb = self.APP_CONFIG && self.APP_CONFIG.firebase;
  if (fb && fb.apiKey) {
    importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
                  'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
    firebase.initializeApp(fb);
    // データメッセージのみ送信される想定 → 自前で通知を表示
    firebase.messaging().onBackgroundMessage((payload) => {
      const d = payload.data || {};
      const urgent = d.urgent === '1';
      return self.registration.showNotification(d.title || '地震情報', {
        body: d.body || '', tag: d.tag || d.id || 'quake', renotify: true,
        icon: './icons/icon-192.png', badge: './icons/icon-192.png',
        requireInteraction: urgent, data: { url: './' }
      });
    });
  }
} catch (e) { /* オフライン時などは通知機能なしで継続 */ }

/* ---------- install / activate ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(u => c.add(u).catch(() => {})));
    const l = await caches.open(LIBS);
    await Promise.all(LIB_FILES.map(u => l.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* ---------- fetch ---------- */
async function swr(req, cacheName, opts = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, opts);
  const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') {
      cache.put(req, r.clone());
      cache.keys().then(ks => { if (ks.length > 600) ks.slice(0, ks.length - 500).forEach(k => cache.delete(k)); });
    }
    return r;
  } catch { return Response.error(); }
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('p2pquake.net')) return;                 // API は常にネットワーク
  if (url.hostname === 'cyberjapandata.gsi.go.jp') return e.respondWith(tile(req));
  if (url.hostname === 'unpkg.com') return e.respondWith(swr(req, LIBS));
  if (url.hostname.endsWith('googleapis.com') || url.hostname === 'fonts.gstatic.com') return e.respondWith(swr(req, LIBS));
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') {
      return e.respondWith(swr(new Request('./index.html'), SHELL, { ignoreSearch: true }));
    }
    return e.respondWith(swr(req, SHELL, { ignoreSearch: true }));
  }
});

/* ---------- 通知クリック ---------- */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all[0];
    if (c) { await c.focus(); c.postMessage({ type: 'notification-click' }); }
    else await self.clients.openWindow('./');
  })());
});

// ta-ca: que la app abra aunque se corte internet en el local.
// La página y nucleo.js: primero la red (así siempre llega la última versión) y si no hay, la copia guardada.
// Librerías y tipografías de otros sitios: la copia guardada, y se actualiza por detrás.
// Nunca se guardan /api ni Supabase: esos datos los maneja la app con su propia cola de cambios.
const CACHE = 'taca-v5';
const BASE = ['/', '/nucleo.js', '/manifest.webmanifest', '/icono-192.png', '/icono-512.png'];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(
    BASE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))
      .concat(CDN.map(u => fetch(u, { mode: 'no-cors' }).then(r => c.put(u, r)).catch(() => {})))
  )).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.pathname.startsWith('/api/') || /supabase\.(co|in)$/.test(u.hostname) || u.hostname.endsWith('mercadopago.com') || u.hostname.endsWith('mercadopago.com.ar')) return;
  const propio = u.origin === self.location.origin;
  if (propio && (r.mode === 'navigate' || u.pathname === '/' || u.pathname === '/nucleo.js')) {
    const clave = r.mode === 'navigate' && (u.pathname === '/' || u.pathname === '/index.html') ? '/' : u.pathname;
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(clave, copia)); }
      return res;
    }).catch(() => caches.match(clave).then(x => x || caches.match('/'))));
    return;
  }
  if (!propio && /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.hostname)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(r).then(x => {
      const red = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(() => x);
      return x || red;
    })));
  }
});

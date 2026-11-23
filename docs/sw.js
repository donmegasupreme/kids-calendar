// Offline shell. The app itself always tries the network first, so updates
// show up straight away; the cache is only used when there's no connection.
// Calendar data is never cached here (the page keeps its own last copy).
const CACHE = 'kids-cal-v3';
// Relative paths: the site lives under /<repo-name>/ on GitHub Pages.
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google's script is another site: never cached
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});

// ---- phone notifications ----
// The message is encrypted by the Google script and decrypted by the browser.
// Always show something, even if the message can't be read.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Kids Calendar';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Something changed on the calendar.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'kids-calendar',   // a new change replaces the last one instead of stacking up
    renotify: true,
    data: { url: data.url || self.registration.scope },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});

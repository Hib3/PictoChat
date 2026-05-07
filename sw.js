const CACHE_NAME = "picto-pwa-chat-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./main.js",
  "./p2p-bridge.js",
  "./manifest.webmanifest",
  "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/icon.png",
  "https://cdn.jsdelivr.net/npm/pixi.js-legacy@5.3.0/dist/pixi-legacy.min.js",
  "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/howler.min.js",
  "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/fontfaceobserver.js",
  "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/pickr.min.js",
  "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/nano.min.css",
  "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/nds.ttf"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === "opaque") return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});

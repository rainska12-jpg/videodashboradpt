const CACHE_NAME = "video-work-dashboard-v166";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=83",
  "/work-task.css?v=37",
  "/work-studio.css",
  "/mobile-studio.css?v=56",
  "/mobile-calendar.css?v=35",
  "/notifications.css?v=57",
  "/work-geist.css?v=10",
  "/task-geist.css?v=2",
  "/calendar-geist.css?v=2",
  "/studio-geist.css?v=5",
  "/board-geist.css?v=2",
  "/admin-geist.css?v=3",
  "/account-geist.css?v=8",
  "/mobile-task-geist.css?v=8",
  "/mobile-video-geist.css?v=8",
  "/mobile-work-geist.css?v=22",
  "/mobile-calendar-geist.css?v=6",
  "/mobile-notification-geist.css?v=3",
  "/mobile-more-geist.css?v=6",
  "/mobile-board-geist.css?v=4",
  "/mobile-studio-geist.css?v=6",
  "/app.js?v=135",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.hostname.includes("supabase.co")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && url.origin === location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

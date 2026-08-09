/* Precaches the shell so a repeat visit paints the globe without waiting on the
   network. The version arrives as ?v= on the registration URL, which keeps
   version.js the only place the number is written. */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `meridian-${VERSION}`;

/* The geography is the expensive part of a cold start and it never changes
   between releases, so it is precached alongside the code. */
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./version.js",
  "./icon.svg",
  "./manifest.webmanifest",
  "./globe/backend.js",
  "./globe/camera.js",
  "./globe/geo.js",
  "./globe/layers.js",
  "./globe/params.js",
  "./globe/poster.js",
  "./globe/webgl2.js",
  "./globe/webgpu.js",
  "./data/borders.bin",
  "./data/idmap.bin",
  "./data/countries.json",
  "./data/network.json",
  "./fonts/fonts.css",
  "./fonts/archivo-variable.woff2",
  "./fonts/public-sans-400.woff2",
  "./fonts/public-sans-500.woff2",
  "./fonts/plex-mono-400.woff2",
  "./fonts/plex-mono-500.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request, { ignoreSearch: true });
      /* Serve from cache immediately, then refresh in the background. The next
         visit gets the newer file; this one does not wait for it. */
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});

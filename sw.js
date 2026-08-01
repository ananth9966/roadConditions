/* Service worker for Turtle Mountain Road Conditions.
 *
 * The whole point of this app is to be useful on a county road in bad weather,
 * which is exactly where signal disappears. Everything needed to render the
 * map and the road network is cached so the app opens with no connection.
 *
 * Bump CACHE_VERSION whenever the shell or the road data changes; old caches
 * are deleted on activate.
 */
const CACHE_VERSION = "v1";
const SHELL_CACHE = `rc-shell-${CACHE_VERSION}`;
const VENDOR_CACHE = `rc-vendor-${CACHE_VERSION}`;
const TILE_CACHE = `rc-tiles-${CACHE_VERSION}`;

// Tiles are unbounded, so the cache is trimmed to keep storage sane. Roughly
// enough for the county at the zoom levels people actually drive with.
const MAX_TILES = 400;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./data/rolette_segments.geojson",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/favicon-32.png",
];

// Version-pinned, so cache-first is safe and permanent.
const VENDOR_ASSETS = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js",
];

const isTile = (url) => url.hostname.endsWith("tile.openstreetmap.org");

// Firestore talks over its own long-lived channels and has its own offline
// layer. Intercepting it would break both.
const isFirestore = (url) =>
  url.hostname.endsWith("firestore.googleapis.com") ||
  url.hostname.endsWith("googleapis.com") ||
  url.hostname.endsWith("firebaseio.com");

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // addAll is atomic: one 404 would fail the whole install, so each asset is
    // fetched individually and a miss is logged rather than fatal.
    await Promise.all(SHELL_ASSETS.map(async (path) => {
      try {
        await shell.add(new Request(path, { cache: "reload" }));
      } catch (err) {
        console.warn("[sw] could not precache", path, err);
      }
    }));

    const vendor = await caches.open(VENDOR_CACHE);
    await Promise.all(VENDOR_ASSETS.map(async (url) => {
      try {
        await vendor.add(url);
      } catch (err) {
        console.warn("[sw] could not precache vendor asset", url, err);
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, VENDOR_CACHE, TILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

async function trimCache(cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  // Roughly FIFO: keys() returns insertion order.
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response && (response.ok || response.type === "opaque")) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isFirestore(url)) return;               // let Firestore manage itself

  // Map tiles: serve cached, fall back to network, and keep the cache bounded.
  if (isTile(url)) {
    event.respondWith((async () => {
      try {
        const res = await cacheFirst(request, TILE_CACHE);
        trimCache(TILE_CACHE, MAX_TILES);
        return res;
      } catch {
        // A missing tile just leaves a grey square; the app still works.
        return new Response("", { status: 504, statusText: "tile unavailable" });
      }
    })());
    return;
  }

  // Vendor libraries are version-pinned, so a cache hit is always correct.
  if (VENDOR_ASSETS.includes(url.href)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE));
    return;
  }

  // Navigations: try the network so updates land promptly, but always have
  // the cached shell to fall back on.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put("./index.html", fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match("./index.html")) ||
               (await cache.match("./")) ||
               Response.error();
      }
    })());
    return;
  }

  // Everything else same-origin: cache first, revalidating in the background.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      return hit || (await network) || Response.error();
    })());
  }
});

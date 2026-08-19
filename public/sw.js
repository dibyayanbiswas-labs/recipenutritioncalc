// Hand-written service worker (no build step / Workbox) — bump these version suffixes
// whenever the caching strategy below changes, to force old caches to be dropped on activate.
const STATIC_CACHE = 'rnc-static-v1';
const PAGES_CACHE = 'rnc-pages-v1';

const PRECACHE_URLS = ['/offline.html', '/manifest.webmanifest', '/favicon.svg', '/favicon.ico', '/icons/icon-192.png', '/icons/icon-512.png'];

// Content-hashed build output (/_astro/*) and other local static files — safe to cache-first
// since a changed file always gets a new URL.
const STATIC_ASSET_RE = /\/_astro\/|\/icons\/|\.(?:png|jpe?g|svg|webp|gif|woff2?|ico)$/;

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(STATIC_CACHE);
			// allSettled so one missing/offline asset doesn't fail the whole install.
			await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((key) => key !== STATIC_CACHE && key !== PAGES_CACHE).map((key) => caches.delete(key)));
			await self.clients.claim();
		})(),
	);
});

async function networkFirstNavigate(request) {
	const cache = await caches.open(PAGES_CACHE);
	try {
		const response = await fetch(request);
		if (response && response.ok) cache.put(request, response.clone());
		return response;
	} catch {
		return (await cache.match(request)) || (await caches.match('/offline.html'));
	}
}

async function cacheFirst(request) {
	const cache = await caches.open(STATIC_CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response && response.ok) cache.put(request, response.clone());
	return response;
}

self.addEventListener('fetch', (event) => {
	const { request } = event;

	// Only ever intercept same-origin GETs — this leaves the app's POST form actions
	// (recipe analysis) and any cross-origin requests to go straight to the network untouched.
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (request.mode === 'navigate' || request.destination === 'document') {
		event.respondWith(networkFirstNavigate(request));
		return;
	}

	if (STATIC_ASSET_RE.test(url.pathname)) {
		event.respondWith(cacheFirst(request));
	}
});

"use strict";

const VERSION = "v13-2026-09-11";
const SCOPE_URL = new URL(self.registration.scope);
const APP_URL = new URL("./gym.html", SCOPE_URL);
// Encoding the complete scope, with a delimiter, isolates parent/child installs too.
const CACHE_PREFIX = `recomp-shell:${encodeURIComponent(SCOPE_URL.href)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_URLS = [
  "./gym.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
].map((path) => new URL(path, SCOPE_URL).href);
const SHELL_BY_PATH = new Map(
  SHELL_URLS.map((url) => [new URL(url).pathname, url]),
);
const NETWORK_TIMEOUT_MS = 5000;

function isAppURL(url) {
  return url.origin === SCOPE_URL.origin &&
    (url.pathname === APP_URL.pathname || url.pathname === SCOPE_URL.pathname);
}

function shellURLForRequest(request) {
  if (request.method !== "GET") return null;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.origin !== SCOPE_URL.origin) return null;
  if (request.mode === "navigate" && isAppURL(url)) return APP_URL.href;

  // Non-navigation HTML, data, notes, versions, and external assets are untouched.
  const shellURL = SHELL_BY_PATH.get(url.pathname);
  return shellURL && shellURL !== APP_URL.href ? shellURL : null;
}

function isShellResponse(response, url) {
  return response.ok && response.status !== 206 && !response.redirected &&
    (!response.url || response.url === url);
}

async function fetchShell(url) {
  const controller = new AbortController();
  let timer;
  // This short deadline bounds a request; it does not schedule notifications.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("App shell request timed out"));
    }, NETWORK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      (async () => {
        // Fetch only canonical allowlisted URLs, never query-dependent data or redirects.
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          signal: controller.signal,
        });
        if (!isShellResponse(response, url)) {
          throw new Error("App shell response is not cacheable");
        }
        // Include the body in the deadline so stalled downloads also fall back.
        await response.clone().arrayBuffer();
        return response;
      })(),
      deadline,
    ]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function installShell() {
  // Validate the whole shell before writing anything. A failed install cannot activate.
  const responses = await Promise.all(SHELL_URLS.map(fetchShell));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(SHELL_URLS.map((url, index) => cache.put(url, responses[index])));
  await self.skipWaiting();
}

function isOlderCache(name) {
  if (!name.startsWith(CACHE_PREFIX)) return false;
  const previous = /^v(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(name.slice(CACHE_PREFIX.length));
  const current = /^v(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(VERSION);
  if (!previous || !current) return false;
  return Number(previous[1]) < Number(current[1]) ||
    (Number(previous[1]) === Number(current[1]) && previous[2] < current[2]);
}

async function activateShell() {
  const names = await caches.keys();
  // Preserve other scopes, unrelated caches, and any newer worker's generation.
  await Promise.all(names.filter(isOlderCache).map((name) => caches.delete(name)));
  await self.clients.claim();
}

async function cachedOrUnavailable(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(url);
    if (response && isShellResponse(response, url)) return response;
  } catch {
    // Cache storage can be unavailable or evicted; still return a defined response.
  }
  return new Response("Recomp is unavailable. Connect to the internet and try again.", {
    status: 503,
    statusText: "Service Unavailable",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateShell());
});

self.addEventListener("fetch", (event) => {
  const url = shellURLForRequest(event.request);
  if (!url) return;

  const network = fetchShell(url).then((response) => ({
    response,
    forCache: response.clone(),
  }));
  event.respondWith(network.then(
    ({ response }) => response,
    () => cachedOrUnavailable(url),
  ));
  // Register synchronously. Storage failures must not discard a usable network response.
  event.waitUntil(network.then(async ({ forCache }) => {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, forCache);
  }).catch(() => {}));
});

async function openApp(view) {
  let windows = [];
  try {
    windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch {
    // If enumeration fails, the fixed app URL remains a safe fallback.
  }
  for (const client of windows) {
    let url;
    try {
      url = new URL(client.url);
    } catch {
      continue;
    }
    if (!isAppURL(url)) continue;
    try {
      const focused = await client.focus();
      (focused || client).postMessage({ type: "recomp-open", view });
      return;
    } catch {
      // A tab may close between enumeration and focus; try another matching tab.
    }
  }
  await self.clients.openWindow(new URL(`./gym.html?view=${view}`, SCOPE_URL).href);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const view = event.notification.data?.view === "rest" ? "rest" : "today";
  // Notifications originate in the opt-in page. endsAt is metadata, not an alarm.
  // Never read a URL from notification data or navigate/reload an existing tab.
  event.waitUntil(openApp(view).catch(() => {}));
});
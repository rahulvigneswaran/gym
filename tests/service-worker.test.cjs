"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = readFileSync(path.join(ROOT, "service-worker.js"), "utf8");
const VERSION = "v13-2026-09-11";
const DEFAULT_SCOPE = "https://example.test/gym/";
const SHELL_FILES = [
  "gym.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];
const shellURLs = (scope) => SHELL_FILES.map((file) => new URL(file, scope).href);
const cacheName = (scope, version = VERSION) =>
  `recomp-shell:${encodeURIComponent(new URL(scope).href)}:${version}`;
const offline = async () => { throw new TypeError("Network unavailable"); };

function createStorage() {
  const buckets = new Map();
  const puts = [];
  const deleted = [];
  const keyOf = (request) => typeof request === "string" ? request : request.url;
  const bucketFor = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  };
  return {
    buckets,
    puts,
    deleted,
    seed(name, url, response = new Response("cached")) {
      bucketFor(name).set(url, response);
    },
    api: {
      async open(name) {
        const bucket = bucketFor(name);
        return {
          async match(request) {
            return bucket.get(keyOf(request))?.clone();
          },
          async put(request, response) {
            puts.push({ name, url: keyOf(request), status: response.status });
            const stored = response.clone();
            // Consume the supplied body like Cache.put, catching missing production clones.
            await response.arrayBuffer();
            bucket.set(keyOf(request), stored);
          },
        };
      },
      async keys() { return [...buckets.keys()]; },
      async delete(name) {
        deleted.push(name);
        return buckets.delete(name);
      },
    },
  };
}

function windowClient(url, { focusFails = false, messageFails = false } = {}) {
  return {
    url,
    focused: 0,
    messages: [],
    async focus() {
      this.focused += 1;
      if (focusFails) throw new Error("Tab closed");
      return this;
    },
    postMessage(message) {
      if (messageFails) throw new Error("Tab closed");
      this.messages.push({ ...message });
    },
  };
}

function createWorker(options = {}) {
  const scope = options.scope || DEFAULT_SCOPE;
  const storage = options.storage || createStorage();
  const handlers = new Map();
  const timers = new Map();
  let timerId = 0;
  const state = { fetches: [], opened: [], matched: [], claimed: 0, skipped: 0, closed: 0 };
  const self = {
    registration: { scope },
    addEventListener(type, handler) { handlers.set(type, handler); },
    async skipWaiting() { state.skipped += 1; },
    clients: {
      async claim() { state.claimed += 1; },
      async matchAll(settings) {
        state.matched.push({ ...settings });
        if (options.matchAllFails) throw new Error("Enumeration unavailable");
        return options.windows || [];
      },
      async openWindow(url) {
        state.opened.push(url);
        if (options.openWindowFails) throw new Error("Opening a window was blocked");
        return windowClient(url);
      },
    },
  };
  const context = vm.createContext({
    self,
    caches: storage.api,
    URL,
    Response,
    AbortController,
    fetch(url, settings) {
      state.fetches.push({ url, settings });
      return options.fetch ? options.fetch(url, settings) : Promise.resolve(new Response(`network:${url}`));
    },
    // Deterministic network deadlines: no real sleeps, servers, or network requests.
    setTimeout(callback, milliseconds) {
      const id = ++timerId;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(SOURCE, context, { filename: "service-worker.js" });

  function dispatch(type, properties = {}) {
    const lifetime = [];
    let response;
    let dispatching = true;
    const event = {
      ...properties,
      waitUntil(promise) {
        assert.ok(dispatching, "waitUntil must be registered during dispatch");
        lifetime.push(Promise.resolve(promise));
      },
      respondWith(promise) {
        assert.ok(dispatching, "respondWith must be registered during dispatch");
        assert.equal(response, undefined, "respondWith may only be called once");
        response = Promise.resolve(promise);
      },
    };
    handlers.get(type)?.(event);
    dispatching = false;
    return { response, done: Promise.all(lifetime), waitUntilCount: lifetime.length };
  }

  return {
    scope,
    storage,
    state,
    timers,
    handlers,
    dispatch,
    install() { return dispatch("install").done; },
    activate() { return dispatch("activate").done; },
    request(url, settings = {}) {
      return dispatch("fetch", { request: { url, method: "GET", mode: "navigate", ...settings } });
    },
    click(data) {
      return dispatch("notificationclick", {
        notification: { data, close() { state.closed += 1; } },
      });
    },
    expireTimers() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test("manifest has relative install identity, dark standalone appearance, and real sized icons", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "Recomp");
  assert.equal(manifest.short_name, "Recomp");
  assert.equal(manifest.id, "./gym.html");
  assert.equal(manifest.start_url, "./gym.html");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#000000");
  assert.equal(manifest.theme_color, "#8B8CFF");
  assert.deepEqual(manifest.icons.map(({ src, sizes, purpose }) => [src, sizes, purpose]), [
    ["./icon-192.png", "192x192", "any"],
    ["./icon-512.png", "512x512", "any"],
    ["./icon-maskable-512.png", "512x512", "maskable"],
  ]);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    const png = readFileSync(path.resolve(ROOT, icon.src));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
});

test("install caches exactly the six local shell files, never JSON, notes, or versions", async () => {
  const worker = createWorker();
  await worker.install();
  const expected = shellURLs(worker.scope).sort();
  assert.deepEqual(worker.state.fetches.map(({ url }) => url).sort(), expected);
  assert.deepEqual([...worker.storage.buckets.keys()], [cacheName(worker.scope)]);
  assert.deepEqual([...worker.storage.buckets.get(cacheName(worker.scope)).keys()].sort(), expected);
  assert.equal(worker.storage.puts.length, 6);
  for (const { url, settings } of worker.state.fetches) {
    assert.equal(new URL(url).origin, new URL(worker.scope).origin);
    assert.doesNotMatch(new URL(url).pathname, /\.json$|notes|versions\//i);
    assert.equal(settings.redirect, "error");
    assert.equal(settings.cache, "no-store");
    assert.equal(settings.mode, "same-origin");
    assert.equal(settings.credentials, "same-origin");
    assert.equal(settings.signal.aborted, false);
  }
  assert.equal(worker.state.skipped, 1);
  assert.equal(worker.timers.size, 0);
});

test("a missing or failed shell resource rejects installation without activating or writing", async () => {
  for (const status of [404, 503]) {
    const worker = createWorker({
      fetch: async (url) => new Response("response", { status: url.endsWith(".webmanifest") ? status : 200 }),
    });
    await assert.rejects(worker.install(), /not cacheable/);
    assert.equal(worker.state.skipped, 0);
    assert.equal(worker.storage.puts.length, 0);
  }
  const worker = createWorker({ fetch: offline });
  await assert.rejects(worker.install(), /Network unavailable/);
  assert.equal(worker.storage.puts.length, 0);
  assert.equal(worker.state.skipped, 0);
});

test("activation deletes only older generations owned by this exact scope", async () => {
  const worker = createWorker();
  const old = ["v1-2026-08-25", "v12-2026-08-27", "v13-2026-09-10"].map((v) => cacheName(worker.scope, v));
  const preserved = [
    cacheName(worker.scope),
    cacheName(worker.scope, "v14-2026-09-12"),
    cacheName(worker.scope, "v13-2026-09-12"),
    cacheName(worker.scope, "user-data"),
    cacheName("https://example.test/", "v12-2026-08-27"),
    cacheName("https://example.test/gym-two/", "v12-2026-08-27"),
    cacheName("https://example.test/gym/child/", "v12-2026-08-27"),
    cacheName("https://other.test/gym/", "v12-2026-08-27"),
    "another-app-cache",
  ];
  for (const name of [...old, ...preserved]) worker.storage.seed(name, "https://example.test/sentinel");
  await worker.activate();
  assert.deepEqual(worker.storage.deleted.sort(), old.sort());
  assert.deepEqual([...worker.storage.buckets.keys()].sort(), preserved.sort());
  assert.equal(worker.state.claimed, 1);
  assert.equal(worker.state.opened.length, 0);
});

test("network-first navigation refreshes one canonical shell key, including scope-root queries", async () => {
  for (const relative of ["gym.html?view=rest#timer", "./?export=progress.json"]) {
    const worker = createWorker({ fetch: async () => new Response("fresh shell") });
    const app = new URL("gym.html", worker.scope).href;
    worker.storage.seed(cacheName(worker.scope), app, new Response("old shell"));
    const event = worker.request(new URL(relative, worker.scope).href);
    assert.equal(event.waitUntilCount, 1);
    assert.equal(await (await event.response).text(), "fresh shell");
    await event.done;
    assert.deepEqual(worker.state.fetches.map(({ url }) => url), [app]);
    const bucket = worker.storage.buckets.get(cacheName(worker.scope));
    assert.deepEqual([...bucket.keys()], [app]);
    assert.equal(await bucket.get(app).clone().text(), "fresh shell");
  }
});

test("offline app and root navigation ignore queries and use only this scope's cached gym shell", async () => {
  for (const relative of ["gym.html", "gym.html?view=rest", "./", "./?view=today"]) {
    const worker = createWorker({ fetch: offline });
    const app = new URL("gym.html", worker.scope).href;
    worker.storage.seed(cacheName(worker.scope), app, new Response("offline gym"));
    const event = worker.request(new URL(relative, worker.scope).href);
    assert.equal(await (await event.response).text(), "offline gym");
    await event.done;
    assert.equal(worker.storage.puts.length, 0);
    assert.equal(worker.timers.size, 0);
  }
});

test("missing offline shell returns uncached 503, not another cache's response", async () => {
  const worker = createWorker({ fetch: offline });
  const app = new URL("gym.html", worker.scope).href;
  worker.storage.seed("unrelated-cache", app, new Response("must not leak"));
  worker.storage.seed(cacheName(worker.scope, "v12-2026-08-27"), app, new Response("old generation"));
  for (const url of [worker.scope, ...shellURLs(worker.scope)]) {
    const event = worker.request(url);
    const response = await event.response;
    assert.equal(response.status, 503, url);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Type"), /text\/plain/);
    await event.done;
  }
  assert.equal(worker.storage.puts.length, 0);
});

test("HTTP errors and partial responses fall back without ever being cached", async () => {
  for (const status of [206, 404, 500, 503]) {
    for (const cached of [false, true]) {
      const worker = createWorker({ fetch: async () => new Response("bad response", { status }) });
      const app = new URL("gym.html", worker.scope).href;
      if (cached) worker.storage.seed(cacheName(worker.scope), app, new Response("good cached shell"));
      const event = worker.request(app);
      const response = await event.response;
      assert.equal(response.status, cached ? 200 : 503);
      if (cached) assert.equal(await response.text(), "good cached shell");
      await event.done;
      assert.equal(worker.storage.puts.length, 0);
    }
  }
});

test("redirected or foreign response URLs cannot populate the shell cache", async () => {
  for (const redirected of [false, true]) {
    for (const url of ["https://example.test/gym/notes.json", "https://other.test/gym/gym.html"]) {
      const response = new Response("not the app shell");
      Object.defineProperties(response, { redirected: { value: redirected }, url: { value: url } });
      const worker = createWorker({ fetch: async () => response });
      const event = worker.request(new URL("gym.html", worker.scope).href);
      assert.equal((await event.response).status, 503);
      await event.done;
      assert.equal(worker.storage.puts.length, 0);
      assert.equal(worker.state.fetches[0].settings.redirect, "error");
    }
  }
});

test("fetch ignores data, notes, versions, other paths/origins, non-GETs, and HTML subresources", async () => {
  const worker = createWorker();
  const ignored = [
    ...[
      "notes.json", "notes2.json", "recomp-2026-09-11.json", "notes.md", "notes.pdf",
      "rahul_notes.md", "versions/gym_v12.html", "service-worker.js", "unknown.png",
      "icons/icon-192.png", "child/gym.html", "notes.json?file=gym.html", "%67ym.html",
    ].map((relative) => [new URL(relative, worker.scope).href, {}]),
    ["https://other.test/gym/gym.html", {}],
    ["https://other.test/gym/icon-192.png", {}],
    ["https://example.test/elsewhere/gym.html", {}],
    ["https://example.test/gym-two/gym.html", {}],
    ["https://example.test/gym", {}],
    ["https://example.test/gym/", { mode: "cors" }],
    ["https://example.test/gym/gym.html", { mode: "same-origin" }],
    ["https://example.test/gym/gym.html", { method: "POST" }],
    ["https://example.test/gym/gym.html", { method: "HEAD" }],
    ["https://example.test/gym/manifest.webmanifest", { method: "PUT" }],
    ["https://example.test/gym/icon-192.png", { method: "DELETE" }],
    ["not a URL", {}],
  ];
  for (const [url, settings] of ignored) {
    const event = worker.request(url, settings);
    assert.equal(event.response, undefined, url);
    assert.equal(event.waitUntilCount, 0, url);
    await event.done;
  }
  assert.equal(worker.state.fetches.length, 0);
  assert.equal(worker.storage.buckets.size, 0);
});

test("manifest and each named icon are network-first and have their own query-free offline fallback", async () => {
  let online = true;
  const worker = createWorker({ fetch: async (url) => online ? new Response(url) : offline() });
  const assets = shellURLs(worker.scope).slice(1);
  for (const url of assets) {
    const event = worker.request(`${url}?v=13`, { mode: "cors" });
    assert.equal(await (await event.response).text(), url);
    await event.done;
  }
  online = false;
  for (const url of assets) {
    const event = worker.request(`${url}?v=another`, { mode: "same-origin" });
    assert.equal(await (await event.response).text(), url);
    await event.done;
  }
  assert.deepEqual([...worker.storage.buckets.get(cacheName(worker.scope)).keys()], assets);
  assert.equal(worker.storage.puts.length, assets.length);
});

test("an app document cannot substitute for a missing icon or manifest", async () => {
  const worker = createWorker({ fetch: offline });
  worker.storage.seed(cacheName(worker.scope), new URL("gym.html", worker.scope).href);
  for (const url of shellURLs(worker.scope).slice(1)) {
    const event = worker.request(url, { mode: "cors" });
    assert.equal((await event.response).status, 503);
    await event.done;
  }
});

test("cache storage failures preserve good network responses and resolve offline requests to 503", async () => {
  for (const online of [false, true]) {
    for (const failure of ["open", "operations"]) {
      const worker = createWorker({ fetch: online ? async () => new Response("usable network") : offline });
      worker.storage.api.open = async () => {
        if (failure === "open") throw new Error("Storage disabled");
        return {
          async put() { throw new Error("Quota exceeded"); },
          async match() { throw new Error("Read failed"); },
        };
      };
      const event = worker.request(new URL("gym.html", worker.scope).href);
      const response = await event.response;
      assert.equal(response.status, online ? 200 : 503);
      if (online) assert.equal(await response.text(), "usable network");
      await event.done;
    }
  }
});

test("a bad cached response is not an offline fallback", async () => {
  const worker = createWorker({ fetch: offline });
  const app = new URL("gym.html", worker.scope).href;
  worker.storage.seed(cacheName(worker.scope), app, new Response("cached error", { status: 500 }));
  const event = worker.request(app);
  assert.equal((await event.response).status, 503);
  await event.done;
});

test("cache writes extend event lifetime without blocking the network response", { timeout: 2000 }, async (t) => {
  const worker = createWorker({ fetch: async () => new Response("fresh") });
  let release;
  const writeGate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const originalOpen = worker.storage.api.open;
  worker.storage.api.open = async (name) => {
    const cache = await originalOpen(name);
    return { ...cache, async put(...args) { await writeGate; return cache.put(...args); } };
  };
  const event = worker.request(new URL("gym.html", worker.scope).href);
  let finished = false;
  event.done.then(() => { finished = true; });
  assert.equal(await (await event.response).text(), "fresh");
  assert.equal(event.waitUntilCount, 1);
  assert.equal(finished, false);
  release();
  await event.done;
  assert.equal(worker.storage.puts.length, 1);
});

test("a hung network is aborted and bounded even if fetch ignores its abort signal", async () => {
  for (const cached of [false, true]) {
    const worker = createWorker({ fetch: () => new Promise(() => {}) });
    const app = new URL("gym.html", worker.scope).href;
    if (cached) worker.storage.seed(cacheName(worker.scope), app, new Response("offline shell"));
    const event = worker.request(app);
    assert.equal(worker.timers.size, 1);
    const [{ milliseconds }] = [...worker.timers.values()];
    assert.ok(milliseconds > 0 && milliseconds <= 5000);
    worker.expireTimers();
    const response = await event.response;
    assert.equal(response.status, cached ? 200 : 503);
    if (cached) assert.equal(await response.text(), "offline shell");
    await event.done;
    assert.equal(worker.state.fetches[0].settings.signal.aborted, true);
    assert.equal(worker.timers.size, 0);
    assert.equal(worker.storage.puts.length, 0);
  }
});

test("root and encoded subpath deployments have distinct caches and correct relative shell URLs", async () => {
  const storage = createStorage();
  const workers = ["https://example.test/", "https://example.test/my%20gym/"].map((scope) => createWorker({ scope, storage }));
  for (const worker of workers) {
    await worker.install();
    await worker.activate();
    assert.deepEqual(worker.state.fetches.map(({ url }) => url), shellURLs(worker.scope));
    await worker.click({ view: "rest", endsAt: 123 }).done;
    assert.deepEqual(worker.state.opened, [new URL("./gym.html?view=rest", worker.scope).href]);
  }
  assert.deepEqual([...storage.buckets.keys()].sort(), workers.map(({ scope }) => cacheName(scope)).sort());
});

test("notification clicks close, focus an exact app/root tab, and post only the sanitized view", async () => {
  for (const relative of ["gym.html?view=today#section", "./?view=today"]) {
    for (const view of ["today", "rest"]) {
      const unrelated = windowClient("https://example.test/gym/notes.md");
      const app = windowClient(new URL(relative, DEFAULT_SCOPE).href);
      const worker = createWorker({ windows: [unrelated, app] });
      const event = worker.click({ view, endsAt: 9999999999999, url: "https://other.test/" });
      assert.equal(worker.state.closed, 1);
      assert.equal(event.waitUntilCount, 1);
      await event.done;
      assert.equal(unrelated.focused, 0);
      assert.equal(app.focused, 1);
      assert.deepEqual(app.messages, [{ type: "recomp-open", view }]);
      assert.deepEqual(worker.state.matched, [{ type: "window", includeUncontrolled: true }]);
      assert.deepEqual(worker.state.opened, []);
      assert.equal(worker.timers.size, 0);
      assert.equal(worker.state.fetches.length, 0);
    }
  }
});

test("new-window notification targets never come from payload URLs or arbitrary views", async () => {
  const cases = [
    [undefined, "today"],
    [null, "today"],
    [{}, "today"],
    [{ view: "today", url: "https://other.test/", endsAt: 0 }, "today"],
    [{ view: "rest", url: "https://other.test/", endsAt: 9999999999999 }, "rest"],
    [{ view: "rest", url: "./notes.json", endsAt: "not a timestamp" }, "rest"],
    [{ view: "https://other.test/", url: "javascript:alert(1)" }, "today"],
    [{ view: "rest&url=https://other.test/", url: "//other.test/" }, "today"],
    [{ view: ["rest"], url: "/notes.md" }, "today"],
    [{ view: "REST", url: "../gym-two/gym.html" }, "today"],
  ];
  for (const [data, view] of cases) {
    const windows = [
      "https://other.test/gym/gym.html",
      "https://example.test/gym-two/gym.html",
      "https://example.test/gym/child/gym.html",
      "https://example.test/gym/notes.md",
      "https://example.test/gym/manifest.webmanifest",
      "https://example.test/gym",
      "https://example.test/",
      "not a URL",
    ].map((url) => windowClient(url));
    const worker = createWorker({ windows });
    await worker.click(data).done;
    assert.equal(worker.state.closed, 1);
    assert.ok(windows.every((client) => client.focused === 0 && client.messages.length === 0));
    assert.deepEqual(worker.state.opened, [new URL(`./gym.html?view=${view}`, worker.scope).href]);
    assert.equal(worker.timers.size, 0);
  }
});

test("closed app tabs do not prevent focusing the next matching tab", async () => {
  const appURL = new URL("gym.html", DEFAULT_SCOPE).href;
  const closed = windowClient(appURL, { focusFails: true });
  const live = windowClient(`${appURL}?view=today`);
  const worker = createWorker({ windows: [closed, live] });
  await worker.click({ view: "rest" }).done;
  assert.equal(closed.focused, 1);
  assert.equal(live.focused, 1);
  assert.deepEqual(live.messages, [{ type: "recomp-open", view: "rest" }]);
  assert.deepEqual(worker.state.opened, []);
});

test("failed focus, messaging, or client enumeration falls back to the fixed app URL", async () => {
  const appURL = new URL("gym.html", DEFAULT_SCOPE).href;
  for (const options of [
    { windows: [windowClient(appURL, { focusFails: true })] },
    { windows: [windowClient(appURL, { messageFails: true })] },
    { matchAllFails: true },
  ]) {
    const worker = createWorker(options);
    await worker.click({ view: "today", url: "https://other.test/" }).done;
    assert.deepEqual(worker.state.opened, [`${appURL}?view=today`]);
  }
});

test("blocked window opening does not leave a rejected notification event", async () => {
  const worker = createWorker({ openWindowFails: true });
  await worker.click({ view: "rest" }).done;
  assert.equal(worker.state.closed, 1);
  assert.deepEqual(worker.state.opened, [new URL("gym.html?view=rest", worker.scope).href]);
});

test("worker registers no push or alarm handlers and starts no background timers", () => {
  const worker = createWorker();
  assert.deepEqual([...worker.handlers.keys()].sort(), ["activate", "fetch", "install", "notificationclick"]);
  assert.equal(worker.timers.size, 0);
  assert.equal(worker.state.fetches.length, 0);
});
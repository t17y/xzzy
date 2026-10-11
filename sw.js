/**
 * Service Worker：应用外壳预缓存（cache-first）+ 导航请求网络优先
 * 提示词 3.2：离线时学习 / 复习 / 卡片翻看全部可用；动态数据一律走 IndexedDB。
 *
 * 版本策略：修改 CACHE_VERSION 即发布新版本，页面侧会收到更新提示（见 main.js）。
 */
const CACHE_VERSION = "xzzy-v1.1.0";
const CACHE_NAME = `xzzy-cache-${CACHE_VERSION}`;

/** 应用外壳（离线必需） */
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./js/main.js",
  "./js/config.js",
  "./js/core/util.js",
  "./js/core/db.js",
  "./js/core/dom.js",
  "./js/core/env.js",
  "./js/core/events.js",
  "./js/core/router.js",
  "./js/core/state.js",
  "./js/core/game.js",
  "./js/core/level.js",
  "./js/core/scheduler.js",
  "./js/core/notify.js",
  "./js/core/cards.js",
  "./js/core/analytics.js",
  "./js/import/markdown.js",
  "./js/import/parse-result.js",
  "./js/import/pipeline.js",
  "./js/import/structure.js",
  "./js/import/table.js",
  "./js/views/home.js",
  "./js/views/import-view.js",
  "./js/views/learn.js",
  "./js/views/session.js",
  "./js/views/review.js",
  "./js/views/review-session.js",
  "./js/views/wrong.js",
  "./js/views/shelf.js",
  "./js/views/reader.js",
  "./js/views/card-edit.js",
  "./js/views/badges.js",
  "./js/views/stats.js",
  "./js/views/about.js",
  "./js/views/placeholders.js",
  "./js/views/settings.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/favicon-32.png",
  "./templates/内容导入模板.md",
  "./templates/内容导入模板.csv",
  "./templates/内容导入模板.xlsx",
  "./templates/内容导入模板.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 单个资源失败不阻断整体安装
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[sw] 预缓存失败：", url, err.message);
          })
        )
      );
      // 不自动 skipWaiting：等页面提示用户后由页面发消息触发
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("xzzy-cache-") && k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 只处理同源请求；第三方（如 SheetJS CDN）走网络
  if (url.origin !== self.location.origin) return;

  // 导航请求：网络优先（拿到最新外壳），失败回落缓存（离线可用）
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：cache-first，后台更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) {
        event.waitUntil(
          (async () => {
            try {
              const fresh = await fetch(req);
              if (fresh && fresh.ok) await cache.put(req, fresh.clone());
            } catch {
              /* 离线忽略 */
            }
          })()
        );
        return cached;
      }
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === "basic") await cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return new Response("离线且未缓存该资源", { status: 504, headers: { "Content-Type": "text/plain;charset=utf-8" } });
      }
    })()
  );
});

/** 供页面查询版本（设置页「检查更新」） */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({ version: CACHE_VERSION });
  }
});

/** 点击通知 → 聚焦已有窗口或打开复习页（提示词 5.3） */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || "./#/review";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});

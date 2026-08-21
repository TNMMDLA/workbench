/* =====================================================
   AQ WORKBENCH · Service Worker
   缓存策略：
   - 静态资源（/static/*、/）→ cache-first（更新时随版本清旧）
   - 数据接口白名单 → network-first（在线更新缓存，离线回退缓存）
   - 敏感内容（文件下载 /share/ 等）→ 永不缓存
   - 非 GET 请求 → 永不缓存
   ===================================================== */

const VERSION = "1.0.14";
const CACHE = `aq-workbench-${VERSION}`;

// 预缓存：应用外壳 + 全部静态资源
const PRECACHE = [
  "/",
  "/static/style.css",
  "/static/script.js",
  "/static/calendar.js",
  "/static/files.js",
  "/static/notifications.js",
  "/static/manifest.json",
  "/static/offline.html",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-maskable-512.png",
  "/static/icons/apple-touch-icon.png",
];

// 允许缓存的数据接口（GET 元数据）
const API_CACHE = ["/api/data", "/api/overview", "/api/notifications", "/api/files", "/api/calendar"];

// 禁止缓存的敏感路径（文件内容、分享下载、上传等）
const NO_CACHE = ["/api/files/", "/share/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// 前端点"立即更新"后激活新版本
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch (e) {
    // 离线且无缓存：导航请求回退离线页
    if (req.mode === "navigate") {
      const offline = await caches.match("/static/offline.html");
      if (offline) return offline;
    }
    return new Response("离线且无缓存", { status: 503 });
  }
}

async function networkFirst(req) {
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // 兜底：导航请求回退离线页
    if (req.mode === "navigate") {
      const offline = await caches.match("/static/offline.html");
      if (offline) return offline;
    }
    return new Response(JSON.stringify({ offline: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // 上传/修改等绝不缓存

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域不处理

  // 敏感路径：网络直连，不缓存
  if (NO_CACHE.some((p) => url.pathname.startsWith(p))) return;

  // 静态资源 + 页面：cache-first
  if (url.pathname.startsWith("/static/") || url.pathname === "/") {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 数据接口白名单：network-first（离线回退缓存）
  if (API_CACHE.some((p) => url.pathname === p || url.pathname.startsWith(p + "?"))) {
    event.respondWith(networkFirst(req));
    return;
  }
});

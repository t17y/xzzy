/**
 * 哈希路由：页面注册 + 切换 + 顶部栏/底部 Tab 同步
 * 说明：纯前端单页应用，路由状态写在 location.hash，便于「添加到主屏幕」后恢复
 * @module core/router
 */

import { $, setHtml, setText, show } from "./dom.js";
import { emit, EV } from "./events.js";
import { kv } from "./db.js";

/** @type {Map<string, {title?:string, tab?:string|null, topbar?:boolean, render:(ctx:object)=>any, params?:string[]}>} */
const routes = new Map();
let current = null;

/** 注册页面 */
export function route(path, config) {
  routes.set(path, { topbar: true, tab: null, ...config });
}

export function registerRoutes(list) {
  for (const [path, config] of list) route(path, config);
}

/** 解析 hash → { path, params, query } */
export function parseHash(hash = location.hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const path = segments.length ? `/${segments[0]}` : "/home";
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split("&")) {
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  }
  return { path, params: segments.slice(1), query };
}

/** 跳转 */
export function navigate(path, query) {
  const qs = query
    ? `?${Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")}`
    : "";
  const target = `#${path.startsWith("/") ? path : `/${path}`}${qs}`;
  if (location.hash === target) render();
  else location.hash = target;
}

export function back() {
  if (history.length > 1) history.back();
  else navigate("/home");
}

/** 当前路由信息 */
export function currentRoute() {
  return current;
}

/** 渲染当前路由 */
export async function render() {
  const { path, params, query } = parseHash();
  let key = path;
  let config = routes.get(key);
  if (!config) {
    // 支持 /learn/point 之类的子页面
    key = `/${(location.hash || "").replace(/^#\/?/, "").split("?")[0]}`;
    config = routes.get(key);
  }
  if (!config) {
    config = routes.get("/home");
    key = "/home";
  }
  const ctx = { path: key, params, query, config };
  current = ctx;
  kv.set("lastRoute", key);

  const view = $("#view");
  const topbar = $("#topbar");
  show(topbar, config.topbar !== false);
  setText($("#topbar-title"), config.title || "知彩");
  const backBtn = $("#topbar-back");
  show(backBtn, !!config.back);

  // 上一个页面的清理
  if (typeof current?.config?.unmount === "function") {
    try {
      current.config.unmount();
    } catch (err) {
      console.error("[router] unmount 失败", err);
    }
  }

  view.innerHTML = "";
  syncTabbar(config.tab);
  emit(EV.NAV, ctx);

  try {
    const html = await config.render(ctx);
    if (typeof html === "string") setHtml(view, html);
    if (typeof config.mount === "function") await config.mount(ctx, view);
  } catch (err) {
    console.error("[router] 渲染失败", err);
    setHtml(
      view,
      `<div class="empty"><div class="empty-icon">🛠️</div><div class="empty-title">页面加载出错</div>
       <p class="empty-text">${String(err && err.message ? err.message : err)}</p>
       <button class="btn" type="button" onclick="location.hash='#/home'">返回首页</button></div>`
    );
  }
}

/** 底部 Tab 高亮 */
export function syncTabbar(activeTab) {
  const tabbar = $("#tabbar");
  if (!tabbar) return;
  for (const btn of tabbar.querySelectorAll(".tab")) {
    const isActive = btn.dataset.tab === activeTab;
    if (isActive) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  document.body.dataset.tabbar = activeTab ? "on" : "off";
}

/** 启动路由监听 */
export function startRouter() {
  window.addEventListener("hashchange", render);
  if (!location.hash) location.replace("#/home");
  return render();
}

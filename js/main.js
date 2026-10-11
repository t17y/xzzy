/**
 * 应用入口：引导启动、路由注册、底部 Tab、Service Worker、安装引导
 * @module main
 */

import { $, delegate, toast, show, setHtml } from "./core/dom.js";
import { escapeHtml } from "./core/util.js";
import { startRouter, registerRoutes, render, currentRoute } from "./core/router.js";
import { initState, state } from "./core/state.js";
import { emit, on, EV } from "./core/events.js";
import { openDB, migrationLog } from "./core/db.js";
import { detectEnv, browserAdvice } from "./core/env.js";
import { installHelp } from "./views/settings.js";
import { APP, TABS } from "./config.js";

import { homeView } from "./views/home.js";
import { importView } from "./views/import-view.js";
import { learnView } from "./views/learn.js";
import { sessionView } from "./views/session.js";
import { badgesView } from "./views/badges.js";
import { reviewView } from "./views/review.js";
import { reviewSessionView } from "./views/review-session.js";
import { wrongView } from "./views/wrong.js";
import { shelfView } from "./views/shelf.js";
import { readerView } from "./views/reader.js";
import { cardEditView } from "./views/card-edit.js";
import { statsView } from "./views/stats.js";
import { aboutView } from "./views/about.js";
import { profileView, guideView } from "./views/placeholders.js";
import { settingsView } from "./views/settings.js";

const ROUTES = [
  ["/home", homeView],
  ["/import", importView],
  ["/learn", learnView],
  ["/session", sessionView],
  ["/review", reviewView],
  ["/review-session", reviewSessionView],
  ["/badges", badgesView],
  ["/wrong", wrongView],
  ["/cards", shelfView],
  ["/reader", readerView],
  ["/card-edit", cardEditView],
  ["/stats", statsView],
  ["/about", aboutView],
  ["/profile", profileView],
  ["/guide", guideView],
  ["/settings", settingsView],
];

/** 为每个视图注入 reload 能力（重新渲染当前路由） */
function withReload(config) {
  return {
    ...config,
    async mount(ctx, root) {
      ctx.reload = () => render();
      if (typeof config.mount === "function") return config.mount(ctx, root);
      return undefined;
    },
  };
}

function buildTabbar() {
  const tabbar = $("#tabbar");
  setHtml(
    tabbar,
    TABS.map(
      (t) => `<a class="tab" href="${t.href}" data-tab="${t.key}">
        <span class="tab-icon" aria-hidden="true">${t.icon}</span>
        <span>${t.label}</span>
      </a>`
    ).join("")
  );
  show(tabbar, true);
}

/** 全局 data-go 跳转 */
function bindGlobal() {
  delegate(document.body, "click", "[data-go]", (ev, el) => {
    ev.preventDefault();
    location.hash = `#${el.dataset.go}`;
  });
  const back = $("#topbar-back");
  if (back) {
    back.addEventListener("click", () => {
      if (history.length > 1) history.back();
      else location.hash = "#/home";
    });
  }
}

/** 主题 / 系统偏好变化响应 */
function bindTheme() {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", () => {
    if ((state.settings?.theme || "auto") === "auto") {
      document.documentElement.dataset.theme = "auto";
    }
  });
}

/** 安装提示（beforeinstallprompt） */
function bindInstall() {
  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    window.__deferredInstallPrompt = ev;
  });
  window.addEventListener("appinstalled", () => {
    window.__deferredInstallPrompt = null;
    toast("已安装到主屏幕 🎉", { type: "ok" });
  });
}

/** Service Worker 注册 + 更新提示 */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      // 有新版本在等待 → 提示刷新
      const notifyUpdate = (worker) => {
        if (!worker) return;
        const bar = document.createElement("div");
        bar.className = "toast toast-warn";
        bar.style.pointerEvents = "auto";
        bar.innerHTML = "<span>🚀</span><span>发现新版本</span>";
        const btn = document.createElement("button");
        btn.className = "btn btn-sm";
        btn.textContent = "刷新更新";
        btn.style.marginLeft = "9px";
        btn.addEventListener("click", () => {
          worker.postMessage({ type: "SKIP_WAITING" });
          window.location.reload();
        });
        bar.appendChild(btn);
        $("#toast-layer")?.appendChild(bar);
      };
      if (reg.waiting) notifyUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) notifyUpdate(installing);
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        // 新 SW 接管后刷新一次，保证资源版本一致
        if (sessionStorage.getItem("xzzy.reloaded") !== "1") {
          sessionStorage.setItem("xzzy.reloaded", "1");
          window.location.reload();
        }
      });
      emit(EV.UPDATE_READY, reg);
    } catch (err) {
      console.warn("[sw] 注册失败：", err.message);
    }
  });
}

/** 打开数据库的兜底超时：避免「数据库不响应」时永远停在启动闪屏上 */
const DB_OPEN_TIMEOUT = 15000;

function openDBWithTimeout(ms = DB_OPEN_TIMEOUT) {
  return Promise.race([
    openDB(),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "打开本地数据库超时（15 秒）。可能是浏览器正在等待其他标签页释放数据库，或站点数据被浏览器冻结。"
            )
          ),
        ms
      )
    ),
  ]);
}

/** 更新启动闪屏上的提示文字（排查「卡在闪屏」时很有用） */
function showBootTip(text) {
  const el = document.querySelector(".boot-tip");
  if (el) el.textContent = text;
}

async function boot() {
  const bootEl = $("#boot");
  showBootTip("正在打开本地数据…");
  try {
    await openDBWithTimeout();
  } catch (err) {
    showDbError(err);
    bootEl?.remove();
    return;
  }
  showBootTip("正在准备界面…");

  // 首屏优先：先注册路由与外壳并渲染，数据在后台水合（首屏加载 < 3s，提示词验收）
  registerRoutes(ROUTES.map(([path, config]) => [path, withReload(config)]));
  buildTabbar();
  bindGlobal();
  bindTheme();
  bindInstall();
  try {
    await startRouter();
  } catch (err) {
    console.error("[boot] 首屏渲染失败", err);
    setHtml(
      $("#view"),
      `<div class="empty" style="margin-top:24px"><div class="empty-icon">⚠️</div>
        <div class="empty-title">界面加载失败</div>
        <p class="empty-text">${escapeHtml(String((err && err.message) || err))}</p>
        <button class="btn btn-block" type="button" onclick="location.reload()">重新加载</button>
      </div>`
    );
  }
  bootEl?.remove();

  // 数据水合：完成后重新渲染当前页面，数字随即变为真实值
  initState()
    .then(() => {
      const path = currentRoute()?.path;
      if (path && path !== "/session" && path !== "/review-session" && path !== "/reader") render();
    })
    .catch((err) => console.warn("[boot] 状态初始化失败", err));

  // 启动后的轻量能力提示（提示词 3.5：仅检测失败时提示一次）
  const env = detectEnv();
  const advice = browserAdvice(env);
  if (advice.level !== "ok" && !localStorage.getItem("xzzy.envWarned")) {
    localStorage.setItem("xzzy.envWarned", "1");
    toast(advice.title, { type: "warn", ms: 4200 });
  }

  // 首次使用且无内容 → 引导导入
  if (!state.hasContent && currentRoute()?.path === "/home") {
    setTimeout(() => {
      if (!state.hasContent && currentRoute()?.path === "/home") location.hash = "#/import";
    }, 400);
  }

  // 复习提醒调度（Phase 3）：开启后应用运行期间按设定时间提醒
  try {
    const { scheduleReminder } = await import("./core/notify.js");
    await scheduleReminder();
  } catch (err) {
    console.warn("[notify] 提醒调度失败", err);
  }
}

document.addEventListener("DOMContentLoaded", boot);

/**
 * 数据库打不开时的兜底页面：给出可执行的下一步，且默认不破坏数据
 * （只有在用户明确二次确认后才会删除本地数据库重建）
 */
function showDbError(err) {
  const detail = String((err && err.message) || err || "未知原因");
  const isBlocked = /占用|blocked/i.test(detail);
  const view = $("#view");
  setHtml(
    view,
    `<div class="empty" style="margin-top:24px">
      <div class="empty-icon">🚫</div>
      <div class="empty-title">无法打开本地数据库</div>
      <p class="empty-text">${escapeHtml(detail)}</p>
      <div class="note note-warn" style="text-align:left">
        <span>🛠️</span>
        <div>
          <strong>按顺序试这几步（不会删除已导入的内容）：</strong>
          <ol class="tight">
            <li>${isBlocked ? "关闭本应用的其他窗口/标签页，然后刷新本页" : "刷新本页重试一次"}</li>
            <li>确认浏览器没有禁用「Cookie 和站点数据 / IndexedDB」（Edge：设置 → Cookie 和网站权限）</li>
            <li>确认不是无痕/隐私模式打开（隐私模式下数据库不持久）</li>
            <li>用 Microsoft Edge 打开本应用再试</li>
          </ol>
          <div class="row-wrap mt">
            <button class="btn btn-sm" type="button" id="db-retry">刷新重试</button>
            <button class="btn btn-ghost btn-sm" type="button" id="db-help">看帮助</button>
            <button class="btn btn-red btn-sm" type="button" id="db-reset">重建本地数据库</button>
          </div>
          <p class="small muted mt">「重建本地数据库」会<strong>删除本机保存的全部学习数据</strong>，仅在以上步骤都无效时使用（建议先在有数据的设备上导出备份）。</p>
        </div>
      </div>
    </div>`
  );

  $("#db-retry")?.addEventListener("click", () => window.location.reload());
  $("#db-help")?.addEventListener("click", async () => {
    const { modal } = await import("./core/dom.js");
    await modal({
      title: "关于本地数据库",
      body: `<p class="small">应用的全部内容都保存在本机浏览器的 IndexedDB（数据库名 <code>xzzy_duolingo</code>），不上传任何服务器。</p>
        <p class="small">若提示「版本升级失败」，通常是升级过程中被其他标签页占用，或浏览器限制了站点数据。</p>
        <p class="small">技术上可在 Edge 的 DevTools → Application → IndexedDB 中查看 <code>xzzy_duolingo</code>。</p>`,
      actions: [{ label: "知道了", value: "ok", kind: "btn" }],
    });
  });
  $("#db-reset")?.addEventListener("click", async () => {
    const { confirmDialog, toast } = await import("./core/dom.js");
    const ok = await confirmDialog(
      "重建本地数据库？",
      "将删除本机保存的全部知识点、题目、进度、复习档案、错题与卡片，且无法恢复。确定继续吗？",
      { okLabel: "确认删除并重建", danger: true }
    );
    if (!ok) return;
    try {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase("xzzy_duolingo");
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      });
      toast("本地数据库已重建，正在重新加载…", { type: "ok" });
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast(`重建失败：${e.message}`, { type: "err" });
    }
  });
}

// 调试用：全局暴露少量只读信息
window.__XZZY__ = { APP, state, migrationLog, installHelp };

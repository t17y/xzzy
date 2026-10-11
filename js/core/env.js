/**
 * 环境 / PWA 能力检测（提示词 3.5：轻量检测 + 降级提示，结果可见于设置页）
 * @module core/env
 */

/** 一次性检测浏览器能力 */
export function detectEnv() {
  const ua = navigator.userAgent || "";
  const isEdge = /Edg\//.test(ua);
  const isHuawei = /Huawei|HarmonyOS|HMSCore|HUAWEI/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const isLanIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  return {
    ua,
    isEdge,
    isHuawei,
    isIOS,
    standalone,
    secureContext: window.isSecureContext === true,
    isLocalhost,
    isLanIp,
    /** 只有 https / localhost 才允许安装 PWA（Chromium 的安全上下文限制） */
    installableOrigin: window.isSecureContext === true,
    serviceWorker: "serviceWorker" in navigator,
    indexedDB: typeof indexedDB !== "undefined",
    localStorage: (() => {
      try {
        localStorage.setItem("xzzy.probe", "1");
        localStorage.removeItem("xzzy.probe");
        return true;
      } catch {
        return false;
      }
    })(),
    notification: "Notification" in window,
    notificationPermission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
    persistentStorage: !!(navigator.storage && navigator.storage.persist),
    beforeInstallPrompt: !!window.__deferredInstallPrompt,
    fileApi: typeof File !== "undefined" && typeof FileReader !== "undefined",
    blobDownload: typeof URL !== "undefined" && typeof URL.createObjectURL === "function",
  };
}

/** 是否推荐主目标浏览器（Edge）与是否可安装（Chromium 只在 https / localhost 允许安装 PWA） */
export function browserAdvice(env) {
  if (!env.installableOrigin && env.isLanIp) {
    return {
      level: "warn",
      title: "局域网 http 地址无法安装为应用",
      text: "浏览器只允许在 https 或 localhost 下「安装应用」。当前用的是局域网 http 地址，所以菜单里只会有「创建快捷方式」（带地址栏、离线不保证）。改用 https 地址（静态托管或 cloudflared 隧道）即可正常安装；在线使用与数据保存不受影响。",
    };
  }
  if (!env.installableOrigin) {
    return {
      level: "warn",
      title: "当前不是安全上下文，无法安装为应用",
      text: "请通过 https 地址或 localhost 打开本应用后再安装。在线使用与数据保存不受影响。",
    };
  }
  if (env.isEdge && env.serviceWorker) {
    return { level: "ok", title: "Microsoft Edge（推荐，完整 PWA）", text: "离线缓存、安装到主屏幕、PWA 通知均可用。" };
  }
  if (env.serviceWorker) {
    return {
      level: "warn",
      title: "当前浏览器离线能力受限，建议使用 Edge",
      text: "可以正常在线学习与保存数据；如需「安装为应用 / 离线打开 / 通知提醒」，请用 Microsoft Edge 打开本应用。",
    };
  }
  return {
    level: "error",
    title: "当前浏览器不支持 Service Worker",
    text: "离线能力不可用。在线使用与数据存储（IndexedDB）不受影响；建议改用 Microsoft Edge 获得完整 PWA 体验。",
  };
}

/** 环境检测结果（设置页展示用） */
export function envRows(env) {
  const yn = (v) => (v ? "✅ 支持" : "❌ 不支持");
  return [
    ["浏览器", env.isEdge ? "Microsoft Edge（主目标）" : env.isHuawei ? "华为浏览器 / 鸿蒙（备用）" : env.isIOS ? "iOS 浏览器" : "其他浏览器"],
    ["访问地址", env.isLocalhost ? "localhost（可安装）" : env.secureContext ? "HTTPS（可安装）" : `http://（${env.isLanIp ? "局域网 IP" : "非安全来源"}，不可安装）`],
    ["运行模式", env.standalone ? "已安装（独立窗口）" : "浏览器标签页"],
    ["Service Worker（离线）", yn(env.serviceWorker)],
    ["IndexedDB（本地数据）", yn(env.indexedDB)],
    ["localStorage（设置）", yn(env.localStorage)],
    ["安全上下文（HTTPS / localhost）", yn(env.secureContext)],
    ["可否「安装应用」", env.installableOrigin ? "✅ 可安装" : "❌ 需改用 https 地址（或 localhost）"],
    ["通知 API", env.notification ? `已授权状态：${permissionLabel(env.notificationPermission)}` : "❌ 不支持"],
    ["持久化存储请求", env.persistentStorage ? "✅ 支持" : "❌ 不支持"],
    ["安装提示（beforeinstallprompt）", env.beforeInstallPrompt ? "✅ 已就绪" : "未触发（可直接用菜单「安装应用」）"],
    ["文件导入 / 下载导出", env.fileApi && env.blobDownload ? "✅ 可用" : "⚠️ 部分受限"],
  ];
}

function permissionLabel(p) {
  return { granted: "已允许", denied: "已拒绝", default: "未询问", unsupported: "不支持" }[p] || p;
}

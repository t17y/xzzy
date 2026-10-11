/**
 * 极简事件总线：跨模块通信（导入完成 → 首页刷新等）
 * @module core/events
 */

const listeners = new Map();

/**
 * 订阅事件
 * @returns {() => void} 取消订阅
 */
export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => listeners.get(type)?.delete(handler);
}

export function once(type, handler) {
  const off = on(type, (payload) => {
    off();
    handler(payload);
  });
  return off;
}

export function emit(type, payload) {
  for (const h of listeners.get(type) || []) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[events] ${type} 处理出错`, err);
    }
  }
}

/** 事件名常量表 */
export const EV = {
  DB_READY: "db:ready",
  DATA_CHANGED: "data:changed",
  IMPORT_DONE: "import:done",
  SETTINGS_CHANGED: "settings:changed",
  THEME_CHANGED: "theme:changed",
  NAV: "nav:changed",
  TOAST: "ui:toast",
  UPDATE_READY: "pwa:update-ready",
};

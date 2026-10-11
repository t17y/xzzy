/**
 * 应用级状态（内存）+ 轻量订阅
 * 与数据层解耦：视图只读取快照，数据变更由 data.js 广播事件后刷新
 * @module core/state
 */

import { emit, on, EV } from "./events.js";
import { dataSummary, readSettings, writeSettings } from "./db.js";
import { migrationLog } from "./db.js";

export const state = {
  ready: false,
  hasContent: false,
  summary: { items: 0, questions: 0, cards: 0, wrongs: 0, imports: 0, sessions: 0, stars: 0, clearedNodes: 0, subjects: [] },
  settings: null,
  migration: [],
  /** 游戏化快照（Phase 2，由 refreshGame() 更新） */
  game: null,
};

/** 初始化：加载设置 + 数据总览 */
export async function initState() {
  state.settings = readSettings();
  state.migration = migrationLog();
  state.summary = await dataSummary();
  state.hasContent = state.summary.hasContent;
  state.ready = true;
  applyTheme(state.settings);
  try {
    const { loadGame } = await import("./game.js");
    state.game = await loadGame();
  } catch (err) {
    console.warn("[state] 游戏化状态加载失败", err);
  }
  emit(EV.DB_READY, state);
  return state;
}

/** 刷新数据总览 */
export async function refreshSummary() {
  state.summary = await dataSummary();
  state.hasContent = state.summary.hasContent;
  emit(EV.DATA_CHANGED, { summary: state.summary });
  return state.summary;
}

/** 刷新游戏化快照 */
export async function refreshGame() {
  const { loadGame } = await import("./game.js");
  state.game = await loadGame();
  return state.game;
}

/** 更新设置并应用主题 */
export function updateSettings(patch) {
  state.settings = writeSettings(patch);
  applyTheme(state.settings);
  emit(EV.SETTINGS_CHANGED, state.settings);
  return state.settings;
}

/** 应用主题 / 字号 / 动效到 <html> */
export function applyTheme(settings = state.settings || readSettings()) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme || "auto";
  root.dataset.fontsize = settings.fontSize || "medium";
  root.dataset.anim = settings.anim === false ? "off" : "on";
}

on(EV.IMPORT_DONE, () => {
  refreshSummary();
});

on(EV.DATA_CHANGED, (payload) => {
  // 关卡结算 / 徽章变化时同步游戏化快照（避免循环：仅在这些原因下刷新）
  if (payload && ["settle", "badges", "session-finished"].includes(payload.reason)) {
    refreshGame().catch(() => {});
  }
});

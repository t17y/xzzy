/**
 * IndexedDB 数据层封装
 * - 统一 Promise API（get/put/delete/query/count）
 * - 版本号 + 迁移机制：结构升级不丢数据（提示词 3.3 / 验收 8）
 * - 表结构：
 *   v1: learn_items / questions / progress / review_records / wrong_answers / cards / import_meta / settings
 *   v3: game_state（游戏化状态）/ daily_stats（每日统计）/ quiz_sessions（关卡记录）
 * @module core/db
 */

import { todayKey } from "./util.js";

export const DB_NAME = "xzzy_duolingo";
export const DB_VERSION = 4;

export const STORES = {
  learn_items: "learn_items",
  questions: "questions",
  progress: "progress",
  review_records: "review_records",
  wrong_answers: "wrong_answers",
  cards: "cards",
  import_meta: "import_meta",
  settings: "settings",
  game_state: "game_state",
  daily_stats: "daily_stats",
  quiz_sessions: "quiz_sessions",
};

/** 各表结构定义：keyPath + 索引（迁移时按版本增量创建） */
function schemaFor(_oldVersion, _newVersion, tx) {
  const db = tx.db;
  // ---- v1：核心七表 ----
  if (!db.objectStoreNames.contains(STORES.learn_items)) {
    const s = db.createObjectStore(STORES.learn_items, { keyPath: "id" });
    s.createIndex("subject", "subject", { unique: false });
    s.createIndex("chapter", "chapter", { unique: false });
    s.createIndex("subject_chapter", ["subject", "chapter"], { unique: false });
    s.createIndex("tags", "tags", { unique: false, multiEntry: true });
  }
  if (!db.objectStoreNames.contains(STORES.questions)) {
    const s = db.createObjectStore(STORES.questions, { keyPath: "id" });
    s.createIndex("item_id", "item_id", { unique: false });
    s.createIndex("subject", "subject", { unique: false });
    s.createIndex("type", "type", { unique: false });
    s.createIndex("chapter", "chapter", { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.progress)) {
    const s = db.createObjectStore(STORES.progress, { keyPath: "id" });
    s.createIndex("subject", "subject", { unique: false });
    s.createIndex("node_type", "node_type", { unique: false });
    s.createIndex("node_key", "node_key", { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.review_records)) {
    const s = db.createObjectStore(STORES.review_records, { keyPath: "id" });
    s.createIndex("target_type", "target_type", { unique: false });
    s.createIndex("next_review_date", "next_review_date", { unique: false });
    s.createIndex("status", "status", { unique: false });
    s.createIndex("item_id", "item_id", { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.wrong_answers)) {
    const s = db.createObjectStore(STORES.wrong_answers, { keyPath: "id" });
    s.createIndex("item_id", "item_id", { unique: false });
    s.createIndex("subject", "subject", { unique: false });
    s.createIndex("question_id", "question_id", { unique: false });
    s.createIndex("created_at", "created_at", { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.cards)) {
    const s = db.createObjectStore(STORES.cards, { keyPath: "id" });
    s.createIndex("subject", "subject", { unique: false });
    s.createIndex("chapter", "chapter", { unique: false });
    s.createIndex("source", "source", { unique: false });
    s.createIndex("item_id", "item_id", { unique: false });
    s.createIndex("tags", "tags", { unique: false, multiEntry: true });
  }
  if (!db.objectStoreNames.contains(STORES.import_meta)) {
    db.createObjectStore(STORES.import_meta, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(STORES.settings)) {
    db.createObjectStore(STORES.settings, { keyPath: "key" });
  }

  // ---- v3：游戏化与关卡记录（Phase 2）----
  if (!db.objectStoreNames.contains(STORES.game_state)) {
    // 简易 KV：keyPath=key（xp / streak / hearts / badges / totals / _meta）
    db.createObjectStore(STORES.game_state, { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains(STORES.daily_stats)) {
    const s = db.createObjectStore(STORES.daily_stats, { keyPath: "date_key" });
    s.createIndex("date_key", "date_key", { unique: true });
  }
  if (!db.objectStoreNames.contains(STORES.quiz_sessions)) {
    const s = db.createObjectStore(STORES.quiz_sessions, { keyPath: "id" });
    s.createIndex("node_key", "node_key", { unique: false });
    s.createIndex("subject", "subject", { unique: false });
    s.createIndex("started_at", "started_at", { unique: false });
    s.createIndex("node_type", "node_type", { unique: false });
  }

  // ---- v4：错题本与卡片的增量结构（Phase 4）----
  // 注意：升级事务进行中**不能**调用 db.transaction()（会抛 InvalidStateError 并中止升级），
  // 必须复用传入的升级事务 tx 来获取已存在的表并补建索引。
  if (db.objectStoreNames.contains(STORES.wrong_answers)) {
    const s = tx.objectStore(STORES.wrong_answers);
    if (!s.indexNames.contains("chapter")) s.createIndex("chapter", "chapter", { unique: false });
    if (!s.indexNames.contains("subject_chapter")) s.createIndex("subject_chapter", ["subject", "chapter"], { unique: false });
  }
  if (db.objectStoreNames.contains(STORES.cards)) {
    const s = tx.objectStore(STORES.cards);
    if (!s.indexNames.contains("source_item")) s.createIndex("source_item", ["source", "item_id"], { unique: false });
  }
}

let _dbPromise = null;
let _migrationLog = [];
let _lastOpenError = null;

/** 打开数据库（带迁移），返回 IDBDatabase */
export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境不支持 IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      // 兼容两种取法：ev.target.transaction（标准）与 req.transaction
      const tx = ev?.target?.transaction || req.transaction;
      _migrationLog.push(`升级 ${ev.oldVersion} → ${ev.newVersion}`);
      try {
        if (!tx) throw new Error("升级事务不可用：无法执行表结构迁移");
        schemaFor(ev.oldVersion, ev.newVersion, tx);
      } catch (err) {
        // 迁移失败必须让 onerror 带上真实原因，否则用户只会看到一句
        // "Version change transaction was aborted in upgradeneeded event handler."
        _lastOpenError = err;
        console.error("[db] 表结构迁移失败：", err);
        try {
          tx.abort();
        } catch {
          /* 忽略：即使无法主动中止，onerror 也会带上 _lastOpenError */
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // 其他标签页升级时释放连接
      resolve(db);
    };
    req.onerror = () => {
      const err = _lastOpenError || req.error || new Error("IndexedDB 打开失败");
      const wrapped = new Error(
        _lastOpenError
          ? `本地数据库升级失败：${err.message}`
          : `本地数据库打开失败：${err.message || err.name || "未知原因"}`
      );
      wrapped.cause = err;
      reject(wrapped);
    };
    req.onblocked = () =>
      reject(new Error("本地数据库被其他标签页占用（正在升级）。请关闭本应用的其他窗口/标签页后刷新重试。"));
  });
  return _dbPromise;
}

export function migrationLog() {
  return [..._migrationLog];
}

/** 内部：执行一个事务 */
async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(storeName);
    try {
      result = fn(store, tx);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      if (result && typeof result.then === "function") {
        result.then(resolve, reject);
      } else {
        resolve(result);
      }
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("事务被中止"));
  });
}

/** 内部：把 IDBRequest 包成 Promise */
function rq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------ 基础 CRUD ------------------------------ */

export async function put(storeName, value) {
  return withStore(storeName, "readwrite", (store) => rq(store.put(value)));
}

export async function bulkPut(storeName, values) {
  if (!values || !values.length) return 0;
  return withStore(storeName, "readwrite", async (store) => {
    for (const v of values) store.put(v);
    return values.length;
  });
}

export async function get(storeName, key) {
  return withStore(storeName, "readonly", (store) => rq(store.get(key)));
}

export async function getAll(storeName) {
  return withStore(storeName, "readonly", (store) => rq(store.getAll()));
}

export async function count(storeName) {
  return withStore(storeName, "readonly", (store) => rq(store.count()));
}

export async function del(storeName, key) {
  return withStore(storeName, "readwrite", (store) => rq(store.delete(key)));
}

export async function clearStore(storeName) {
  return withStore(storeName, "readwrite", (store) => rq(store.clear()));
}

/**
 * 按索引查询
 * @param {string} storeName
 * @param {string} indexName
 * @param {IDBValidKey|IDBKeyRange} key
 */
export async function queryByIndex(storeName, indexName, key) {
  return withStore(storeName, "readonly", (store) => rq(store.index(indexName).getAll(key)));
}

/** 按索引前缀（数组复合索引的 lowerBound 用法）查询 */
export async function queryByIndexRange(storeName, indexName, range) {
  return withStore(storeName, "readonly", (store) => rq(store.index(indexName).getAll(range)));
}

/* ------------------------------ 领域查询 ------------------------------ */

/** 全部科目（去重，保持导入顺序） */
export async function listSubjects() {
  const items = await getAll(STORES.learn_items);
  const order = [];
  const seen = new Set();
  for (const it of items) {
    if (!seen.has(it.subject)) {
      seen.add(it.subject);
      order.push(it.subject);
    }
  }
  return order;
}

/** 某科目的章节列表 */
export async function listChapters(subject) {
  const items = await queryByIndex(STORES.learn_items, "subject", subject);
  const chapters = [];
  const seen = new Set();
  for (const it of items) {
    if (!seen.has(it.chapter)) {
      seen.add(it.chapter);
      chapters.push(it.chapter);
    }
  }
  return chapters;
}

/** 某科目（或全部）的知识点 */
export async function listItems(subject) {
  const items = subject
    ? await queryByIndex(STORES.learn_items, "subject", subject)
    : await getAll(STORES.learn_items);
  return items.sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.title).localeCompare(String(b.title), "zh")
  );
}

/** 某知识点的题目 */
export async function listQuestions(itemId) {
  const qs = await queryByIndex(STORES.questions, "item_id", itemId);
  return qs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 全部题目 */
export async function allQuestions() {
  return getAll(STORES.questions);
}

/* ------------------------------ 游戏化数据（Phase 2） ------------------------------ */

/** 读取游戏化状态字段（game_state 表：KV） */
export async function readGameState(key, fallback = null) {
  const row = await get(STORES.game_state, key);
  return row ? row.value : fallback;
}

/** 写入游戏化状态字段 */
export async function writeGameState(key, value) {
  await put(STORES.game_state, { key, value, updated_at: Date.now() });
  return value;
}

/** 读取当日统计（不存在时返回空骨架，不落库） */
export async function readDailyStats(dateKey = todayKey()) {
  const row = await get(STORES.daily_stats, dateKey);
  return (
    row || {
      date_key: dateKey,
      xp: 0,
      lessons: 0,
      correct: 0,
      total: 0,
      reviews: 0,
      cards: 0,
      goal_bonus: false,
    }
  );
}

/** 累加当日统计（原子读改写；单线程环境足够） */
export async function bumpDailyStats(patch = {}, dateKey = todayKey()) {
  const row = await readDailyStats(dateKey);
  const next = { ...row };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "number") next[k] = (Number(next[k]) || 0) + v;
    else next[k] = v;
  }
  await put(STORES.daily_stats, next);
  return next;
}

/** 最近 N 天统计（热力图用，返回按日期升序数组） */
export async function listDailyStats(days = 30) {
  const rows = await getAll(STORES.daily_stats);
  return rows.sort((a, b) => String(a.date_key).localeCompare(String(b.date_key))).slice(-days);
}

/* ------------------------------ 关卡进度（Phase 2） ------------------------------ */

const NODE_PREFIX = "node:";

/** 读取某关卡的进度（星级、尝试次数） */
export async function readNodeProgress(nodeKey) {
  return get(STORES.progress, NODE_PREFIX + nodeKey);
}

/** 全部关卡进度（按 node_key 归集） */
export async function listNodeProgress() {
  const rows = await getAll(STORES.progress);
  const map = new Map();
  for (const r of rows) map.set(r.node_key || String(r.id).replace(NODE_PREFIX, ""), r);
  return map;
}

/**
 * 记录一次关卡结算（星级只增不减：保留最高星级）
 * @param {{nodeKey:string, nodeType:string, subject:string, chapter?:string, stars:number, accuracy:number, correct:number, total:number, xp:number, sessionId:string}} result
 */
export async function saveNodeProgress(result) {
  const key = NODE_PREFIX + result.nodeKey;
  const prev = (await get(STORES.progress, key)) || {
    id: key,
    node_key: result.nodeKey,
    node_type: result.nodeType,
    subject: result.subject,
    chapter: result.chapter || "",
    stars: 0,
    attempts: 0,
    best_accuracy: 0,
    total_xp: 0,
    cleared: false,
    first_cleared_at: 0,
  };
  const next = {
    ...prev,
    stars: Math.max(prev.stars || 0, result.stars || 0),
    attempts: (prev.attempts || 0) + 1,
    best_accuracy: Math.max(prev.best_accuracy || 0, result.accuracy || 0),
    total_xp: (prev.total_xp || 0) + (result.xp || 0),
    last_result: { stars: result.stars, accuracy: result.accuracy, correct: result.correct, total: result.total, at: Date.now() },
    last_played_at: Date.now(),
    cleared: (prev.cleared || false) || (result.stars || 0) >= 1,
    first_cleared_at: prev.first_cleared_at || ((result.stars || 0) >= 1 ? Date.now() : 0),
  };
  await put(STORES.progress, next);
  return next;
}

/** 保存一次测验会话记录（结算页/统计用） */
export async function saveQuizSession(session) {
  const row = {
    id: session.id || `qs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    started_at: session.startedAt || Date.now(),
    ended_at: Date.now(),
    ...session,
  };
  await put(STORES.quiz_sessions, row);
  return row;
}

/** 最近 N 次测验会话 */
export async function listQuizSessions(limit = 20) {
  const rows = await getAll(STORES.quiz_sessions);
  return rows.sort((a, b) => (b.started_at || 0) - (a.started_at || 0)).slice(0, limit);
}

/** 测验会话总数 */
export async function countQuizSessions() {
  return count(STORES.quiz_sessions);
}

/** 数据总览（首页/统计用） */
export async function dataSummary() {
  const [items, questions, cards, wrongs, imports, sessions] = await Promise.all([
    count(STORES.learn_items),
    count(STORES.questions),
    count(STORES.cards),
    count(STORES.wrong_answers),
    count(STORES.import_meta),
    count(STORES.quiz_sessions),
  ]);
  const [subjects, progressRows] = await Promise.all([listSubjects(), getAll(STORES.progress)]);
  const stars = progressRows.reduce((n, r) => n + (r.stars || 0), 0);
  return {
    items,
    questions,
    cards,
    wrongs,
    imports,
    sessions,
    subjects,
    stars,
    clearedNodes: progressRows.filter((r) => r.cleared).length,
    unlockedNodes: progressRows.filter((r) => (r.stars || 0) > 0).length,
    hasContent: items > 0,
  };
}

/** 删除某次导入产生的全部内容（导入记录回滚） */
export async function removeImport(importId) {
  const items = await getAll(STORES.learn_items);
  const targets = items.filter((it) => it.import_id === importId);
  const ids = new Set(targets.map((t) => t.id));
  const questions = await getAll(STORES.questions);
  const qTargets = questions.filter((q) => ids.has(q.item_id) || q.import_id === importId);
  const cards = await getAll(STORES.cards);
  const cTargets = cards.filter((c) => c.import_id === importId);
  for (const t of targets) await del(STORES.learn_items, t.id);
  for (const q of qTargets) await del(STORES.questions, q.id);
  for (const c of cTargets) await del(STORES.cards, c.id);
  await del(STORES.import_meta, importId);
  return { items: targets.length, questions: qTargets.length, cards: cTargets.length };
}

/** 清空全部业务数据（保留设置） */
export async function resetContent() {
  await Promise.all([
    clearStore(STORES.learn_items),
    clearStore(STORES.questions),
    clearStore(STORES.progress),
    clearStore(STORES.review_records),
    clearStore(STORES.wrong_answers),
    clearStore(STORES.cards),
    clearStore(STORES.import_meta),
    clearStore(STORES.quiz_sessions),
    clearStore(STORES.daily_stats),
    clearStore(STORES.game_state),
  ]);
  return true;
}

/** 清空一切（含设置） */
export async function resetAll() {
  await resetContent();
  await clearStore(STORES.settings);
  hydrateSettings();
  return true;
}

/* ------------------------------ 备份 / 恢复 ------------------------------ */

/** 导出全量备份对象（提示词 3.4） */
export async function exportAll() {
  const data = {};
  for (const name of Object.values(STORES)) {
    if (name === STORES.settings) continue;
    data[name] = await getAll(name);
  }
  return {
    app: "知彩",
    schema: DB_VERSION,
    exported_at: new Date().toISOString(),
    settings: readSettings(),
    data,
  };
}

/**
 * 导入备份（合并模式：同 id 覆盖；不删除现有数据）
 * @param {object} backup
 */
export async function importBackup(backup) {
  if (!backup || typeof backup !== "object") throw new Error("备份文件格式不正确");
  const data = backup.data || backup;
  const report = {};
  for (const name of Object.values(STORES)) {
    if (name === STORES.settings) continue;
    const rows = Array.isArray(data[name]) ? data[name] : [];
    if (rows.length) await bulkPut(name, rows);
    report[name] = rows.length;
  }
  if (backup.settings && typeof backup.settings === "object") {
    writeSettings({ ...readSettings(), ...backup.settings });
  }
  return report;
}

/* ------------------------------ localStorage 设置项 ------------------------------ */

const SETTINGS_KEY = "xzzy.settings.v1";

/** 默认设置（提示词 3.3 / 六.15 设置页字段） */
export const DEFAULT_SETTINGS = {
  dailyGoal: 50, // 每日目标 XP
  reviewIntervals: [1, 2, 4, 7, 15, 30, 60], // 艾宾浩斯间隔阶梯（天）
  masteredStreak: 3, // 连续正确多少次标记已掌握
  dailyNewLimit: 20, // 每日新内容进入复习队列的上限
  reviewBatch: 30, // 单次复习最多处理多少项
  heartsMax: 5,
  heartRecoverMin: 30,
  unlockStars: 2, // 解锁下一节点所需星数
  theme: "auto", // auto | light | dark
  fontSize: "medium", // small | medium | large
  sound: true,
  anim: true, // 动效开关（省电模式）
  notifyEnabled: false,
  notifyTime: "20:00",
  streakProtect: true,
  autoPlaySec: 10, // 卡片自动播放间隔
  readMode: "page", // page | scroll
  lastReadCardId: null,
  readyToReview: true,
};

let _settings = null;

export function readSettings() {
  if (_settings) return { ..._settings };
  let raw = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    raw = null;
  }
  _settings = { ...DEFAULT_SETTINGS };
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") Object.assign(_settings, parsed);
    } catch {
      /* 忽略损坏的设置，回落默认值 */
    }
  }
  return { ..._settings };
}

export function writeSettings(patch) {
  _settings = { ...readSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
  } catch {
    /* 隐私模式下写入失败：内存内仍然生效 */
  }
  return { ..._settings };
}

export function resetSettings() {
  return hydrateSettings();
}

/** 把设置恢复到默认值（内存 + localStorage 同步重置） */
export function hydrateSettings() {
  _settings = { ...DEFAULT_SETTINGS };
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
  return { ..._settings };
}

/** 简易 KV（localStorage），用于续读位置、上次 Tab 等轻量状态 */
export const kv = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`xzzy.kv.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`xzzy.kv.${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
    return value;
  },
  del(key) {
    try {
      localStorage.removeItem(`xzzy.kv.${key}`);
    } catch {
      /* ignore */
    }
  },
};

/** 写入一条导入记录 */
export async function saveImportMeta(meta) {
  const row = {
    id: meta.id || `imp_${Date.now().toString(36)}`,
    created_at: Date.now(),
    date_key: todayKey(),
    ...meta,
  };
  await put(STORES.import_meta, row);
  return row;
}

/** 导入记录（倒序） */
export async function listImports() {
  const rows = await getAll(STORES.import_meta);
  return rows.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/** 数据库占用估算（统计页/设置页展示） */
export async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    } catch {
      return null;
    }
  }
  return null;
}

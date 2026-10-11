/**
 * 游戏化引擎（提示词 5.2 / 5.1 星级与进度）
 * 覆盖：XP 经验值、连续打卡 Streak、红心系统、徽章成就、段位体系、星级与结算奖励
 *
 * 设计原则：
 * - 纯计算函数（XP 规则、星级、段位、徽章条件）独立导出，便于单元测试；
 * - 状态读写集中在 state 层，所有写操作落 IndexedDB（game_state / daily_stats / progress）；
 * - 不使用任何随机数生成"虚假"数据：所有数字都来自真实学习动作。
 * @module core/game
 */

import {
  STORES,
  readDailyStats,
  bumpDailyStats,
  readGameState,
  writeGameState,
  saveNodeProgress,
  saveQuizSession,
  listDailyStats,
  listNodeProgress,
  readSettings,
} from "./db.js";
import { emit, EV } from "./events.js";
import { todayKey, daysBetween, dateKey, addDays } from "./util.js";

/* ------------------------------ 常量与规则 ------------------------------ */

/** XP 规则（提示词 5.2：学习新卡 +10、答对 +5、连击加成、关卡结算奖励、复习 +3） */
export const XP_RULES = {
  newCard: 10,
  correct: 5,
  wrong: 0,
  comboBonus: 2, // 每连击 3 题额外加成
  comboStep: 3,
  nodeClear: 15, // 关卡通关奖励
  nodePerfect: 10, // 满星额外奖励
  review: 3, // 每道复习题
  matchPair: 3, // 线关卡每配对正确
};

/** 红心规则（提示词 5.2） */
export const HEART_RULES = {
  max: 5,
  recoverMinutes: 30, // 等待 30 分钟恢复 1 心
  reviewTaskSize: 5, // 完成「复习 5 题」立即恢复 1 心
};

/** 段位体系（按累计 XP） */
export const RANKS = [
  { key: "bronze", name: "青铜", icon: "🥉", min: 0 },
  { key: "silver", name: "白银", icon: "🥈", min: 200 },
  { key: "gold", name: "黄金", icon: "🥇", min: 600 },
  { key: "platinum", name: "铂金", icon: "💎", min: 1500 },
  { key: "diamond", name: "钻石", icon: "💠", min: 3000 },
  { key: "master", name: "大师", icon: "👑", min: 6000 },
];

/** 徽章墙（≥12 枚，提示词 5.2） */
export const BADGES = [
  { key: "first_clear", name: "首战告捷", icon: "🎯", desc: "通过第一个关卡" },
  { key: "first_perfect", name: "完美主义", icon: "⭐", desc: "首次拿到 3 星" },
  { key: "streak_3", name: "入门坚持", icon: "🔥", desc: "连续打卡 3 天" },
  { key: "streak_7", name: "一周不辍", icon: "🔥", desc: "连续打卡 7 天" },
  { key: "streak_30", name: "月度铁人", icon: "🏅", desc: "连续打卡 30 天" },
  { key: "streak_100", name: "百日之约", icon: "💯", desc: "连续打卡 100 天" },
  { key: "xp_500", name: "小有所成", icon: "📈", desc: "累计 500 XP" },
  { key: "xp_2000", name: "勤学不辍", icon: "🚀", desc: "累计 2000 XP" },
  { key: "combo_10", name: "连击达人", icon: "⚡", desc: "单次连击达到 10 题" },
  { key: "nodes_10", name: "稳扎稳打", icon: "🧱", desc: "通过 10 个关卡" },
  { key: "nodes_50", name: "地图征服者", icon: "🗺️", desc: "通过 50 个关卡" },
  { key: "stars_30", name: "摘星人", icon: "✨", desc: "累计获得 30 颗星" },
  { key: "accuracy_90", name: "精准射手", icon: "🎖️", desc: "单次关卡正确率 ≥ 90%（题目 ≥ 5）" },
  { key: "review_50", name: "复习守恒", icon: "🔁", desc: "累计复习 50 题" },
];

/* ------------------------------ 纯函数：星级 / 段位 / 徽章 ------------------------------ */

/**
 * 星级判定（提示词 5.1：按正确率与剩余红心评 1–3 星）
 * 3 星：全部答对且没有扣心；2 星：正确率 ≥ 80%；1 星：正确率 ≥ 60%；否则 0 星
 */
export function calcStars({ correct = 0, total = 0, mistakes = 0, minAccuracy = 0.6 } = {}) {
  if (!total) return 0;
  const acc = correct / total;
  if (correct === total && mistakes === 0) return 3;
  if (acc >= 0.8) return 2;
  if (acc >= minAccuracy) return 1;
  return 0;
}

/** 关卡是否通过（星级 ≥ 1） */
export function isCleared(stars) {
  return (stars || 0) >= 1;
}

/** 根据累计 XP 求段位 */
export function rankOf(xp) {
  const total = Math.max(0, Number(xp) || 0);
  let current = RANKS[0];
  for (const r of RANKS) if (total >= r.min) current = r;
  const idx = RANKS.indexOf(current);
  const next = RANKS[idx + 1] || null;
  const spanStart = current.min;
  const spanEnd = next ? next.min : current.min + 1;
  const progress = next ? Math.min(100, Math.round(((total - spanStart) / (spanEnd - spanStart)) * 100)) : 100;
  return { ...current, xp: total, next, toNext: next ? Math.max(0, next.min - total) : 0, progress };
}

/**
 * 结算 XP（提示词 5.2）
 * @param {{correct:number,total:number,wrong:number,newCards?:number,maxCombo?:number,reviewed?:number,matchedPairs?:number,isNew?:boolean,stars?:number}} detail
 */
export function settleXp(detail = {}) {
  const correct = Number(detail.correct) || 0;
  const newCards = Number(detail.newCards) || 0;
  const reviewed = Number(detail.reviewed) || 0;
  const matchedPairs = Number(detail.matchedPairs) || 0;
  const maxCombo = Number(detail.maxCombo) || 0;
  const stars = Number(detail.stars) || 0;
  const passed = stars >= 1;

  const items = [];
  if (newCards) items.push({ key: "newCard", label: `学习新卡片 ×${newCards}`, xp: newCards * XP_RULES.newCard });
  if (correct) items.push({ key: "correct", label: `答对 ×${correct}`, xp: correct * XP_RULES.correct });
  if (matchedPairs) items.push({ key: "match", label: `配对正确 ×${matchedPairs}`, xp: matchedPairs * XP_RULES.matchPair });
  if (reviewed) items.push({ key: "review", label: `复习 ×${reviewed}`, xp: reviewed * XP_RULES.review });
  const comboBonusCount = Math.floor(maxCombo / XP_RULES.comboStep);
  if (comboBonusCount > 0) {
    items.push({ key: "combo", label: `连击加成（最高 ${maxCombo} 连）`, xp: comboBonusCount * XP_RULES.comboBonus });
  }
  if (passed) items.push({ key: "clear", label: "关卡通关", xp: XP_RULES.nodeClear });
  if (stars >= 3) items.push({ key: "perfect", label: "满星奖励", xp: XP_RULES.nodePerfect });

  const total = items.reduce((n, i) => n + i.xp, 0);
  return { items, total };
}

/**
 * 每日目标达成情况
 * @param {number} xpToday
 * @param {number} dailyGoal
 */
export function goalStatus(xpToday, dailyGoal) {
  const goal = Math.max(1, Number(dailyGoal) || 50);
  const xp = Math.max(0, Number(xpToday) || 0);
  return { xp, goal, reached: xp >= goal, percent: Math.min(100, Math.round((xp / goal) * 100)), remaining: Math.max(0, goal - xp) };
}

/**
 * 计算连续打卡（提示词 5.2）
 * @param {{streak?:number,lastDate?:string,best?:number}} prev
 * @param {string} today YYYY-MM-DD
 */
export function nextStreak(prev, today = todayKey()) {
  const streak = Number(prev.streak) || 0;
  const best = Number(prev.best) || 0;
  const lastDate = prev.lastDate || "";
  if (lastDate === today) return { streak: Math.max(1, streak), best: Math.max(best, Math.max(1, streak)), lastDate: today, changed: false };
  const gap = lastDate ? daysBetween(lastDate, today) : null;
  const next = gap === 1 ? streak + 1 : 1;
  return { streak: next, best: Math.max(best, next), lastDate: today, changed: true, brokenDays: gap && gap > 1 ? gap - 1 : 0 };
}

/**
 * 红心恢复计算（提示词 5.2）
 * @param {{hearts:number, updatedAt:number, max:number, recoverMinutes:number}} state
 * @param {number} now
 */
export function recoverHearts(state, now = Date.now()) {
  const max = Number(state.max) || HEART_RULES.max;
  const hearts = Math.max(0, Math.min(max, Number(state.hearts)));
  if (hearts >= max) return { hearts, updatedAt: now, recovered: 0 };
  const minutes = Number(state.recoverMinutes) || HEART_RULES.recoverMinutes;
  const periodMs = minutes * 60000;
  const elapsed = Math.max(0, now - (Number(state.updatedAt) || now));
  const gained = Math.floor(elapsed / periodMs);
  if (gained <= 0) return { hearts, updatedAt: Number(state.updatedAt) || now, recovered: 0 };
  return {
    hearts: Math.min(max, hearts + gained),
    updatedAt: Number(state.updatedAt) + gained * periodMs,
    recovered: gained,
  };
}

/** 距离下一颗心恢复的剩余秒数 */
export function heartRecoverSeconds(state, now = Date.now()) {
  const max = Number(state.max) || HEART_RULES.max;
  const hearts = Math.max(0, Math.min(max, Number(state.hearts)));
  if (hearts >= max) return 0;
  const periodMs = (Number(state.recoverMinutes) || HEART_RULES.recoverMinutes) * 60000;
  const elapsed = Math.max(0, now - (Number(state.updatedAt) || now));
  return Math.max(0, Math.ceil((periodMs - (elapsed % periodMs)) / 1000));
}

/**
 * 求当前应解锁的徽章（纯函数：输入统计，输出新获得的徽章 key 列表）
 * @param {object} stats 见 collectStats()
 * @param {string[]} owned 已拥有的徽章 key
 */
export function evaluateBadges(stats = {}, owned = []) {
  const ownedSet = new Set(owned);
  const gained = [];
  const check = (key, ok) => {
    if (ok && !ownedSet.has(key)) gained.push(key);
  };
  check("first_clear", (stats.clearedNodes || 0) >= 1);
  check("first_perfect", (stats.perfectNodes || 0) >= 1);
  check("streak_3", (stats.streak || 0) >= 3);
  check("streak_7", (stats.streak || 0) >= 7);
  check("streak_30", (stats.streak || 0) >= 30);
  check("streak_100", (stats.streak || 0) >= 100);
  check("xp_500", (stats.xp || 0) >= 500);
  check("xp_2000", (stats.xp || 0) >= 2000);
  check("combo_10", (stats.maxCombo || 0) >= 10);
  check("nodes_10", (stats.clearedNodes || 0) >= 10);
  check("nodes_50", (stats.clearedNodes || 0) >= 50);
  check("stars_30", (stats.stars || 0) >= 30);
  check("accuracy_90", (stats.total || 0) >= 5 && (stats.correct || 0) / Math.max(1, stats.total) >= 0.9);
  check("review_50", (stats.reviews || 0) >= 50);
  return gained;
}

/* ------------------------------ 状态层（读写 IndexedDB） ------------------------------ */

const KEYS = {
  xp: "xp",
  streak: "streak",
  hearts: "hearts",
  badges: "badges",
  totals: "totals",
  cardsSeen: "cardsSeen",
};

/** 默认游戏化状态 */
export function defaultGame() {
  return {
    xp: 0,
    streak: { streak: 0, best: 0, lastDate: "" },
    hearts: { hearts: HEART_RULES.max, max: HEART_RULES.max, recoverMinutes: HEART_RULES.recoverMinutes, updatedAt: Date.now() },
    badges: [],
    totals: { lessons: 0, correct: 0, total: 0, reviews: 0, maxCombo: 0, perfectNodes: 0, clearedNodes: 0, stars: 0, matchedPairs: 0 },
    cardsSeen: [], // 已学习过的知识点 id（用于「学习新卡 +10」只算一次）
  };
}

/** 读取完整游戏化状态（含红心自动恢复与徽章自动结算） */
export async function loadGame() {
  const [xp, streak, hearts, badges, totals, cardsSeen] = await Promise.all([
    readGameState(KEYS.xp, 0),
    readGameState(KEYS.streak, { streak: 0, best: 0, lastDate: "" }),
    readGameState(KEYS.hearts, { hearts: HEART_RULES.max, max: HEART_RULES.max, recoverMinutes: HEART_RULES.recoverMinutes, updatedAt: Date.now() }),
    readGameState(KEYS.badges, []),
    readGameState(KEYS.totals, defaultGame().totals),
    readGameState(KEYS.cardsSeen, []),
  ]);
  const recovered = recoverHearts(hearts);
  if (recovered.recovered > 0) await writeGameState(KEYS.hearts, recovered);
  return {
    xp: Number(xp) || 0,
    streak: streak || { streak: 0, best: 0, lastDate: "" },
    hearts: { ...hearts, ...recovered },
    badges: Array.isArray(badges) ? badges : [],
    totals: { ...defaultGame().totals, ...(totals || {}) },
    cardsSeen: Array.isArray(cardsSeen) ? cardsSeen : [],
  };
}

/** 累加 XP 并同步当日统计 */
export async function addXp(amount) {
  const xp = (Number(await readGameState(KEYS.xp, 0)) || 0) + Math.max(0, Number(amount) || 0);
  await writeGameState(KEYS.xp, xp);
  return xp;
}

/** 标记知识点已学习（返回是否首次学习，用于「学习新卡 +10」） */
export async function markCardSeen(itemId) {
  const seen = (await readGameState(KEYS.cardsSeen, [])) || [];
  if (seen.includes(itemId)) return false;
  seen.push(itemId);
  await writeGameState(KEYS.cardsSeen, seen);
  return true;
}

/** 消耗 / 恢复红心 */
export async function setHearts(hearts, { updatedAt = Date.now() } = {}) {
  const prev = (await readGameState(KEYS.hearts, null)) || {};
  const max = prev.max || HEART_RULES.max;
  const value = {
    hearts: Math.max(0, Math.min(max, hearts)),
    max,
    recoverMinutes: prev.recoverMinutes || HEART_RULES.recoverMinutes,
    updatedAt,
  };
  await writeGameState(KEYS.hearts, value);
  return value;
}

/** 完成「复习 N 题」立即恢复 1 心 */
export async function grantHeartByReviewTask() {
  const game = await loadGame();
  const next = Math.min(game.hearts.max, game.hearts.hearts + 1);
  const value = await setHearts(next, { updatedAt: next >= game.hearts.max ? Date.now() : game.hearts.updatedAt });
  return value.hearts > game.hearts.hearts;
}

/** 换签（今日完成至少一次有效学习动作） */
export async function touchStreak() {
  const prev = (await readGameState(KEYS.streak, null)) || { streak: 0, best: 0, lastDate: "" };
  const next = nextStreak(prev, todayKey());
  if (next.changed) await writeGameState(KEYS.streak, { streak: next.streak, best: next.best, lastDate: next.lastDate });
  return next;
}

/** 汇总统计信息（徽章判定与统计页用） */
export async function collectStats(game = null) {
  const g = game || (await loadGame());
  const rows = await listNodeProgress();
  const cleared = [...rows.values()].filter((r) => r.cleared);
  const stars = [...rows.values()].reduce((n, r) => n + (r.stars || 0), 0);
  const perfect = [...rows.values()].filter((r) => (r.stars || 0) >= 3).length;
  const daily = await listDailyStats(365);
  const reviews = daily.reduce((n, d) => n + (d.reviews || 0), 0);
  const sessions = daily.reduce((n, d) => n + (d.lessons || 0), 0);
  return {
    xp: g.xp,
    streak: g.streak.streak,
    bestStreak: g.streak.best,
    clearedNodes: cleared.length,
    stars,
    perfectNodes: perfect,
    maxCombo: g.totals.maxCombo || 0,
    correct: g.totals.correct || 0,
    total: g.totals.total || 0,
    reviews,
    sessions,
  };
}

/** 结算并持久化徽章，返回本次新获得的徽章对象数组 */
export async function settleBadges(game = null) {
  const g = game || (await loadGame());
  const stats = await collectStats(g);
  const gained = evaluateBadges(stats, g.badges);
  if (gained.length) {
    const next = [...g.badges, ...gained];
    await writeGameState(KEYS.badges, next);
    emit(EV.DATA_CHANGED, { reason: "badges", gained });
  }
  return gained.map((k) => BADGES.find((b) => b.key === k) || { key: k, name: k, icon: "🏅", desc: "" });
}

/**
 * 关卡结算：写进度、XP、连击、当日统计、徽章，返回完整结算数据
 * @param {object} input
 * @param {string} input.nodeKey 节点唯一键
 * @param {'point'|'line'|'face'} input.nodeType
 * @param {string} input.subject
 * @param {string} [input.chapter]
 * @param {number} input.correct
 * @param {number} input.total
 * @param {number} input.wrong
 * @param {number} input.maxCombo
 * @param {number} [input.newCards] 本次新学卡片数
 * @param {number} [input.matchedPairs] 配对正确数（线关卡）
 * @param {number} [input.reviewed] 复习题数（复习模式）
 * @param {number} [input.heartsLeft]
 * @param {number} [input.durationMs]
 */
export async function settleNode(input) {
  const total = Math.max(0, Number(input.total) || 0);
  const correct = Math.max(0, Math.min(total || Infinity, Number(input.correct) || 0));
  const wrong = Math.max(0, Number(input.wrong) || (total - correct));
  const stars = calcStars({ correct, total, mistakes: wrong });
  const accuracy = total ? correct / total : 0;
  const xpDetail = settleXp({
    correct,
    total,
    wrong,
    newCards: input.newCards || 0,
    maxCombo: input.maxCombo || 0,
    reviewed: input.reviewed || 0,
    matchedPairs: input.matchedPairs || 0,
    stars,
  });

  // 1) XP + 当日统计
  const xpTotal = await addXp(xpDetail.total);
  await bumpDailyStats({
    xp: xpDetail.total,
    lessons: 1,
    correct,
    total,
    reviews: input.reviewed || 0,
    cards: input.newCards || 0,
  });

  // 2) 连击（有效学习动作）
  const streak = await touchStreak();

  // 3) 累计统计
  const game = await loadGame();
  const totals = {
    ...game.totals,
    lessons: (game.totals.lessons || 0) + 1,
    correct: (game.totals.correct || 0) + correct,
    total: (game.totals.total || 0) + total,
    reviews: (game.totals.reviews || 0) + (input.reviewed || 0),
    maxCombo: Math.max(game.totals.maxCombo || 0, input.maxCombo || 0),
    matchedPairs: (game.totals.matchedPairs || 0) + (input.matchedPairs || 0),
  };
  await writeGameState(KEYS.totals, totals);

  // 4) 关卡进度（星级只增不减）
  const progress = await saveNodeProgress({
    nodeKey: input.nodeKey,
    nodeType: input.nodeType,
    subject: input.subject,
    chapter: input.chapter || "",
    stars,
    accuracy: Math.round(accuracy * 100),
    correct,
    total,
    xp: xpDetail.total,
  });

  // 5) 会话记录
  await saveQuizSession({
    node_key: input.nodeKey,
    node_type: input.nodeType,
    subject: input.subject,
    chapter: input.chapter || "",
    stars,
    accuracy: Math.round(accuracy * 100),
    correct,
    total,
    max_combo: input.maxCombo || 0,
    new_cards: input.newCards || 0,
    xp: xpDetail.total,
    duration_ms: input.durationMs || 0,
    startedAt: input.startedAt || Date.now(),
  });

  // 6) 徽章
  const badges = await settleBadges();

  emit(EV.DATA_CHANGED, { reason: "settle", nodeKey: input.nodeKey, stars });

  return {
    stars,
    accuracy: Math.round(accuracy * 100),
    xp: xpDetail,
    xpTotal,
    streak,
    progress,
    badges,
    totals,
    goal: goalStatus((await readDailyStats()).xp, readSettings().dailyGoal),
  };
}

/**
 * 只学卡片（该知识点没有题目）的结算：
 * 记录「学习新卡」XP 与连续打卡，但**不产生星级与通关记录**（避免用无题关卡刷星）
 */
export async function settleCardOnly(input = {}) {
  const newCards = Math.max(0, Number(input.newCards) || 0);
  const xpDetail = settleXp({ newCards, correct: 0, total: 0, stars: 0 });
  const xpTotal = await addXp(xpDetail.total);
  await bumpDailyStats({ xp: xpDetail.total, lessons: 1, cards: newCards });
  const streak = await touchStreak();
  const game = await loadGame();
  await writeGameState(KEYS.totals, {
    ...game.totals,
    lessons: (game.totals.lessons || 0) + 1,
  });
  await saveQuizSession({
    node_key: input.nodeKey,
    node_type: input.nodeType || "point",
    subject: input.subject,
    chapter: input.chapter || "",
    stars: 0,
    accuracy: 0,
    correct: 0,
    total: 0,
    new_cards: newCards,
    xp: xpDetail.total,
    duration_ms: Date.now() - (input.startedAt || Date.now()),
    started_at: input.startedAt || Date.now(),
    card_only: true,
  });
  const badges = await settleBadges();
  emit(EV.DATA_CHANGED, { reason: "settle", nodeKey: input.nodeKey, stars: 0 });
  return {
    stars: 0,
    accuracy: 0,
    xp: xpDetail,
    xpTotal,
    streak,
    badges,
    cardOnly: true,
    goal: goalStatus((await readDailyStats()).xp, readSettings().dailyGoal),
  };
}

/** 今日概览（首页用） */
export async function todayOverview() {  const settings = readSettings();
  const [daily, game, rows] = await Promise.all([readDailyStats(), loadGame(), listNodeProgress()]);
  const stars = [...rows.values()].reduce((n, r) => n + (r.stars || 0), 0);
  return {
    daily,
    goal: goalStatus(daily.xp, settings.dailyGoal),
    xp: game.xp,
    rank: rankOf(game.xp),
    streak: game.streak,
    hearts: game.hearts,
    recoverSeconds: heartRecoverSeconds(game.hearts),
    badges: game.badges,
    stars,
    clearedNodes: [...rows.values()].filter((r) => r.cleared).length,
    totalNodes: 0, // 由调用方按地图补齐
  };
}

/** 最近 30 天 XP（统计页/热力图用） */
export async function xpHistory(days = 30) {
  const rows = await listDailyStats(days);
  const map = new Map(rows.map((r) => [r.date_key, r]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKey(addDays(today, -i));
    const row = map.get(key);
    out.push({ date_key: key, xp: row?.xp || 0, lessons: row?.lessons || 0, reviews: row?.reviews || 0, correct: row?.correct || 0, total: row?.total || 0 });
  }
  return out;
}

/** 把徽章 key 转为展示对象 */
export function badgeInfo(key) {
  return BADGES.find((b) => b.key === key) || { key, name: key, icon: "🏅", desc: "" };
}

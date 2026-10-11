/**
 * 艾宾浩斯遗忘曲线调度器（提示词 5.3）
 *
 * 复习档案字段：status（new / learning / mastered）、repetitions、interval（天）、
 *              next_review_date、last_result、lapses、history（间隔变化历史）
 *
 * 默认节奏：新学当日自测 1 次 → 之后第 1、2、4、7、15、30、60 天各复习一次；
 *          连续 3 次间隔复习正确 → 标记「已掌握」（此后 60 天低频巡访）；
 *          答错 → 间隔重置为 1 天、lapses + 1、进入「薄弱」队列。
 *
 * 本模块中的算法全部为纯函数，便于单元测试；读写落库的部分集中在 storage 段落。
 * @module core/scheduler
 */

import { STORES, getAll, get, put, bulkPut, count, queryByIndex, readSettings } from "./db.js";
import { addDays, dateKey, daysBetween, todayKey } from "./util.js";

/** 复习状态 */
export const REVIEW_STATUS = {
  NEW: "new",
  LEARNING: "learning",
  MASTERED: "mastered",
};

/** 自评等级（闪卡模式） */
export const GRADES = {
  remembered: { key: "remembered", label: "记得", icon: "😀", hint: "很顺利，延后复习" },
  fuzzy: { key: "fuzzy", label: "模糊", icon: "😕", hint: "有点生，保持当前间隔" },
  forgot: { key: "forgot", label: "忘记", icon: "😵", hint: "重新开始，明天再来" },
};

/** 测验结果 → 自评等级的映射（达到该正确率才算「记得」） */
export const QUIZ_THRESHOLDS = { remembered: 1, fuzzy: 0.5 };

export function defaultIntervals() {
  return [1, 2, 4, 7, 15, 30, 60];
}

/** 复习记录主键 */
export function recordId(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

/**
 * 生成一条新的复习档案（新知识点 / 新题目）
 * @param {{targetType:'item'|'question', targetId:string, itemId?:string, subject?:string, chapter?:string, title?:string}} target
 */
export function newRecord(target) {
  return {
    id: recordId(target.targetType, target.targetId),
    target_type: target.targetType,
    target_id: target.targetId,
    item_id: target.itemId || (target.targetType === "item" ? target.targetId : ""),
    subject: target.subject || "",
    chapter: target.chapter || "",
    title: target.title || "",
    status: REVIEW_STATUS.NEW,
    repetitions: 0,
    interval: 0,
    next_review_date: todayKey(), // 新学当日即进入队列
    last_review_date: "",
    last_result: "",
    lapses: 0,
    correct_streak: 0,
    review_count: 0,
    history: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

/**
 * 调度核心：根据本次复习结果计算下一状态（纯函数）
 * @param {object} record 现有档案（可为 null → 视为新档案）
 * @param {'remembered'|'fuzzy'|'forgot'} grade 自评等级
 * @param {{intervals?:number[], masteredStreak?:number, today?:string, keepIntervalOnFuzzy?:boolean}} [options]
 * @returns {object} 新的档案
 */
export function schedule(record, grade, options = {}) {
  const intervals = (options.intervals && options.intervals.length ? options.intervals : defaultIntervals())
    .slice()
    .sort((a, b) => a - b);
  const masteredStreak = Number(options.masteredStreak) || 3;
  const today = options.today || todayKey();
  const base = record ? { ...record } : newRecord({ targetType: "item", targetId: "unknown" });
  base.history = Array.isArray(base.history) ? [...base.history] : [];

  const prev = {
    interval: base.interval || 0,
    repetitions: base.repetitions || 0,
    status: base.status || REVIEW_STATUS.NEW,
    correct_streak: base.correct_streak || 0,
    next_review_date: base.next_review_date || "",
  };

  let next;
  if (grade === "forgot") {
    // 答错：间隔重置为 1 天，lapses + 1，回到学习中（进入薄弱队列）
    base.lapses = (base.lapses || 0) + 1;
    base.correct_streak = 0;
    base.repetitions = 0;
    base.interval = intervals[0];
    base.status = REVIEW_STATUS.LEARNING;
    base.next_review_date = dateKey(addDays(new Date(today), base.interval));
  } else if (grade === "fuzzy") {
    // 模糊：保持当前间隔（新卡则用第一档），正确连续数不变
    const keep = options.keepIntervalOnFuzzy !== false;
    const interval = keep && prev.interval ? prev.interval : intervals[Math.min(1, intervals.length - 1)];
    base.interval = interval;
    base.status = prev.status === REVIEW_STATUS.NEW ? REVIEW_STATUS.LEARNING : prev.status;
    base.next_review_date = dateKey(addDays(new Date(today), interval));
  } else {
    // 记得：沿间隔阶梯前进一档；走到最后一档即视为「已掌握」（默认 1→2→4→7→15→30→60，共 7 次正确）
    const lastIdx = intervals.length - 1;
    const currentIdx = prev.interval ? intervals.reduce((best, v, i) => (v <= prev.interval ? i : best), 0) : -1;
    const nextIdx = Math.min(lastIdx, currentIdx + 1);
    base.interval = intervals[nextIdx];
    base.repetitions = (prev.repetitions || 0) + 1;
    base.correct_streak = (prev.correct_streak || 0) + 1;
    base.status = nextIdx >= lastIdx ? REVIEW_STATUS.MASTERED : REVIEW_STATUS.LEARNING;
    base.next_review_date = dateKey(addDays(new Date(today), base.interval));
  }

  base.review_count = (base.review_count || 0) + 1;
  base.last_review_date = today;
  base.last_result = grade;
  base.updated_at = Date.now();
  base.history.push({
    at: today,
    grade,
    from_interval: prev.interval,
    to_interval: base.interval,
    from_status: prev.status,
    to_status: base.status,
    next_review_date: base.next_review_date,
  });
  if (base.history.length > 60) base.history = base.history.slice(-60);
  return base;
}

/** 把测验成绩换算成自评等级（提示词 5.3：测验复习同样驱动调度） */
export function gradeFromQuiz(correct, total) {
  if (!total) return "forgot";
  const acc = correct / total;
  if (acc >= QUIZ_THRESHOLDS.remembered) return "remembered";
  if (acc >= QUIZ_THRESHOLDS.fuzzy) return "fuzzy";
  return "forgot";
}

/** 是否到期（含逾期）；已掌握的知识点也按 60 天巡访到期 */
export function isDue(record, today = todayKey()) {
  if (!record) return false;
  if (!record.next_review_date) return true;
  return daysBetween(record.next_review_date, today) >= 0;
}

/** 逾期天数（正数表示已逾期） */
export function overdueDays(record, today = todayKey()) {
  if (!record?.next_review_date) return 0;
  return daysBetween(record.next_review_date, today);
}

/** 是否薄弱（答错过，或最近一次忘记） */
export function isWeak(record) {
  if (!record) return false;
  return (record.lapses || 0) > 0 || record.last_result === "forgot";
}

/** 薄弱程度排序权重：错误次数 + 是否最近忘记 */
export function weakScore(record) {
  if (!record) return 0;
  let score = (record.lapses || 0) * 10;
  if (record.last_result === "forgot") score += 15;
  if (record.status === REVIEW_STATUS.LEARNING) score += 5;
  score += Math.max(0, overdueDays(record));
  return score;
}

/** 排序：先逾期久的，再薄弱的，再新题 */
export function sortQueue(records, today = todayKey()) {
  return [...records].sort((a, b) => {
    const oa = overdueDays(a, today);
    const ob = overdueDays(b, today);
    if (ob !== oa) return ob - oa;
    const wa = weakScore(a);
    const wb = weakScore(b);
    if (wb !== wa) return wb - wa;
    return String(a.title).localeCompare(String(b.title), "zh");
  });
}

/**
 * 未来 N 天的复习负荷（评审日历热力图用）
 * @param {object[]} records
 * @param {number} days
 * @param {string} today
 */
export function forecastLoad(records, days = 30, today = todayKey()) {
  const start = new Date(today);
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const key = dateKey(addDays(start, i));
    buckets.push({ date_key: key, count: 0, overdue: 0, items: [] });
  }
  const index = new Map(buckets.map((b, i) => [b.date_key, i]));
  for (const r of records) {
    if (!r.next_review_date) continue;
    const i = index.get(r.next_review_date);
    if (i === undefined) {
      // 逾期的全部计入今天
      const delta = daysBetween(r.next_review_date, today);
      if (delta > 0) {
        buckets[0].count++;
        buckets[0].overdue++;
        buckets[0].items.push({ id: r.id, title: r.title, subject: r.subject });
      }
      continue;
    }
    buckets[i].count++;
    buckets[i].items.push({ id: r.id, title: r.title, subject: r.subject });
  }
  return buckets;
}

/**
 * 构建今日复习队列（提示词 5.3）
 * @param {object[]} allRecords 全部复习档案
 * @param {{dailyNewLimit?:number, today?:string, subject?:string, weakOnly?:boolean}} [options]
 */
export function buildQueue(allRecords, options = {}) {
  const today = options.today || todayKey();
  const dailyNewLimit = options.dailyNewLimit === undefined ? 20 : Number(options.dailyNewLimit);
  let rows = allRecords.filter((r) => !options.subject || r.subject === options.subject);

  const due = rows.filter((r) => r.status !== REVIEW_STATUS.NEW && r.review_count > 0 && isDue(r, today));
  const fresh = rows.filter((r) => r.status === REVIEW_STATUS.NEW || r.review_count === 0);
  const masteredDue = due.filter((r) => r.status === REVIEW_STATUS.MASTERED);
  const weak = rows.filter((r) => isWeak(r) && r.review_count > 0);

  const freshPicked = sortQueue(fresh, today).slice(0, Math.max(0, dailyNewLimit));
  const duePicked = sortQueue(
    due.filter((r) => r.status !== REVIEW_STATUS.MASTERED),
    today
  );

  const queue = [...duePicked, ...freshPicked];
  // 去重（防止同时命中多个类别）
  const seen = new Set();
  const unique = queue.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

  return {
    today,
    dueCount: duePicked.length,
    newCount: freshPicked.length,
    masteredDueCount: masteredDue.length,
    weakCount: weak.length,
    total: unique.length,
    queue: unique,
    weak: sortQueue(weak, today).slice(0, 20),
    mastered: rows.filter((r) => r.status === REVIEW_STATUS.MASTERED),
  };
}

/** 统计概览（复习页顶部） */
export function reviewStats(allRecords, today = todayKey()) {
  const total = allRecords.length;
  const learned = allRecords.filter((r) => r.review_count > 0).length;
  const mastered = allRecords.filter((r) => r.status === REVIEW_STATUS.MASTERED).length;
  const weak = allRecords.filter((r) => isWeak(r) && r.review_count > 0).length;
  const due = allRecords.filter((r) => r.review_count > 0 && r.status !== REVIEW_STATUS.MASTERED && isDue(r, today)).length;
  const totalReviews = allRecords.reduce((n, r) => n + (r.review_count || 0), 0);
  const totalLapses = allRecords.reduce((n, r) => n + (r.lapses || 0), 0);
  return { total, learned, mastered, weak, due, totalReviews, totalLapses };
}

/* ------------------------------ 存储层 ------------------------------ */

/** 读取全部复习档案 */
export async function listRecords() {
  return getAll(STORES.review_records);
}

/** 读取单个档案 */
export async function getRecord(targetType, targetId) {
  return get(STORES.review_records, recordId(targetType, targetId));
}

/** 新增 / 更新档案 */
export async function saveRecord(record) {
  await put(STORES.review_records, record);
  return record;
}

/**
 * 为「已有知识点但还没有复习档案」的内容补齐档案（导入后 / 首次进入复习页时调用）
 * 新知识点进入队列当日即可复习，但受每日新卡上限约束。
 *
 * 性能：记录数 == 知识点数时直接短路返回（首页/复习页每次渲染都会调用它）；
 *       需要新建时用一次 bulkPut 写入，而不是逐条 put。
 * @param {object[]} items learn_items 记录
 */
export async function ensureRecordsForItems(items) {
  if (!items || !items.length) return [];
  // 快速短路：档案数已不少于知识点数时无需再扫全表
  const total = await countRecords();
  if (total >= items.length) return [];
  const existing = new Set((await listRecords()).map((r) => r.id));
  const created = [];
  for (const it of items) {
    const id = recordId("item", it.id);
    if (existing.has(id)) continue;
    created.push(
      newRecord({
        targetType: "item",
        targetId: it.id,
        subject: it.subject,
        chapter: it.chapter,
        title: it.title,
      })
    );
  }
  if (created.length) await bulkPut(STORES.review_records, created);
  return created;
}

/** 复习档案总数（用于快速判断是否需要补齐） */
export async function countRecords() {
  return count(STORES.review_records);
}

/** 为题目补齐复习档案（题目答错时优先建档） */
export async function ensureRecordForQuestion(question) {
  const id = recordId("question", question.id);
  const existing = await get(STORES.review_records, id);
  if (existing) return existing;
  const rec = newRecord({
    targetType: "question",
    targetId: question.id,
    itemId: question.item_id,
    subject: question.subject,
    chapter: question.chapter,
    title: question.stem,
  });
  await put(STORES.review_records, rec);
  return rec;
}

/**
 * 记录一次复习结果并落库（调度 → 保存）
 * @param {object} record
 * @param {'remembered'|'fuzzy'|'forgot'} grade
 * @param {{intervals?:number[], masteredStreak?:number}} [options]
 */
export async function applyReview(record, grade, options = {}) {
  const settings = readSettings();
  const next = schedule(record, grade, {
    intervals: options.intervals || settings.reviewIntervals,
    masteredStreak: options.masteredStreak || settings.masteredStreak,
  });
  await saveRecord(next);
  return next;
}

/** 按到期日查询（索引） */
export async function dueRecords(dateKeyStr = todayKey()) {
  return queryByIndex(STORES.review_records, "next_review_date", dateKeyStr);
}

/** 调度逻辑的可读解释（设置页「算法透明度」，提示词 5.3） */
export function explainSchedule(record, options = {}) {
  const intervals = (options.intervals && options.intervals.length ? options.intervals : defaultIntervals()).slice().sort((a, b) => a - b);
  const rows = [];
  const statusText = { new: "新卡", learning: "学习中", mastered: "已掌握" };
  const gradeText = { remembered: "记得", fuzzy: "模糊", forgot: "忘记" };
  rows.push(`当前状态：${statusText[record.status] || record.status}（间隔 ${record.interval || 0} 天，已复习 ${record.review_count || 0} 次，答错 ${record.lapses || 0} 次）`);
  if (record.next_review_date) {
    const overdue = overdueDays(record);
    rows.push(`下次复习：${record.next_review_date}${overdue > 0 ? `（已逾期 ${overdue} 天）` : overdue === 0 ? "（今天到期）" : `（还有 ${-overdue} 天）`}`);
  }
  rows.push(`间隔阶梯：${intervals.join(" → ")} 天；连续正确 ${options.masteredStreak || 3} 次后标记「已掌握」（此后每 ${intervals[intervals.length - 1]} 天巡访）`);
  for (const h of (record.history || []).slice(-8)) {
    rows.push(`${h.at}：${gradeText[h.grade] || h.grade} → 间隔 ${h.from_interval} → ${h.to_interval} 天，下次 ${h.next_review_date}`);
  }
  if (!rows.length) rows.push("还没有复习记录。");
  return rows;
}

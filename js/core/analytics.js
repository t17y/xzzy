/**
 * 本地统计分析（提示词 5.2 / 六.14）
 * 全部数据来自本机记录：每日 XP、掌握曲线、错题趋势、卡片数量、科目分布
 * 图表使用内联 SVG 生成（零依赖、离线可用）
 * @module core/analytics
 */

import { STORES, getAll, listDailyStats, readSettings } from "./db.js";
import { dateKey, addDays, daysBetween, todayKey } from "./util.js";
import { listRecords, REVIEW_STATUS } from "./scheduler.js";

/** 近 N 天的日期序列 */
export function dayRange(days = 30, today = todayKey()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dateKey(addDays(new Date(today), -i)));
  return out;
}

/** 每日 XP / 复习 / 答题序列（缺失日期补 0） */
export async function dailySeries(days = 30) {
  const rows = await listDailyStats(400);
  const map = new Map(rows.map((r) => [r.date_key, r]));
  return dayRange(days).map((k) => {
    const r = map.get(k);
    return {
      date_key: k,
      xp: r?.xp || 0,
      lessons: r?.lessons || 0,
      reviews: r?.reviews || 0,
      correct: r?.correct || 0,
      total: r?.total || 0,
    };
  });
}

/**
 * 掌握曲线：每天结束时「已掌握 / 已学」的累计数量
 * 以复习档案的 history 为准（每个知识点记录每次复习后的状态）
 */
export async function masterySeries(days = 30, today = todayKey()) {
  const records = await listRecords();
  const range = dayRange(days, today);
  const start = range[0];
  return range.map((day) => {
    let learned = 0;
    let mastered = 0;
    for (const r of records) {
      const history = r.history || [];
      if (!history.length) continue;
      // 找到该日期当天结束时的状态（含当天）
      let status = REVIEW_STATUS.NEW;
      for (const h of history) {
        if (h.at <= day) status = h.to_status;
        else break;
      }
      if (status !== REVIEW_STATUS.NEW) learned++;
      if (status === REVIEW_STATUS.MASTERED) mastered++;
    }
    return { date_key: day, learned, mastered };
  });
}

/** 错题趋势：每天新增错题数与新增「已移出」数 */
export async function wrongTrend(days = 30, today = todayKey()) {
  const rows = await getAll(STORES.wrong_answers);
  const range = dayRange(days, today);
  const index = new Map(range.map((d, i) => [d, i]));
  const buckets = range.map((d) => ({ date_key: d, added: 0, resolved: 0 }));
  const events = [];
  for (const r of rows) {
    for (const ev of r.history || []) {
      events.push({ at: ev.at, type: ev.type });
    }
    // 兜底：没有历史记录时用 last_wrong_at
    if (!(r.history || []).length && r.last_wrong_at) {
      events.push({ at: dateKey(new Date(r.last_wrong_at)), type: "wrong" });
    }
    if (r.resolved_at) events.push({ at: dateKey(new Date(r.resolved_at)), type: "resolved" });
  }
  for (const ev of events) {
    const i = index.get(ev.at);
    if (i === undefined) continue;
    if (ev.type === "wrong") buckets[i].added++;
    else if (ev.type === "resolved") buckets[i].resolved++;
  }
  return buckets;
}

/** 卡片概览：基础 / 错题精华 / 书签 / 有备注 */
export async function cardStats() {
  const cards = await getAll(STORES.cards);
  const base = cards.filter((c) => c.source !== "wrong");
  const wrong = cards.filter((c) => c.source === "wrong");
  return {
    total: cards.length,
    base: base.length,
    wrong: wrong.length,
    bookmarked: cards.filter((c) => c.bookmarked).length,
    noted: cards.filter((c) => c.note).length,
    bySubject: groupCount(cards, (c) => c.subject),
    byChapterTop: groupCount(cards, (c) => `${c.subject} / ${c.chapter}`),
  };
}

/** 复习状态分布 */
export async function reviewBreakdown() {
  const records = await listRecords();
  const total = records.length;
  const byStatus = { new: 0, learning: 0, mastered: 0 };
  let lapses = 0;
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    lapses += r.lapses || 0;
  }
  const due = records.filter((r) => r.next_review_date && daysBetween(r.next_review_date, todayKey()) >= 0 && r.review_count > 0).length;
  return { total, ...byStatus, lapses, due };
}

/** 科目维度汇总（关卡、星数、卡片、错题） */
export async function subjectBreakdown(maps = []) {
  const [cards, wrongs] = await Promise.all([getAll(STORES.cards), getAll(STORES.wrong_answers)]);
  const subjects = new Set([
    ...maps.map((m) => m.subject),
    ...cards.map((c) => c.subject),
    ...wrongs.map((w) => w.subject),
  ]);
  return [...subjects].filter(Boolean).map((subject) => {
    const map = maps.find((m) => m.subject === subject);
    const cs = cards.filter((c) => c.subject === subject);
    const ws = wrongs.filter((w) => w.subject === subject);
    return {
      subject,
      nodes: map?.total || 0,
      cleared: map?.cleared || 0,
      stars: map?.stars || 0,
      maxStars: map?.maxStars || 0,
      cards: cs.length,
      wrongCards: cs.filter((c) => c.source === "wrong").length,
      wrongs: ws.filter((w) => !w.resolved).length,
      wrongTimes: ws.reduce((n, w) => n + (w.times || 1), 0),
    };
  });
}

function groupCount(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item) || "未分类";
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/* ------------------------------ 内联 SVG 图表 ------------------------------ */

/**
 * 折线图（掌握曲线 / 任意多序列）
 * @param {{series: Array<{name:string, color:string, points:number[]}>, labels:string[], height?:number, yMax?:number}} opts
 */
export function lineChartSvg({ series = [], labels = [], height = 120, yMax = 0 }) {
  const w = 320;
  const padL = 26;
  const padB = 16;
  const padT = 8;
  const innerW = w - padL - 6;
  const innerH = height - padB - padT;
  const allPoints = series.reduce((acc, s) => acc.concat(s.points || []), []);
  const max = Math.max(1, Number(yMax) || 0, ...allPoints);
  const stepX = labels.length > 1 ? innerW / (labels.length - 1) : innerW;
  const y = (v) => padT + innerH - (v / max) * innerH;
  const x = (i) => padL + i * stepX;

  const grid = [0, 0.5, 1]
    .map((t) => {
      const gy = padT + innerH - t * innerH;
      return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${w - 6}" y2="${gy.toFixed(1)}" stroke="currentColor" stroke-opacity="0.12" stroke-width="1" />
        <text x="${padL - 4}" y="${(gy + 3).toFixed(1)}" font-size="8" text-anchor="end" fill="currentColor" fill-opacity="0.45">${Math.round(
          max * t
        )}</text>`;
    })
    .join("");

  const paths = series
    .map((s) => {
      const d = s.points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    })
    .join("");

  const legend = series
    .map(
      (s, i) =>
        `<g transform="translate(${padL + i * 78}, ${height - 4})"><rect x="0" y="-6" width="8" height="8" rx="2" fill="${s.color}" /><text x="12" y="1" font-size="9" fill="currentColor" fill-opacity="0.7">${escapeSvg(s.name)}</text></g>`
    )
    .join("");

  const axis = `<text x="${padL}" y="${height - 4}" font-size="9" fill="currentColor" fill-opacity="0.45">${escapeSvg(
    labels[0] || ""
  )}</text><text x="${w - 6}" y="${height - 4}" font-size="9" text-anchor="end" fill="currentColor" fill-opacity="0.45">${escapeSvg(
    labels[labels.length - 1] || ""
  )}</text>`;

  return `<svg viewBox="0 0 ${w} ${height}" width="100%" height="${height}" role="img" aria-label="折线图">${grid}${paths}${legend}${axis}</svg>`;
}

/** 柱状图（错题趋势 / 每日 XP） */
export function barChartSvg({ bars = [], labels = [], height = 110, color = "var(--red)", goal = 0 }) {
  const w = 320;
  const padL = 26;
  const padB = 16;
  const padT = 8;
  const innerW = w - padL - 6;
  const innerH = height - padB - padT;
  const max = Math.max(1, ...bars.map((b) => b.value), goal);
  const bw = bars.length ? (innerW / bars.length) * 0.62 : 0;
  const gap = bars.length ? innerW / bars.length : 0;
  const y = (v) => padT + innerH - (v / max) * innerH;

  const grid = [0, 0.5, 1]
    .map((t) => {
      const gy = padT + innerH - t * innerH;
      return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${w - 6}" y2="${gy.toFixed(1)}" stroke="currentColor" stroke-opacity="0.12" />`;
    })
    .join("");

  const rects = bars
    .map((b, i) => {
      const h = Math.max(b.value > 0 ? 2 : 0, (b.value / max) * innerH);
      const bx = padL + i * gap + (gap - bw) / 2;
      const by = padT + innerH - h;
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${
        b.value ? color : "currentColor"
      }" fill-opacity="${b.value ? 0.85 : 0.12}" />`;
    })
    .join("");

  const goalLine =
    goal > 0
      ? `<line x1="${padL}" y1="${y(goal).toFixed(1)}" x2="${w - 6}" y2="${y(goal).toFixed(1)}" stroke="var(--green)" stroke-dasharray="4 3" stroke-width="1.5" />`
      : "";

  const axis = `<text x="${padL}" y="${height - 4}" font-size="9" fill="currentColor" fill-opacity="0.45">${escapeSvg(
    labels[0] || ""
  )}</text><text x="${w - 6}" y="${height - 4}" font-size="9" text-anchor="end" fill="currentColor" fill-opacity="0.45">${escapeSvg(
    labels[labels.length - 1] || ""
  )}</text>`;

  return `<svg viewBox="0 0 ${w} ${height}" width="100%" height="${height}" role="img" aria-label="柱状图">${grid}${goalLine}${rects}${axis}</svg>`;
}

/** 迷你热力条（与原统计页保持一致的风格） */
export function heatmapSvg({ values = [], labels = [], height = 72, goal = 0 }) {
  const max = Math.max(1, ...values, goal);
  const cells = values
    .map((v, i) => {
      const h = Math.max(v > 0 ? 3 : 2, (v / max) * (height - 10));
      const reached = goal > 0 && v >= goal;
      return `<rect x="${(i * (100 / Math.max(1, values.length))).toFixed(2)}%" y="${(height - h).toFixed(1)}" width="${(
        100 / Math.max(1, values.length) -
        0.6
      ).toFixed(2)}%" height="${h.toFixed(1)}" rx="1.5" fill="${
        reached ? "var(--green)" : v > 0 ? "var(--green-soft)" : "currentColor"
      }" fill-opacity="${v > 0 ? 1 : 0.12}" />`;
    })
    .join("");
  return `<svg viewBox="0 0 100 ${height}" preserveAspectRatio="none" width="100%" height="${height}" role="img" aria-label="每日 XP 热力条">${cells}</svg>`;
}

function escapeSvg(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/** 一次取齐统计页需要的全部数据 */
export async function fullStats({ maps = [] } = {}) {
  const settings = readSettings();
  const [daily, mastery, wrong, cards, review] = await Promise.all([
    dailySeries(30),
    masterySeries(30),
    wrongTrend(30),
    cardStats(),
    reviewBreakdown(),
  ]);
  const subjects = await subjectBreakdown(maps);
  const totals = daily.reduce(
    (acc, d) => ({
      xp: acc.xp + d.xp,
      correct: acc.correct + d.correct,
      total: acc.total + d.total,
      reviews: acc.reviews + d.reviews,
      lessons: acc.lessons + d.lessons,
    }),
    { xp: 0, correct: 0, total: 0, reviews: 0, lessons: 0 }
  );
  return {
    daily,
    mastery,
    wrong,
    cards,
    review,
    subjects,
    totals,
    activeDays: daily.filter((d) => d.xp > 0).length,
    dailyGoal: settings.dailyGoal,
    labels: daily.map((d) => d.date_key.slice(5)),
  };
}

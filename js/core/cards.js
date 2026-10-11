/**
 * 错题整理 + 精华卡片（提示词 5.4 / 5.5）
 *
 * 零 AI 生成：卡片内容只做「抽取 + 排版」——
 *   基础卡片 = 知识点正文摘要 + 要点（正面）+ 易错点（背面）
 *   错题精华卡片 = 错题所属知识点的要点/易错点/正文聚合，并按知识点去重
 *
 * @module core/cards
 */

import {
  STORES,
  getAll,
  get,
  put,
  del,
  clearStore,
  bulkPut,
  queryByIndex,
  listItems,
  listQuestions,
  readSettings,
  readGameState,
  writeGameState,
} from "./db.js";
import { emit, EV } from "./events.js";
import { normalizeText, stableKey, stripInlineMd, truncate, uniq, todayKey, hashStr } from "./util.js";

/* ------------------------------ 卡片生成 ------------------------------ */

/** 卡片来源 */
export const CARD_SOURCE = {
  BASE: "base", // 导入时自动生成的基础卡片
  WRONG: "wrong", // 错题一键生成的精华卡片
};

/** 由知识点生成基础卡片（幂等：同一知识点只生成一张基础卡片） */
export function itemToCard(item, { source = CARD_SOURCE.BASE } = {}) {
  const keyPoints = item.key_points || [];
  const mistakes = item.common_mistakes || [];
  const summary = normalizeText(stripInlineMd(item.content || "")).slice(0, 200);
  return {
    id: `${source}_${item.id}`,
    item_id: item.id,
    subject: item.subject,
    chapter: item.chapter,
    title: item.title,
    summary,
    content: item.content || "",
    key_points: [...keyPoints],
    common_mistakes: [...mistakes],
    tags: item.tags || [],
    difficulty: item.difficulty || 1,
    related_ids: item.related_ids || [],
    source,
    note: "", // 个人备注（编辑卡片时写入，不污染原始导入数据）
    bookmarked: false,
    created_at: Date.now(),
    updated_at: Date.now(),
    import_id: item.import_id || "",
  };
}

/**
 * 同步基础卡片（导入后 / 首次进入书架时调用）
 * 性能：内容比对改为「指纹比哈希」而不是 JSON.stringify；更新改为一次 bulkPut 写入。
 * @param {object[]} items learn_items
 * @returns {Promise<{created:number, total:number, updated:number}>}
 */
export async function syncBaseCards(items = null) {
  const list = items || (await listItems());
  // 只需读取基础卡片，避免把全部错题精华卡片也读进内存
  const baseCards = await queryByIndex(STORES.cards, "source", CARD_SOURCE.BASE);
  const byItem = new Map(baseCards.map((c) => [c.item_id, c]));
  const toCreate = [];
  const toUpdate = [];
  for (const it of list) {
    const prev = byItem.get(it.id);
    if (!prev) {
      toCreate.push(itemToCard(it));
      continue;
    }
    const fresh = itemToCard(it);
    if (cardFingerprint(prev) !== cardFingerprint(fresh)) {
      toUpdate.push({ ...prev, ...fresh, note: prev.note, bookmarked: prev.bookmarked, created_at: prev.created_at });
    }
  }
  // 一次事务写入（原来逐条 put，几百条时非常慢）
  if (toCreate.length || toUpdate.length) await bulkPut(STORES.cards, [...toCreate, ...toUpdate]);
  return { created: toCreate.length, updated: toUpdate.length, total: list.length };
}

/** 卡片内容指纹（用于判断是否需要同步；比 JSON.stringify 快得多） */
function cardFingerprint(card) {
  return [
    hashStr(card.summary || ""),
    hashStr(card.content || ""),
    hashStr((card.key_points || []).join("\u0001")),
    hashStr((card.common_mistakes || []).join("\u0001")),
    card.subject || "",
    card.chapter || "",
    card.title || "",
    card.difficulty || 1,
  ].join("|");
}

/* ------------------------------ 错题本 ------------------------------ */

/**
 * 记录一次答错（同题重复答错累加 times）
 * @param {{question:object, userAnswer:any, correctAnswer:string, source:'level'|'review'|'face', nodeKey?:string}} input
 */
export async function recordWrong(input) {
  const q = input.question || {};
  const id = `wa_${stableKey(q.id || q.stem, q.item_id || "")}`;
  const prev = await get(STORES.wrong_answers, id);
  const row = {
    id,
    question_id: q.id || "",
    item_id: q.item_id || "",
    subject: q.subject || "",
    chapter: q.chapter || "",
    type: q.type || "single",
    stem: q.stem || "",
    options: q.options || [],
    answer: input.correctAnswer !== undefined ? String(input.correctAnswer) : String(q.answer || ""),
    user_answer: formatAnswer(input.userAnswer),
    analysis: q.analysis || "",
    source: input.source || "level",
    node_key: input.nodeKey || "",
    times: (prev?.times || 0) + 1,
    created_at: prev?.created_at || Date.now(),
    last_wrong_at: Date.now(),
    correct_streak: 0, // 连续答对次数（用于「移出错题本」）
    resolved: false,
    resolved_at: 0,
    history: [...(prev?.history || []), { at: todayKey(), type: "wrong" }].slice(-80),
  };
  await put(STORES.wrong_answers, row);
  emit(EV.DATA_CHANGED, { reason: "wrong", id });
  return row;
}

/** 记录一次答对（推动「连续 3 次正确 → 移出错题本」） */
export async function recordCorrect(question) {
  const q = question || {};
  const id = `wa_${stableKey(q.id || q.stem, q.item_id || "")}`;
  const prev = await get(STORES.wrong_answers, id);
  if (!prev || prev.resolved) return null;
  const streak = (prev.correct_streak || 0) + 1;
  const resolved = streak >= 3;
  const row = {
    ...prev,
    correct_streak: streak,
    resolved,
    resolved_at: resolved ? Date.now() : 0,
    history: resolved
      ? [...(prev.history || []), { at: todayKey(), type: "resolved" }].slice(-80)
      : prev.history || [],
  };
  await put(STORES.wrong_answers, row);
  if (resolved) emit(EV.DATA_CHANGED, { reason: "wrong-resolved", id });
  return row;
}

/** 把任意作答格式转成可读文本 */
export function formatAnswer(answer) {
  if (answer === undefined || answer === null) return "";
  if (Array.isArray(answer)) return answer.map((x) => String(x)).join(",");
  if (typeof answer === "object") {
    if (Array.isArray(answer.pairs)) return answer.pairs.map((p) => `${p.left}-${p.right}`).join(",");
    return JSON.stringify(answer);
  }
  return String(answer);
}

/** 全部错题（含已移出；默认只返回未移出） */
export async function listWrong({ includeResolved = false } = {}) {
  const rows = await getAll(STORES.wrong_answers);
  const filtered = includeResolved ? rows : rows.filter((r) => !r.resolved);
  return filtered.sort((a, b) => (b.times || 0) - (a.times || 0) || (b.last_wrong_at || 0) - (a.last_wrong_at || 0));
}
/** 按科目 / 章节分组 */
export function groupWrong(rows) {
  const bySubject = new Map();
  for (const r of rows) {
    if (!bySubject.has(r.subject || "未分类")) bySubject.set(r.subject || "未分类", []);
    bySubject.get(r.subject || "未分类").push(r);
  }
  return bySubject;
}

/** 薄弱知识点榜（按错误次数排序） */
export async function weakRanking(limit = 20) {
  const rows = await listWrong();
  const byItem = new Map();
  const items = await listItems();
  const titleOf = new Map(items.map((i) => [i.id, i]));
  for (const r of rows) {
    if (!byItem.has(r.item_id)) {
      byItem.set(r.item_id, {
        item_id: r.item_id,
        subject: r.subject,
        chapter: r.chapter,
        title: titleOf.get(r.item_id)?.title || truncate(r.stem, 24),
        times: 0,
        questions: 0,
      });
    }
    const row = byItem.get(r.item_id);
    row.times += r.times || 1;
    row.questions += 1;
  }
  return [...byItem.values()].sort((a, b) => b.times - a.times).slice(0, limit);
}

/**
 * 一键生成错题精华卡片（提示词 5.5）
 * 扫描错题 → 提取所属知识点 → 按知识点去重聚合 → 生成卡片 → 放入「错题精华」书架
 * @param {{onProgress?: (p:{done:number,total:number,title:string})=>void, onlyIds?:string[]}} [options]
 */
export async function generateWrongCards(options = {}) {
  const wrongs = (await listWrong()).filter((w) => !options.onlyIds || options.onlyIds.includes(w.id));
  const items = await listItems();
  const itemById = new Map(items.map((i) => [i.id, i]));
  const existing = await getAll(STORES.cards);
  const existingByItem = new Map(existing.filter((c) => c.source === CARD_SOURCE.WRONG).map((c) => [c.item_id, c]));

  // 按知识点去重聚合
  const groups = new Map();
  for (const w of wrongs) {
    const key = w.item_id || `q:${w.question_id}`;
    if (!groups.has(key)) groups.set(key, { item: itemById.get(w.item_id), wrongs: [] });
    groups.get(key).wrongs.push(w);
  }

  const total = groups.size;
  let done = 0;
  let created = 0;
  let merged = 0;
  const cardIds = [];

  for (const [key, group] of groups) {
    done++;
    const item = group.item;
    const title = item ? item.title : truncate(group.wrongs[0]?.stem || "错题精华", 26);
    options.onProgress?.({ done, total, title });

    const stemList = group.wrongs.map((w) => normalizeText(w.stem)).filter(Boolean);
    const analysisList = uniq(group.wrongs.map((w) => normalizeText(w.analysis)).filter(Boolean));
    const keyPoints = item ? uniq([...(item.key_points || []), ...stemList.map((s) => truncate(s, 60))]) : stemList.map((s) => truncate(s, 60));
    const mistakes = uniq([
      ...(item?.common_mistakes || []),
      ...group.wrongs.map((w) => `错答：${w.user_answer || "—"} → 正确：${w.answer}`),
    ]);
    const summary = item
      ? normalizeText(stripInlineMd(item.content || "")).slice(0, 200)
      : `共 ${group.wrongs.length} 道错题，错误 ${group.wrongs.reduce((n, w) => n + (w.times || 1), 0)} 次`;

    const prev = existingByItem.get(key);
    const row = {
      id: `${CARD_SOURCE.WRONG}_${key}`,
      item_id: item?.id || group.wrongs[0]?.item_id || "",
      subject: item?.subject || group.wrongs[0]?.subject || "未分类",
      chapter: item?.chapter || group.wrongs[0]?.chapter || "未分章",
      title,
      summary,
      content: item?.content || "",
      key_points: keyPoints.slice(0, 12),
      common_mistakes: mistakes.slice(0, 12),
      tags: uniq([...(item?.tags || []), "错题精华"]),
      difficulty: item?.difficulty || 2,
      related_ids: item?.related_ids || [],
      source: CARD_SOURCE.WRONG,
      wrong_ids: group.wrongs.map((w) => w.id),
      question_count: group.wrongs.length,
      wrong_times: group.wrongs.reduce((n, w) => n + (w.times || 1), 0),
      analysis: analysisList.slice(0, 6),
      note: prev?.note || "",
      bookmarked: prev?.bookmarked || false,
      created_at: prev?.created_at || Date.now(),
      updated_at: Date.now(),
      in_review: true, // 一键生成后自动加入今日复习队列
    };
    await put(STORES.cards, row);
    cardIds.push(row.id);
    if (prev) merged++;
    else created++;
  }

  emit(EV.DATA_CHANGED, { reason: "wrong-cards", created, merged });
  invalidateCardsCache();
  return { created, merged, cards: cardIds, scanned: wrongs.length, knowledgePoints: total };
}

/** 把错题精华卡片加入复习队列（为其所属知识点建档） */
export async function addCardsToReview(cardIds) {
  const { ensureRecordsForItems } = await import("./scheduler.js");
  const ids = new Set(cardIds);
  // 只读取需要的那几张卡片，避免把整个书架读进内存
  const cards = [];
  for (const id of ids) {
    const c = await get(STORES.cards, id);
    if (c) cards.push(c);
  }
  const itemIds = uniq(cards.filter((c) => c.item_id).map((c) => c.item_id));
  if (!itemIds.length) return { queued: 0, created: 0 };
  const itemIdSet = new Set(itemIds);
  const items = (await listItems()).filter((i) => itemIdSet.has(i.id));
  const created = await ensureRecordsForItems(items);
  return { queued: itemIds.length, created: created.length };
}

/* ------------------------------ 书架与检索 ------------------------------ */

/** 书架的三种分组视图 */
export async function shelf() {
  const cards = await getAll(STORES.cards);
  const bySubject = new Map();
  const byTag = new Map();
  const bySource = { base: 0, wrong: 0 };
  for (const c of cards) {
    if (!bySubject.has(c.subject)) bySubject.set(c.subject, { subject: c.subject, total: 0, base: 0, wrong: 0, chapters: new Set() });
    const s = bySubject.get(c.subject);
    s.total++;
    s[c.source === CARD_SOURCE.WRONG ? "wrong" : "base"]++;
    s.chapters.add(c.chapter);
    for (const t of c.tags || []) {
      if (!byTag.has(t)) byTag.set(t, { tag: t, total: 0, wrong: 0 });
      byTag.get(t).total++;
      if (c.source === CARD_SOURCE.WRONG) byTag.get(t).wrong++;
    }
    bySource[c.source === CARD_SOURCE.WRONG ? "wrong" : "base"]++;
  }
  return {
    total: cards.length,
    bookmarked: cards.filter((c) => c.bookmarked).length,
    wrongCards: bySource.wrong,
    baseCards: bySource.base,
    subjects: [...bySubject.values()].map((s) => ({ ...s, chapters: s.chapters.size })),
    tags: [...byTag.values()].sort((a, b) => b.total - a.total),
    cards,
  };
}

/**
 * 卡片列表查询
 * @param {{subject?:string, tag?:string, source?:string, bookmarked?:boolean, q?:string, itemId?:string}} [filter]
 */
export async function listCards(filter = {}) {
  let cards = await getAll(STORES.cards);
  if (filter.subject) cards = cards.filter((c) => c.subject === filter.subject);
  if (filter.tag) cards = cards.filter((c) => (c.tags || []).includes(filter.tag));
  if (filter.source) cards = cards.filter((c) => c.source === filter.source);
  if (filter.bookmarked) cards = cards.filter((c) => c.bookmarked);
  if (filter.itemId) cards = cards.filter((c) => c.item_id === filter.itemId);
  if (filter.q) {
    const q = normalizeText(filter.q).toLowerCase();
    cards = cards.filter((c) =>
      [c.title, c.summary, c.content, (c.key_points || []).join(" "), (c.common_mistakes || []).join(" "), (c.tags || []).join(" "), c.note]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }
  return cards.sort(
    (a, b) =>
      String(a.subject).localeCompare(String(b.subject), "zh") ||
      String(a.chapter).localeCompare(String(b.chapter), "zh") ||
      String(a.title).localeCompare(String(b.title), "zh")
  );
}

/** 卡片详情 */
export async function getCard(id) {
  return get(STORES.cards, id);
}

/** 保存卡片编辑（要点 / 易错点 / 备注 / 书签） */
export async function saveCard(card) {
  const row = { ...card, updated_at: Date.now() };
  await put(STORES.cards, row);
  invalidateCardsCache();
  emit(EV.DATA_CHANGED, { reason: "card-saved", id: row.id });
  return row;
}

/** 切换书签 */
export async function toggleBookmark(id) {
  const card = await get(STORES.cards, id);
  if (!card) return null;
  const row = { ...card, bookmarked: !card.bookmarked, updated_at: Date.now() };
  await put(STORES.cards, row);
  invalidateCardsCache();
  return row;
}

/** 删除卡片（错题精华删除后不影响基础卡片） */
export async function removeCard(id) {
  await del(STORES.cards, id);
  invalidateCardsCache();
  emit(EV.DATA_CHANGED, { reason: "card-removed", id });
  return true;
}

/** 清空全部卡片（重置时使用） */
export async function clearCards() {
  await clearStore(STORES.cards);
  invalidateCardsCache();
  return true;
}

/* ------------------------------ 阅读器状态 ------------------------------ */

const READ_KEY = "reader:last";

/** 续读记忆（每个筛选视图各自记录最后位置） */
export async function saveReadPosition(scope, cardId, index = 0) {
  const all = (await readGameState(READ_KEY, {})) || {};
  all[scope] = { cardId, index, at: Date.now() };
  await writeGameState(READ_KEY, all);
  return all[scope];
}

export async function readPosition(scope) {
  const all = (await readGameState(READ_KEY, {})) || {};
  return all[scope] || null;
}

/* ------------------------------ 阅读辅助 ------------------------------ */

/**
 * 阅读列表缓存：卡片数量较多时，避免每次点「下一张」都重读整个书架。
 * 只在卡片被编辑/删除/重新生成时失效。
 */
const _cache = { key: "", at: 0, rows: null, itemIndex: null };
const CACHE_TTL = 5000;

export function invalidateCardsCache() {
  _cache.key = "";
  _cache.rows = null;
  _cache.itemIndex = null;
}

/** 卡片 id → item_id 的索引（错题卡片需要它来统计） */
async function itemIndex() {
  if (_cache.itemIndex && _cache.key) return _cache.itemIndex;
  const rows = await getAll(STORES.cards);
  _cache.itemIndex = new Map(rows.map((r) => [r.id, r.item_id]));
  return _cache.itemIndex;
}

/** 卡片页码索引（电子书：按科目/标签/来源筛选后的顺序，带 5 秒缓存） */
export async function readerList(filter = {}) {
  const key = JSON.stringify(filter);
  const now = Date.now();
  if (_cache.key === key && _cache.rows && now - _cache.at < CACHE_TTL) {
    return _cache.rows;
  }
  const cards = await listCards(filter);
  const rows = cards.map((c, i) => ({ ...c, _index: i, _total: cards.length }));
  _cache.key = key;
  _cache.at = now;
  _cache.rows = rows;
  _cache.itemIndex = new Map(cards.map((c) => [c.id, c.item_id]));
  return rows;
}

/** 单张卡片（供阅读器按 id 快速取用） */
export async function cachedCard(id) {
  if (_cache.rows) {
    const hit = _cache.rows.find((c) => c.id === id);
    if (hit) return hit;
  }
  return get(STORES.cards, id);
}

/** 预取相邻卡片（翻页时用） */
export function neighbors(cards, index) {
  return {
    prev: index > 0 ? cards[index - 1] : null,
    next: index < cards.length - 1 ? cards[index + 1] : null,
  };
}

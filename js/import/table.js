/**
 * 兼容格式解析（次选）：CSV / Excel(.xlsx) / JSON
 * 统一产出与 Markdown 解析相同的 ParseResult 结构，复用同一套校验与导入报告
 * （提示词 3.4 / 4.4）。
 *
 * 表格列约定（列名可用别名，见 FIELD_ALIASES）：
 *   科目 | 章节 | 知识点 | 正文 | 要点 | 易错点 | 标签 | 难度 | 题目 | 选项 | 答案 | 解析 | 题型
 * 其中「题目」起为题目列：同一行的题目/选项/答案/解析构成一道题；
 * 若需要多题，可写多行，知识点列留空表示沿用上一行。
 * @module import/table
 */

import { normalizeText, stableKey, uniq } from "../core/util.js";
import { createResult, addIssue, buildItemDerived, finalizeResult, SEV } from "./parse-result.js";
import { detectType, normalizeAnswerRaw, validateQuestion } from "./markdown.js";

/** 字段别名表（自动猜测用） */
export const FIELD_ALIASES = {
  subject: ["科目", "学科", "课程", "subject", "course"],
  chapter: ["章节", "章", "篇章", "chapter", "section"],
  title: ["知识点", "考点", "标题", "名称", "知识点名称", "title", "name", "point"],
  content: ["正文", "内容", "知识点内容", "描述", "content", "body", "detail"],
  key_points: ["要点", "重点", "关键点", "考点要点", "key_points", "keypoints", "points"],
  common_mistakes: ["易错点", "易错", "误区", "口诀", "mistakes", "common_mistakes"],
  tags: ["标签", "分类", "tag", "tags", "label"],
  difficulty: ["难度", "星级", "difficulty", "level", "star", "stars"],
  related: ["关联", "相关", "related", "related_items"],
  stem: ["题目", "题干", "问题", "question", "stem"],
  options: ["选项", "options", "choices"],
  answer: ["答案", "正确答案", "answer", "key"],
  analysis: ["解析", "答案解析", "分析", "analysis", "explain", "explanation"],
  type: ["题型", "类型", "type", "question_type"],
};

/** 归一化表头：去空白、全角冒号、统一小写 */
export function normalizeHeader(h) {
  return normalizeText(h).replace(/[：:]/g, "").replace(/\s+/g, "").toLowerCase();
}

/** 猜测列 → 字段映射（先精确匹配全部字段，再对未命中字段做约束模糊匹配） */
export function guessMapping(headers) {
  const mapping = {};
  const normalized = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const used = new Set();
  const usedFields = new Set();
  const fields = Object.entries(FIELD_ALIASES);

  // 第一轮：精确匹配（避免「知识点」被「内容」的模糊规则先抢走）
  for (const [field, aliases] of fields) {
    const aliasKeys = aliases.map((a) => normalizeHeader(a));
    const hit = normalized.find((h) => !used.has(h.raw) && aliasKeys.includes(h.key));
    if (hit) {
      mapping[hit.raw] = field;
      used.add(hit.raw);
      usedFields.add(field);
    }
  }

  // 第二轮：模糊匹配（仅对尚未映射的列与字段，较短一方须完全包含于较长一方）
  for (const [field, aliases] of fields) {
    if (usedFields.has(field)) continue;
    const aliasKeys = aliases.map((a) => normalizeHeader(a));
    const hit = normalized.find((h) => {
      if (used.has(h.raw)) return false;
      return aliasKeys.some((a) => {
        const short = a.length <= h.key.length ? a : h.key;
        const long = a.length <= h.key.length ? h.key : a;
        return short.length >= 2 && long.includes(short);
      });
    });
    if (hit) {
      mapping[hit.raw] = field;
      used.add(hit.raw);
      usedFields.add(field);
    }
  }
  return mapping;
}

/** 兼容首行 BOM 与空行 */
function cleanRows(rows) {
  return rows
    .map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c))) : []))
    .filter((r) => r.some((c) => normalizeText(c) !== ""));
}

/**
 * 解析表格数据（行数组）→ ParseResult
 * @param {string[][]} rawRows 第一行为表头
 * @param {{name?:string, kind?:string, mapping?:Record<string,string>}} [options]
 */
export function parseTableRows(rawRows, options = {}) {
  const rows = cleanRows(rawRows);
  const result = createResult({
    kind: options.kind || "csv",
    name: options.name || "表格数据",
    mode: "table",
  });
  if (!rows.length) {
    addIssue(result, SEV.ERROR, "文件为空，没有可解析的数据行。", { line: 1 });
    finalizeResult(result);
    return result;
  }
  const headers = rows[0].map((h, i) => normalizeText(h) || `列${i + 1}`);
  const mapping = options.mapping && Object.keys(options.mapping).length ? options.mapping : guessMapping(headers);
  result.mapping = mapping;
  result.headers = headers;

  const colOf = (field) => {
    const header = Object.keys(mapping).find((k) => mapping[k] === field);
    if (!header) return -1;
    return headers.indexOf(header);
  };
  const required = ["subject", "title"];
  const missing = required.filter((f) => colOf(f) < 0 && colOf("chapter") < 0);
  if (colOf("title") < 0) {
    addIssue(result, SEV.ERROR, "未能识别「知识点」列。请在字段映射中把某一列指定为「知识点」。", { line: 1 });
  } else if (missing.length && colOf("subject") < 0) {
    addIssue(result, SEV.WARN, "未识别到「科目」列，所有内容将归入「未分类」。", { line: 1 });
  }

  const get = (row, field) => {
    const idx = colOf(field);
    return idx >= 0 ? normalizeText(row[idx]) : "";
  };
  const splitList = (v) => v.split(/[|,，、;；\n]+/).map((s) => normalizeText(s)).filter(Boolean);

  let lastItem = null;
  let itemOrder = 0;
  let questionOrder = 0;
  const itemByKey = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 1; // 与源文件一致（含表头）
    const subject = get(row, "subject") || lastItem?.subject || "未分类";
    const chapter = get(row, "chapter") || lastItem?.chapter || "未分章";
    const title = get(row, "title");
    const content = get(row, "content");
    const stem = get(row, "stem");

    if (!title) {
      // 无知识点名：沿用上一条（多行题目）
      if (lastItem) {
        lastItem.stemRows = lastItem.stemRows || [];
        if (stem || get(row, "answer")) lastItem.stemRows.push({ row, line });
        continue;
      }
      addIssue(result, SEV.ERROR, "该行缺少「知识点」列，且上方没有可沿用的知识点，已跳过。", { line });
      result.stats.skippedLines++;
      continue;
    }

    const key = `${subject}\u0001${chapter}\u0001${title}`;
    let item = itemByKey.get(key);
    if (!item) {
      item = {
        id: `li_${stableKey(subject, chapter, title)}`,
        subject,
        chapter,
        title,
        content,
        key_points: splitList(get(row, "key_points")),
        common_mistakes: splitList(get(row, "common_mistakes")),
        related_titles: splitList(get(row, "related")),
        related_ids: [],
        tags: splitList(get(row, "tags")),
        difficulty: parseDifficultyCell(get(row, "difficulty")),
        order: ++itemOrder,
        line,
        stemRows: [],
      };
      itemByKey.set(key, item);
      result.items.push(item);
      lastItem = item;
    } else if (content && !item.content.includes(content)) {
      item.content = `${item.content}\n${content}`.trim();
    }
    if (stem || get(row, "answer")) item.stemRows.push({ row, line });
  }

  // 冻结题目
  for (const item of result.items) {
    const stemRows = item.stemRows || [];
    delete item.stemRows;
    for (const { row, line } of stemRows) {
      const stem = get(row, "stem");
      const answerRaw = get(row, "answer");
      if (!stem && !answerRaw) continue;
      const options = parseOptionsCell(get(row, "options"));
      let type = (get(row, "type") || "").toLowerCase();
      const typeMap = {
        single: "single",
        单选: "single",
        multi: "multi",
        多选: "multi",
        tf: "tf",
        判断: "tf",
        判断题: "tf",
        match: "match",
        配伍: "match",
      };
      type = typeMap[type] || detectType(stem, answerRaw, options);
      const base = {
        item_id: item.id,
        subject: item.subject,
        chapter: item.chapter,
        type,
        stem: normalizeText(stem),
        options,
        answer: "",
        analysis: normalizeText(get(row, "analysis")),
        difficulty: parseDifficultyCell(get(row, "difficulty")) || item.difficulty || 1,
        order: ++questionOrder,
        line,
      };
      const validated = validateQuestion(base, { answer_raw: answerRaw, options }, { requireAnswer: true, strictAnswer: true });
      for (const iss of validated.issues) {
        addIssue(result, iss.severity, iss.message, {
          line,
          subject: item.subject,
          chapter: item.chapter,
          title: item.title,
          question: base.stem.slice(0, 30),
        });
      }
      if (!validated.ok) {
        result.stats.skippedLines++;
        continue;
      }
      base.answer = validated.answer;
      base.id = `q_${stableKey(item.id, base.stem, String(questionOrder))}`;
      // 题干内如带「（多选）」标记则使用标记结果
      const marker = detectType(stem, "", options);
      if (marker !== "single") base.type = marker;
      result.questions.push(base);
    }
    buildItemDerived(item);
  }

  finalizeResult(result);
  return result;
}

/** 解析选项单元格：支持 "A.甲|B.乙"、"甲|乙"（自带 A/B 前缀） */
export function parseOptionsCell(cell) {
  const v = normalizeText(cell);
  if (!v) return [];
  const parts = v.split(/[|｜\n]+/).map((s) => normalizeText(s)).filter(Boolean);
  const out = [];
  let autoCode = 65; // 'A'
  for (const p of parts) {
    const m = /^[(（]?\s*([A-Ha-h])\s*[.、)）．:：]\s*(.+)$/.exec(p);
    if (m) out.push({ key: m[1].toUpperCase(), text: normalizeText(m[2]) });
    else out.push({ key: String.fromCharCode(autoCode++), text: p });
  }
  return out;
}

/** 难度单元格：数字 1-3 / ★ 数量 */
export function parseDifficultyCell(v) {
  const t = normalizeText(v);
  if (!t) return 0;
  const stars = (t.match(/[★⭐]/g) || []).length;
  if (stars) return Math.min(3, Math.max(1, stars));
  const n = Number((t.match(/[1-3]/) || [])[0]);
  return n >= 1 && n <= 3 ? n : 0;
}

/* ------------------------------ CSV ------------------------------ */

/** 解析 CSV 文本（支持引号、逗号/制表符自动识别） */
export function parseCsvText(text, options = {}) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const firstLine = raw.split(/\r?\n/)[0] || "";
  const delimiter = options.delimiter || (firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  const cleaned = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  return parseTableRows(cleaned, { ...options, kind: "csv" });
}

/* ------------------------------ Excel ------------------------------ */

/** 解析 xlsx（依赖 SheetJS；未加载时给出可操作的提示） */
export async function parseXlsxFile(file, options = {}) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) {
    const r = createResult({ kind: "xlsx", name: file?.name || "Excel 文件", mode: "table" });
    addIssue(
      r,
      SEV.ERROR,
      "Excel 解析组件（SheetJS）未加载：请联网后重试，或先把表格另存为 CSV 再导入（CSV 无需依赖）。",
      { line: 1 }
    );
    finalizeResult(r);
    return r;
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = options.sheet || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  return parseTableRows(rows, { ...options, kind: "xlsx", name: `${file.name} · ${sheetName}` });
}

/* ------------------------------ JSON ------------------------------ */

/**
 * 解析 JSON：支持三种形态
 *  1) 备份文件：{ data: { learn_items: [...], questions: [...] } }
 *  2) 知识点数组：[{ subject, chapter, title, content, key_points, questions: [...] }]
 *  3) 扁平记录数组：[{ 科目, 章节, 知识点, 题目, 答案, ... }]（走表格解析）
 */
export function parseJsonText(text, options = {}) {
  const result = createResult({ kind: "json", name: options.name || "JSON 文件", mode: "json" });
  let data;
  try {
    data = JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
  } catch (err) {
    addIssue(result, SEV.ERROR, `JSON 解析失败：${err.message}`, { line: 1 });
    finalizeResult(result);
    return result;
  }

  // 形态 1：应用备份
  if (data && data.data && (data.data.learn_items || data.data.questions)) {
    const items = Array.isArray(data.data.learn_items) ? data.data.learn_items : [];
    const questions = Array.isArray(data.data.questions) ? data.data.questions : [];
    for (const it of items) {
      const item = {
        ...it,
        id: it.id || `li_${stableKey(it.subject, it.chapter, it.title)}`,
        key_points: Array.isArray(it.key_points) ? it.key_points : splitText(it.key_points),
        common_mistakes: Array.isArray(it.common_mistakes) ? it.common_mistakes : splitText(it.common_mistakes),
        tags: Array.isArray(it.tags) ? it.tags : splitText(it.tags),
        related_ids: Array.isArray(it.related_ids) ? it.related_ids : [],
        difficulty: Number(it.difficulty) || 1,
        content: it.content || "",
      };
      buildItemDerived(item);
      result.items.push(item);
    }
    for (const q of questions) {
      const item = {
        ...q,
        options: Array.isArray(q.options) ? q.options : parseOptionsCell(q.options),
        answer: normalizeAnswerRaw(q.answer),
        stem: normalizeText(q.stem),
        type: q.type || "single",
        id: q.id || `q_${stableKey(q.item_id, q.stem || "", String(result.questions.length))}`,
      };
      if (!item.stem) {
        addIssue(result, SEV.ERROR, "题目缺少题干（stem），已跳过。", { line: 1 });
        continue;
      }
      if (!item.answer) {
        addIssue(result, SEV.ERROR, `题目「${item.stem.slice(0, 20)}」缺少答案，已跳过。`, { line: 1 });
        continue;
      }
      result.questions.push(item);
    }
    addIssue(result, SEV.INFO, "识别为应用备份文件（含 learn_items / questions）。", { line: 1 });
    finalizeResult(result);
    return result;
  }

  // 形态 2 / 3：数组
  const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : null;
  if (!list) {
    addIssue(result, SEV.ERROR, "JSON 结构无法识别：需要数组，或应用备份文件（含 data.learn_items）。", { line: 1 });
    finalizeResult(result);
    return result;
  }
  if (!list.length) {
    addIssue(result, SEV.ERROR, "JSON 数组为空。", { line: 1 });
    finalizeResult(result);
    return result;
  }

  const looksNested = list.some((x) => x && typeof x === "object" && ("questions" in x || "key_points" in x || "content" in x));
  if (looksNested) {
    for (const [i, raw] of list.entries()) {
      const subject = normalizeText(raw.subject || raw["科目"] || "未分类");
      const chapter = normalizeText(raw.chapter || raw["章节"] || "未分章");
      const title = normalizeText(raw.title || raw["知识点"] || raw["标题"] || "");
      if (!title) {
        addIssue(result, SEV.ERROR, `第 ${i + 1} 条记录缺少 title（知识点名称），已跳过。`, { line: i + 1 });
        continue;
      }
      const item = {
        id: raw.id || `li_${stableKey(subject, chapter, title)}`,
        subject,
        chapter,
        title,
        content: normalizeText(raw.content || raw["正文"] || ""),
        key_points: toList(raw.key_points || raw["要点"]),
        common_mistakes: toList(raw.common_mistakes || raw["易错点"]),
        tags: toList(raw.tags || raw["标签"]),
        related_titles: toList(raw.related || raw["关联"]),
        related_ids: [],
        difficulty: Number(raw.difficulty) || parseDifficultyCell(raw["难度"]) || 1,
        order: i + 1,
        line: i + 1,
      };
      buildItemDerived(item);
      result.items.push(item);
      const qs = Array.isArray(raw.questions) ? raw.questions : [];
      for (const [j, q] of qs.entries()) {
        const options = Array.isArray(q.options) ? q.options : parseOptionsCell(q.options);
        const type = q.type || detectType(q.stem || "", q.answer || "", options);
        const base = {
          item_id: item.id,
          subject,
          chapter,
          type,
          stem: normalizeText(q.stem),
          options,
          answer: "",
          analysis: normalizeText(q.analysis || ""),
          difficulty: Number(q.difficulty) || item.difficulty,
          order: j + 1,
          line: i + 1,
        };
        const validated = validateQuestion(base, { answer_raw: q.answer || "", options }, { requireAnswer: true, strictAnswer: true });
        for (const iss of validated.issues) {
          addIssue(result, iss.severity, iss.message, { line: i + 1, subject, chapter, title });
        }
        if (!validated.ok) continue;
        base.answer = validated.answer;
        base.id = q.id || `q_${stableKey(item.id, base.stem, String(j + 1))}`;
        result.questions.push(base);
      }
    }
  } else {
    // 扁平记录 → 转成表格解析
    const headers = uniq(list.flatMap((r) => Object.keys(r || {})));
    const rows = [headers, ...list.map((r) => headers.map((h) => (r[h] === undefined || r[h] === null ? "" : String(r[h]))))];
    const tableResult = parseTableRows(rows, { name: options.name, kind: "json", mapping: options.mapping });
    return tableResult;
  }

  finalizeResult(result);
  return result;
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => normalizeText(x)).filter(Boolean);
  return splitText(v);
}

function splitText(v) {
  return normalizeText(v)
    .split(/[|｜\n;；]+/)
    .map((s) => normalizeText(s))
    .filter(Boolean);
}

/** 兼容格式入口：按文件扩展名分派（异步：xlsx 需要读 ArrayBuffer） */
export async function parseCompatFile(file, options = {}) {
  const name = file.name || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    const text = await file.text();
    return parseCsvText(text, { ...options, name });
  }
  if (ext === "json") {
    const text = await file.text();
    return parseJsonText(text, { ...options, name });
  }
  if (ext === "xlsx" || ext === "xls") {
    return parseXlsxFile(file, options);
  }
  const r = createResult({ kind: ext || "unknown", name, mode: "table" });
  addIssue(r, SEV.ERROR, `不支持的文件类型「.${ext}」。支持：.md（主格式）、.csv、.xlsx、.json。`, { line: 1 });
  finalizeResult(r);
  return r;
}

/**
 * 导入管线：文件 → 解析 → 校验 → 预览 → 写库 → 报告
 * 提示词 3.4 / 4.5：导入前实时解析预览、校验、导入结果报告（成功数 / 失败明细及原因）。
 * @module import/pipeline
 */

import { STORES, bulkPut, getAll, saveImportMeta, listImports } from "../core/db.js";
import { emit, EV } from "../core/events.js";
import { normalizeText, truncate, todayKey } from "../core/util.js";
import { parseMarkdown, parseFiles } from "./markdown.js";
import { parseCompatFile } from "./table.js";
import { mergeResults, issuesBySeverity, SEV, createResult, addIssue, finalizeResult } from "./parse-result.js";
import { probeStructure, profileLabel } from "./structure.js";

/** 文件扩展名 → 解析器类型 */
export function fileKind(name) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (ext === "json") return "json";
  return "unknown";
}

/**
 * 解析（不写库）：支持多文件批量导入
 * @param {File[]} files
 * @param {{relaxStructure?:boolean, profile?:string, mode?:'strict'|'relaxed'}} [options]
 * @returns {Promise<{merged:object, results:object[], probes:object[]}>}
 */
export async function analyzeFiles(files, options = {}) {
  const results = [];
  const probes = [];
  const relax = options.mode === "relaxed" || options.relaxStructure === true;

  for (const file of files) {
    const kind = fileKind(file.name);
    if (kind === "markdown") {
      const text = await file.text();
      const probe = probeStructure(text, { name: file.name });
      probes.push({ name: file.name, ...probe });
      results.push(
        parseMarkdown(text, {
          name: file.name,
          profile: options.profile && options.profile !== "auto" ? options.profile : probe.profile,
          relaxStructure: relax,
        })
      );
    } else {
      const r = await parseCompatFile(file, { mapping: options.mapping, name: file.name });
      probes.push({ name: file.name, kind, profile: "table", notes: [], levels: {}, headings: [] });
      results.push(r);
    }
  }

  const merged = results.length === 1 ? results[0] : mergeResults(results);
  merged.results = results;
  merged.probes = probes;
  resolveRelated(merged);
  await markDuplicates(merged);
  return { merged, results, probes };
}

/** 把「关联：」中的知识点名称解析为 id（同名知识点） */
export function resolveRelated(merged) {
  const byTitle = new Map();
  for (const it of merged.items) {
    if (!byTitle.has(it.title)) byTitle.set(it.title, it.id);
  }
  let resolved = 0;
  let missing = 0;
  for (const it of merged.items) {
    it.related_ids = [];
    for (const t of it.related_titles || []) {
      const id = byTitle.get(t);
      if (id && id !== it.id) {
        it.related_ids.push(id);
        resolved++;
      } else {
        missing++;
        if (missing <= 20) {
          addIssue(merged, SEV.INFO, `知识点「${truncate(it.title, 20)}」的「关联：${t}」在本次内容中找不到同名知识点，已忽略。`, {
            line: it.line,
            title: it.title,
          });
        }
      }
    }
    it.related_ids = Array.from(new Set(it.related_ids));
  }
  merged.stats.relatedResolved = resolved;
  merged.stats.relatedMissing = missing;
  return merged;
}

/** 标记与库中已存在内容重复的条目（增量导入不重复建点/建卡） */
export async function markDuplicates(merged) {
  const existing = await getAll(STORES.learn_items);
  const ids = new Set(existing.map((i) => i.id));
  let dup = 0;
  for (const it of merged.items) {
    if (ids.has(it.id)) {
      it.duplicate = true;
      dup++;
    }
  }
  const existingQ = await getAll(STORES.questions);
  const qids = new Set(existingQ.map((q) => q.id));
  let qdup = 0;
  for (const q of merged.questions) {
    if (qids.has(q.id)) {
      q.duplicate = true;
      qdup++;
    }
  }
  merged.stats.duplicateItems = dup;
  merged.stats.duplicateQuestions = qdup;
  merged.stats.existingItems = ids.size;
  return merged;
}

/**
 * 写库
 * @param {object} merged analyzeFiles 的结果
 * @param {{sourceNames?:string[], skipErrors?:boolean}} [opts]
 */
export async function commitImport(merged, opts = {}) {
  const started = Date.now();
  const importId = `imp_${started.toString(36)}`;
  const dateKey = todayKey();
  const sourceNames = opts.sourceNames
    ? [opts.sourceNames].flat()
    : merged.source?.name
      ? [merged.source.name]
      : [];

  // 跳过问题项导入：把解析阶段判为「知识点名缺失」等无法修复的条目剔除
  // （Markdown 解析器已在冻结阶段跳过非法题目，这里只处理连 id 都无法建立的条目）
  const skipped = [];
  const validItems = [];
  for (const it of merged.items) {
    if (!it.title || !String(it.title).trim()) {
      skipped.push({ reason: "知识点名称为空", line: it.line, title: "" });
      continue;
    }
    validItems.push(it);
  }
  const validIds = new Set(validItems.map((i) => i.id));
  const validQuestions = merged.questions.filter((q) => validIds.has(q.item_id));

  const items = validItems.map((it) => ({ ...it, import_id: importId, imported_at: started }));
  const questions = validQuestions.map((q) => ({ ...q, import_id: importId, imported_at: started }));

  await bulkPut(STORES.learn_items, items);
  await bulkPut(STORES.questions, questions);

  const meta = await saveImportMeta({
    id: importId,
    date_key: dateKey,
    files: sourceNames,
    mode: merged.source?.mode || "strict",
    items: items.length,
    questions: questions.length,
    skipped: skipped.length,
    duplicate_items: merged.stats.duplicateItems || 0,
    errors: merged.stats.errors || 0,
    warnings: merged.stats.warnings || 0,
    duration_ms: Date.now() - started,
    subjects: merged.outline.map((o) => o.subject),
  });

  emit(EV.IMPORT_DONE, { importId, items: items.length, questions: questions.length });
  emit(EV.DATA_CHANGED, { reason: "import" });

  // 导入后同步基础卡片（每个知识点一张；内容更新时保留用户备注与书签）
  let cards = { created: 0, total: items.length };
  try {
    const { syncBaseCards } = await import("../core/cards.js");
    cards = await syncBaseCards(items);
  } catch (err) {
    console.warn("[import] 基础卡片同步失败", err);
  }

  return {
    importId: meta.id,
    items: items.length,
    questions: questions.length,
    skipped,
    cardsCreated: cards.created,
    durationMs: Date.now() - started,
    subjects: meta.subjects,
  };
}

/** 导入报告（供 UI 渲染） */
export function buildReport(merged, commitResult) {
  const groups = issuesBySeverity(merged);
  return {
    stats: merged.stats,
    outline: merged.outline,
    errors: groups.errors,
    warnings: groups.warnings,
    infos: groups.infos,
    commit: commitResult || null,
    mode: merged.source?.mode || "strict",
    modeLabel: profileLabel(merged.source?.mode),
  };
}

/** 最近导入记录（设置页/导入页展示） */
export async function recentImports(limit = 5) {
  const list = await listImports();
  return list.slice(0, limit);
}

/** 模板下载（Markdown / CSV / JSON） */
export async function fetchTemplate(kind = "md") {
  const path = {
    md: "../templates/内容导入模板.md",
    csv: "../templates/内容导入模板.csv",
    json: "../templates/内容导入模板.json",
  }[kind];
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`模板下载失败（${res.status}）`);
  return res.text();
}

/** 触发浏览器下载 */
export function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 预览摘要（导入向导第 3 步展示） */
export function previewSummary(merged) {
  const subjects = merged.outline.map((o) => ({
    subject: o.subject,
    chapters: o.chapters.length,
    items: o.chapters.reduce((n, c) => n + c.titles.length, 0),
  }));
  return {
    subjects,
    itemCount: merged.items.length,
    questionCount: merged.questions.length,
    keyPoints: merged.stats.keyPoints || 0,
    mistakes: merged.stats.mistakes || 0,
    duplicateItems: merged.stats.duplicateItems || 0,
    duplicateQuestions: merged.stats.duplicateQuestions || 0,
    errors: merged.stats.errors || 0,
    warnings: merged.stats.warnings || 0,
    typeCounts: countBy(merged.questions, (q) => q.type),
    difficultyCounts: countBy(merged.items, (i) => String(i.difficulty || 1)),
  };
}

function countBy(list, fn) {
  const map = {};
  for (const x of list) {
    const k = fn(x);
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

/** 把解析结果渲染成结构树（预览用，最多 N 条） */
export function outlineTree(merged, limit = 400) {
  const out = [];
  let n = 0;
  for (const o of merged.outline) {
    out.push({ kind: "subject", text: o.subject });
    for (const c of o.chapters) {
      out.push({ kind: "chapter", text: c.chapter });
      for (const t of c.titles) {
        if (n++ >= limit) return out;
        out.push({ kind: "item", text: t });
      }
    }
  }
  return out;
}

export { SEV, normalizeText, createResult, addIssue, finalizeResult };

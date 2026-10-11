/**
 * 解析结果结构定义与工具
 * 所有格式（Markdown / CSV / Excel / JSON）的解析器都产出同一结构，
 * 供导入预览、校验报告、写库共用（提示词 4.5 统一校验规则）。
 * @module import/parse-result
 */

import { normalizeText, stripInlineMd, uniq } from "../core/util.js";

/** 问题等级 */
export const SEV = {
  ERROR: "error", // 阻断：该条不入库
  WARN: "warn", // 提醒：入库但需人工确认
  INFO: "info", // 说明：结构/兼容性提示
};

/** 新建一个空的解析结果 */
export function createResult(source = {}) {
  return {
    source: {
      kind: "markdown", // markdown | csv | xlsx | json
      name: source.name || "",
      size: source.size || 0,
      mode: source.mode || "strict",
      ...source,
    },
    items: [],
    questions: [],
    issues: [],
    outline: [], // [{ subject, chapters: [{ chapter, titles: [] }] }]
    stats: {
      files: 1,
      subjects: 0,
      chapters: 0,
      items: 0,
      questions: 0,
      keyPoints: 0,
      mistakes: 0,
      skippedLines: 0,
      ignoredSections: 0,
      errors: 0,
      warnings: 0,
    },
  };
}

/**
 * 记录一条问题
 * @param {object} result
 * @param {string} severity
 * @param {string} message
 * @param {{file?:string,line?:number,subject?:string,chapter?:string,title?:string,question?:string}} [loc]
 */
export function addIssue(result, severity, message, loc = {}) {
  result.issues.push({ severity, message, file: loc.file ?? result.source.name, ...loc });
  if (severity === SEV.ERROR) result.stats.errors++;
  if (severity === SEV.WARN) result.stats.warnings++;
  return result;
}

/** 合并多个解析结果（多文件批量导入） */
export function mergeResults(results) {
  const merged = createResult({ name: results.map((r) => r.source.name).join("、"), mode: results[0]?.source.mode || "strict" });
  merged.stats.files = results.length;
  const outlineMap = new Map();
  for (const r of results) {
    merged.items.push(...r.items);
    merged.questions.push(...r.questions);
    merged.issues.push(...r.issues);
    merged.stats.subjects = Math.max(merged.stats.subjects, 0);
    merged.stats.keyPoints += r.stats.keyPoints;
    merged.stats.mistakes += r.stats.mistakes;
    merged.stats.skippedLines += r.stats.skippedLines;
    merged.stats.ignoredSections += r.stats.ignoredSections;
    merged.stats.errors += r.stats.errors;
    merged.stats.warnings += r.stats.warnings;
    for (const o of r.outline) {
      if (!outlineMap.has(o.subject)) {
        const entry = { subject: o.subject, chapters: [] };
        outlineMap.set(o.subject, entry);
        merged.outline.push(entry);
      }
      const entry = outlineMap.get(o.subject);
      for (const c of o.chapters) {
        const found = entry.chapters.find((x) => x.chapter === c.chapter);
        if (found) found.titles.push(...c.titles);
        else entry.chapters.push({ chapter: c.chapter, titles: [...c.titles] });
      }
    }
  }
  merged.stats.items = merged.items.length;
  merged.stats.questions = merged.questions.length;
  merged.stats.subjects = merged.outline.length;
  merged.stats.chapters = merged.outline.reduce((n, o) => n + o.chapters.length, 0);
  return merged;
}

/** 汇总知识点/题目的衍生信息（搜索文本、摘要） */
export function buildItemDerived(item) {
  const keyPoints = item.key_points || [];
  const mistakes = item.common_mistakes || [];
  item.key_points = keyPoints.map((k) => normalizeText(k)).filter(Boolean);
  item.common_mistakes = mistakes.map((k) => normalizeText(k)).filter(Boolean);
  item.tags = uniq((item.tags || []).map((t) => normalizeText(t)).filter(Boolean));
  const plain = stripInlineMd(item.content || "");
  item.search_text = normalizeText(
    [item.subject, item.chapter, item.title, plain, item.key_points.join(" "), item.common_mistakes.join(" "), item.tags.join(" ")].join(" ")
  ).toLowerCase();
  item.summary = plain.slice(0, 160);
  item.char_count = plain.length;
  return item;
}

/** 结果统计校正（items/questions 以实际数组长度为准） */
export function finalizeResult(result) {
  result.stats.items = result.items.length;
  result.stats.questions = result.questions.length;
  result.stats.subjects = uniq(result.items.map((i) => i.subject)).length;
  result.stats.chapters = uniq(result.items.map((i) => `${i.subject}\u0001${i.chapter}`)).length;
  result.stats.keyPoints = result.items.reduce((n, i) => n + (i.key_points?.length || 0), 0);
  result.stats.mistakes = result.items.reduce((n, i) => n + (i.common_mistakes?.length || 0), 0);
  result.stats.errors = result.issues.filter((i) => i.severity === SEV.ERROR).length;
  result.stats.warnings = result.issues.filter((i) => i.severity === SEV.WARN).length;
  return result;
}

/** 便于 UI 展示：按等级分组的问题清单 */
export function issuesBySeverity(result) {
  return {
    errors: result.issues.filter((i) => i.severity === SEV.ERROR),
    warnings: result.issues.filter((i) => i.severity === SEV.WARN),
    infos: result.issues.filter((i) => i.severity === SEV.INFO),
  };
}

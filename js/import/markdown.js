/**
 * Markdown 内容解析器（提示词 4.1《Markdown 内容规范》的严格实现）
 *
 * 解析规则（固定）：
 *   # 标题   → subject  科目
 *   ## 标题  → chapter  章节
 *   ### 标题 → title    知识点（出现即开启新知识点）
 *   标题下正文段落        → content
 *   难度：/标签：/关联：  → difficulty / tags / related
 *   要点：/易错点：/题目： → key_points / common_mistakes / questions
 *
 * 题目书写规范（4.1.3）：
 *   「1. 题干」→ stem；「   A. 选项」→ options；「答案：」→ answer；「解析：」→ analysis
 *   题干含（多选）→ multi；含（判断）→ tf；含（配伍）→ match；默认 single
 *
 * 容错（4.1.4）：front-matter 忽略；孤立文本提示「将被忽略」；空知识点警告；
 *   题目缺答案/答案非法 → 报错并给出知识点与行号（可跳过问题项导入）。
 *
 * @module import/markdown
 */

import {
  normalizeText,
  stripInlineMd,
  stableKey,
  truncate,
  uniq,
  hashStr,
} from "../core/util.js";
import {
  createResult,
  addIssue,
  buildItemDerived,
  finalizeResult,
  SEV,
} from "./parse-result.js";
import { probeStructure, isPageHeading, isDecorationHeading, profileLabel } from "./structure.js";

/* ------------------------------ 常量与正则 ------------------------------ */

/** 区块标题：要点 / 易错点 / 题目（支持 **加粗**、粗体、列表项形式、中英文冒号） */
const RE_BLOCK = /^(?:[-*+]\s*)?(?:\*\*|__)?\s*(要点|易错点|易错|题目|考点|重点)\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*|__)?\s*$/;

/** 元信息行：难度：2 / 标签：a,b / 关联：xx（键可中英文冒号） */
const RE_META = /^(?:[-*+]\s*)?(?:\*\*|__)?\s*(难度|星级|标签|关联|考频|备注)\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/;

/** 题号行：1. / 1、/ 1) / 1） */
const RE_QNUM = /^(\d{1,3})\s*[.、)）]\s*(.*)$/;

/** 选项行：A. / A、/ A) / （A） / A． */
const RE_OPTION = /^\s*[(（]?\s*([A-Ha-h])\s*[.、)）．:：]\s*(.+)$/;

/** 答案行（允许加粗、全角冒号、前导列表符号） */
const RE_ANSWER = /^(?:\*\*|__)?\s*答案\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/;

/** 解析行 */
const RE_ANALYSIS = /^(?:\*\*|__)?\s*(?:解析|分析|答案解析)\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/;

/** 题干中的题型标记 */
const RE_TYPE_MULTI = /[（(]\s*(?:多选|多选题|多项选择|不定项)\s*[)）]/;
const RE_TYPE_TF = /[（(]\s*(?:判断|判断题|是非题)\s*[)）]/;
const RE_TYPE_MATCH = /[（(]\s*(?:配伍|配伍题|匹配|连线)\s*[)）]/;

const DEFAULT_OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 解析单个 Markdown 文件
 * @param {string} text 文件内容
 * @param {{
 *   name?: string,
 *   profile?: 'auto'|'standard'|'h3-items'|'h2-items',
 *   relaxStructure?: boolean,   // 宽松解析：把加粗行 / 顶层列表项提升为知识点（默认关闭）
 *   promoteBold?: boolean,      // 宽松解析下是否允许「加粗行 → 知识点」（默认允许）
 *   promoteList?: boolean,      // 宽松解析下是否允许「顶层列表项 → 知识点」（默认允许）
 *   requireAnswer?: boolean,    // 缺答案是否判为错误（默认 true）
 *   strictAnswer?: boolean,     // 答案必须存在于选项中（默认 true）
 *   skipInvalid?: boolean,      // 跳过问题项导入（默认 true，仅记录错误）
 *   maxIssues?: number,         // 问题清单上限，防止超大文件刷屏
 * }} [options]
 */
export function parseMarkdown(text, options = {}) {
  const opts = {
    profile: "auto",
    relaxStructure: false,
    requireAnswer: true,
    strictAnswer: true,
    skipInvalid: true,
    maxIssues: 400,
    ...options,
  };
  const name = opts.name || "未命名.md";
  const probe = probeStructure(text, { name });
  const profile = opts.profile && opts.profile !== "auto" ? opts.profile : probe.profile;

  const result = createResult({ kind: "markdown", name, mode: profile, chars: String(text || "").length });
  result.probe = probe;

  const rawLines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const lines = maskIgnoredLines(rawLines, probe.frontMatterEnd, result);

  if (profile === "flat") {
    addIssue(result, SEV.ERROR, "未识别到任何标题层级（# / ## / ###），无法生成知识点。请参照《Markdown 内容规范》为内容补全标题层级。", { line: 1 });
    finalizeResult(result);
    return result;
  }

  const engine = new ParserEngine({ result, profile, opts, name, lines, probe });
  engine.run();
  finalizeResult(result);
  return result;
}

/** 解析多个文件并合并（多文件批量导入） */
export function parseMarkdownFiles(files, options = {}) {
  return files.map((f) => parseMarkdown(f.text, { ...options, name: f.name }));
}

/** 批量解析 → 合并为一个结果（含每文件明细） */
export function parseFiles(files, options = {}) {
  const results = parseMarkdownFiles(files, options);
  return { results, merged: mergeResults(results) };
}

/* ------------------------------ 预处理 ------------------------------ */

/** 计算行首缩进（制表符按 2 空格计） */
function countIndent(line) {
  const m = /^([ \t]*)/.exec(String(line));
  return m[1].replace(/\t/g, "  ").length;
}

/**
 * 屏蔽需要忽略的行：YAML front-matter、代码块围栏内的内容
 * 返回与原文等长的行数组，被忽略的行置为 null（保持行号一一对应）
 */
function maskIgnoredLines(rawLines, frontMatterEnd, result) {
  const out = new Array(rawLines.length).fill(null);
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const t = raw.trim();
    if (frontMatterEnd >= 0 && i <= frontMatterEnd) {
      out[i] = null;
      continue;
    }
    const fence = /^(```|~~~)/.exec(t);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (t.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      out[i] = null;
      result.stats.skippedLines++;
      continue;
    }
    if (inFence) {
      out[i] = null;
      result.stats.skippedLines++;
      continue;
    }
    out[i] = raw;
  }
  if (frontMatterEnd >= 0) {
    addIssue(result, SEV.INFO, `已忽略文件头部 YAML front-matter（第 1–${frontMatterEnd + 1} 行）。`, { line: 1 });
  }
  return out;
}

/* ------------------------------ 解析引擎 ------------------------------ */

class ParserEngine {
  constructor({ result, profile, opts, name, lines, probe }) {
    this.result = result;
    this.profile = profile;
    this.opts = opts;
    this.name = name;
    this.lines = lines; // string | null
    this.probe = probe;

    this.subject = "";
    this.chapter = "";
    this.subjectOrder = 0;
    this.chapterOrder = 0;
    this.itemOrder = 0;
    this.questionOrder = 0;

    this.currentItem = null;
    this.currentBody = []; // 正文行缓冲
    this.orphanLines = []; // 未归属任何知识点的正文
    this.orphanStart = 0;

    this.block = null; // null | 'key_points' | 'common_mistakes' | 'questions'
    this.scopeBlocks = null; // 在知识点出现前遇到的区块（挂到随后出现的知识点）

    this.outlineMap = new Map();
    this.itemTitles = new Map(); // 标题 → 首个知识点 id（用于「关联：」解析）
    // 宽松解析（relaxStructure）：仅在用户于导入预览中显式开启时生效，
    // 用于「标题缺失、靠加粗标题 / 顶层列表项分隔」的内容文件（如 PDF/导图转录稿）。
    const relax = !!opts.relaxStructure;
    this.listPromote = relax && opts.promoteList !== false;
    this.promoteBold = relax && opts.promoteBold !== false && !["standard", "h3-items"].includes(profile);
    this.pendingList = null; // 提升为知识点的列表项缓冲
    this.cursor = -1; // 当前行下标（供向后探测使用）
    this.idCounts = new Map(); // 稳定 id → 出现次数（处理同章节同名标题）
    this.duplicateTitles = []; // 同名标题记录（导入报告展示）
    this.baseIndent = -1; // 当前内容块的基准缩进（相对缩进也能识别顶层列表）
    this.chapterLines = []; // 宽松解析兜底：章节下未归入知识点的正文
    this.chapterStart = 0;
    this.chapterFallback =
      relax && ["h2-chapters", "h2-pages", "h1-items"].includes(profile); // 是否启用章节兜底
    // 一级标题条目化：仅当文件开启宽松解析且本身存在「标准科目名」时启用
    // （如「# 生理学」下面又用「# 肝硬化 ★★★（0~1题）」列条目的导图转录稿）
    this.h1AsItem = relax;
  }

  run() {
    this.reportProfile();
    for (let i = 0; i < this.lines.length; i++) {
      this.cursor = i;
      const raw = this.lines[i];
      if (raw === null) continue;
      const line = raw.replace(/\s+$/, "");
      const t = line.trim();
      const lineNo = i + 1;

      if (!t) {
        this.flushParagraph();
        this.baseIndent = -1;
        continue;
      }
      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        this.flushParagraph();
        this.baseIndent = -1;
        continue;
      }
      // 标题
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
      if (h) {
        this.handleHeading(h[1].length, normalizeText(h[2]), lineNo);
        continue;
      }
      // 区块标题
      const b = RE_BLOCK.exec(t);
      if (b) {
        this.flushParagraph();
        this.handleBlockTitle(b[1], lineNo);
        continue;
      }
      // 元信息行（仅知识点内部有效）
      if (this.currentItem && !this.block) {
        const m = RE_META.exec(t);
        if (m) {
          this.applyMeta(m[1], m[2], lineNo);
          continue;
        }
      }
      // 题目区块内的行
      if (this.block === "questions") {
        this.handleQuestionLine(line, lineNo);
        continue;
      }
      // 要点 / 易错点区块内的行
      if (this.block === "key_points" || this.block === "common_mistakes") {
        if (this.handleListLine(t, lineNo)) continue;
        // 列表结束：回到正文
        this.block = null;
      }
      // 其余作为正文（含列表 / 表格 / 引用 / 加粗小标题）
      this.absorbBody(line, lineNo);
    }
    this.flushPendingList();
    this.flushChapterItem();
    this.finishItem();
    this.flushOrphans();
    this.rebuildOutline();
  }

  /* ---------- 提示 ---------- */
  reportProfile() {
    const { result, probe } = this;
    addIssue(result, SEV.INFO, `结构识别：${profileLabel(this.profile)}。`, { line: 1 });
    for (const n of probe.notes) addIssue(result, SEV.INFO, n, { line: 1 });
    if (this.profile === "flat") {
      addIssue(result, SEV.ERROR, "无法识别标题层级，请检查文件是否为 Markdown 格式。", { line: 1 });
    }
  }

  issue(sev, msg, lineNo, extra = {}) {
    if (this.result.issues.length >= this.opts.maxIssues) return;
    addIssue(this.result, sev, msg, {
      line: lineNo,
      subject: this.subject || undefined,
      chapter: this.chapter || undefined,
      title: this.currentItem?.title,
      ...extra,
    });
  }

  /* ---------- 标题 ---------- */
  handleHeading(level, text, lineNo) {
    const pageLike = isPageHeading(text);
    const decoration = isDecorationHeading(text);

    if (pageLike) {
      // 页码标题：仅作为分节提示，不生成科目/章节
      this.result.stats.ignoredSections++;
      return;
    }
    if (decoration && level <= 2) {
      this.result.stats.ignoredSections++;
      return;
    }

    if (level === 1) {
      if (this.probe.docTitle && text === this.probe.docTitle && !this.subject) {
        addIssue(this.result, SEV.INFO, `跳过文档标题「${truncate(text, 24)}」，其后的一级标题作为科目。`, { line: lineNo });
        return;
      }
      // 宽松解析：一级标题更像「知识点条目」（如「肝硬化 ★★★（0~1题）」）时，
      // 不再当作新科目，而是挂到当前科目下作为知识点，避免生成一堆伪科目。
      if (this.h1AsItem && this.looksLikeItemHeading(text) && this.subject) {
        this.result.stats.h1AsItems = (this.result.stats.h1AsItems || 0) + 1;
        this.chapter = this.defaultChapter(); // 进入新的知识点序列，章节回落
        this.chapterOrder = 0;
        this.flushPendingList();
        this.flushChapterItem();
        this.startItem(text.replace(/[★☆]+\s*[（(][^）)]*[）)]?\s*$/, "").trim() || text, lineNo, {
          promoted_from: "h1",
        });
        return;
      }
      this.flushPendingList();
      this.flushChapterItem();
      this.finishItem();
      this.flushOrphans();
      this.subject = text;
      this.chapter = this.defaultChapter();
      this.subjectOrder++;
      this.chapterOrder = 0;
      this.block = null;
      this.ensureOutline();
      return;
    }

    if (this.profile === "h2-items") {
      // 二级标题直接作为知识点
      if (level === 2) {
        if (!this.subject) {
          this.subject = "未分类";
          this.subjectOrder++;
          this.ensureOutline();
          this.issue(SEV.WARN, `知识点「${truncate(text, 24)}」出现在任何一级标题（科目）之前，已归入「未分类」。`, lineNo);
        }
        this.startItem(text, lineNo);
        return;
      }
      // 更深层级在 h2-items 档案下并入正文
      if (level >= 3) {
        this.absorbBody(`${"#".repeat(Math.max(0, level - 2))} ${text}`, lineNo, { structural: true });
        return;
      }
      return;
    }

    if (level === 2) {
      this.flushPendingList();
      this.flushChapterItem();
      this.finishItem();
      this.flushOrphans();
      this.chapter = text;
      this.chapterOrder++;
      this.block = null;
      if (!this.subject) {
        this.subject = "未分类";
        this.subjectOrder++;
        this.issue(SEV.WARN, `章节「${truncate(text, 24)}」出现在任何一级标题（科目）之前，已归入「未分类」。`, lineNo);
      }
      this.ensureOutline();
      return;
    }

    if (level === 3) {
      if (!this.subject) {
        this.subject = "未分类";
        this.subjectOrder++;
        this.issue(SEV.WARN, `知识点「${truncate(text, 24)}」出现在任何科目之前，已归入「未分类」。`, lineNo);
        this.ensureOutline();
      }
      if (!this.chapter) this.chapter = this.defaultChapter();
      this.flushPendingList();
      this.flushChapterItem();
      this.startItem(text, lineNo);
      return;
    }

    // 四级及更深：并入正文，保留层级信息
    this.absorbBody(`${"#".repeat(level - 2)} ${text}`, lineNo, { structural: true });
  }

  defaultChapter() {
    return "未分章";
  }

  /**
   * 判断一级标题是否更像「知识点条目」而不是科目名：
   *  - 含考频星标 ★ / ☆
   *  - 含题量括号（0~3题）
   *  - 含小结 / 续 等补充标记
   *  - 标题长度 ≥ 12 字（科目名通常较短）
   * 命中即视为条目，挂到当前科目下（绝不新增伪科目）。
   */
  looksLikeItemHeading(text) {
    const t = normalizeText(text);
    if (/[★☆]/.test(t)) return true;
    if (/[（(]\s*\d+\s*[~～\-–]\s*\d+\s*题?\s*[）)]/.test(t)) return true;
    if (/[（(][^）)]*小结[^）)]*[）)]/.test(t)) return true;
    if (/(续|小结)$/.test(t)) return true;
    if (t.length >= 14) return true;
    return false;
  }

  ensureOutline() {
    if (!this.subject) return;
    if (!this.outlineMap.has(this.subject)) {
      const entry = { subject: this.subject, chapters: [] };
      this.outlineMap.set(this.subject, entry);
      this.result.outline.push(entry);
    }
    const entry = this.outlineMap.get(this.subject);
    if (this.chapter && !entry.chapters.some((c) => c.chapter === this.chapter)) {
      entry.chapters.push({ chapter: this.chapter, titles: [] });
    }
  }

  rebuildOutline() {
    // 以实际入库的知识点为准，补全目录
    for (const item of this.result.items) {
      if (!this.outlineMap.has(item.subject)) {
        const entry = { subject: item.subject, chapters: [] };
        this.outlineMap.set(item.subject, entry);
        this.result.outline.push(entry);
      }
      const entry = this.outlineMap.get(item.subject);
      let ch = entry.chapters.find((c) => c.chapter === item.chapter);
      if (!ch) {
        ch = { chapter: item.chapter, titles: [] };
        entry.chapters.push(ch);
      }
      ch.titles.push(item.title);
    }
    // 同名标题统计（供导入报告提示）
    if (this.duplicateTitles.length) {
      this.result.stats.duplicateTitles = this.duplicateTitles.length;
      this.result.stats.duplicateTitleSamples = this.duplicateTitles.slice(0, 10);
    }
  }

  /* ---------- 知识点 ---------- */
  startItem(title, lineNo, extra = {}) {
    this.finishItem();
    this.flushOrphans();
    const cleanTitle = normalizeText(title).replace(/^【(示例|例)】/, "").trim() || normalizeText(title);
    // 稳定 id 由「科目 + 章节 + 标题」生成，保证重复导入同一文件时 id 不变（不重复建点、不重复建卡）。
    // 但内容文件里同一章节下可能出现同名标题（真实导图转录稿就有 17 处），
    // 这种情况必须保留全部内容：为后续同名的知识点追加出现序号，避免被 id 覆盖而丢失。
    const baseId = `li_${stableKey(this.subject, this.chapter, title)}`;
    const seen = this.idCounts.get(baseId) || 0;
    this.idCounts.set(baseId, seen + 1);
    const id = seen === 0 ? baseId : `${baseId}__${seen + 1}`;
    if (seen > 0) {
      this.duplicateTitles.push({ title, id, line: lineNo, subject: this.subject, chapter: this.chapter });
      this.issue(
        SEV.WARN,
        `同一章节下出现重复标题「${truncate(title, 24)}」（第 ${lineNo} 行）：已作为独立知识点保留（id 追加后缀 ${seen + 1}），内容不会丢失。`,
        lineNo,
        { title }
      );
    }
    const item = {
      id,
      subject: this.subject || "未分类",
      chapter: this.chapter || this.defaultChapter(),
      title,
      content: "",
      key_points: [],
      common_mistakes: [],
      related_titles: [],
      related_ids: [],
      tags: [],
      difficulty: 1,
      order: ++this.itemOrder,
      chapter_order: this.chapterOrder,
      subject_order: this.subjectOrder,
      line: lineNo,
      ...extra,
    };
    this.currentItem = item;
    this.currentBody = [];
    this.block = null;
    if (!this.itemTitles.has(title)) this.itemTitles.set(title, item.id);
    if (this.scopeBlocks) {
      // 知识点主体之前出现的区块（极少见）挂到该知识点
      for (const [k, v] of Object.entries(this.scopeBlocks)) item[k].push(...v);
      this.scopeBlocks = null;
    }
  }

  finishItem() {
    const item = this.currentItem;
    if (!item) return;
    this.flushParagraph();
    item.content = this.currentBody
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const hasBody = item.content.length > 0;
    const hasSections = item.key_points.length || item.common_mistakes.length;
    if (!hasBody && !hasSections) {
      this.issue(SEV.WARN, `知识点「${truncate(item.title, 24)}」没有正文内容（空知识点）。`, item.line, { title: item.title });
    }
    buildItemDerived(item);
    this.freezeQuestions(item); // 把「题目：」区块冻结为 questions 记录（含校验）
    this.result.items.push(item);
    this.currentItem = null;
    this.currentBody = [];
    this.block = null;
  }

  /* ---------- 正文 ---------- */
  absorbBody(line, lineNo, { structural = false } = {}) {
    const t = line.trim();
    const indent = countIndent(line);
    if (this.baseIndent < 0) this.baseIndent = indent;
    const relIndent = indent - this.baseIndent;

    // 延用中的列表提升：接续当前知识点
    if (this.pendingList) {
      const li = /^[-*+]\s+(.*)$/.exec(t);
      if (li && relIndent >= 0) {
        if (relIndent === 0) {
          this.startItem(normalizeText(li[1]), lineNo, { promoted_from: "list" });
        } else {
          this.currentBody.push(t);
        }
        return;
      }
      if (relIndent > 0 && !/^[-*+]\s/.test(t)) {
        this.currentBody.push(t); // 缩进续行：属于上一个知识点
        return;
      }
      this.pendingList = null;
    }

    // 加粗行提升为知识点（宽松解析：标题缺失但用加粗分隔的内容文件）
    if (this.promoteBold && !structural) {
      const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*(.*)$/.exec(t);
      if (bold && relIndent === 0 && !this.isContinuationOfBody()) {
        const label = normalizeText(bold[1]);
        const rest = normalizeText(bold[2]).replace(/^[:：]\s*/, "");
        const nested = this.boldFollowedByNestedList();
        if (label.length >= 2 && label.length <= 40 && !/^(要点|易错点|题目|答案|解析)$/.test(label)) {
          this.startItem(label, lineNo, { promoted_from: "bold" });
          if (rest) this.currentBody.push(rest);
          // 加粗标题后是同组「顶层项 + 缩进子项」的嵌套列表 → 视为该知识点的内容，折叠为正文
          if (nested) this.armPendingList(0, lineNo);
          return;
        }
      }
    }

    // 顶层列表项提升为知识点（宽松解析）
    if (this.listPromote && !structural) {
      const li = /^[-*+]\s+(.*)$/.exec(t);
      const group = this.peekListGroup();
      if (li && relIndent === 0 && !this.isContinuationOfBody() && this.shouldPromoteListGroup(group)) {
        this.startItem(normalizeText(li[1]), lineNo, { promoted_from: "list" });
        this.armPendingList(0, lineNo);
        return;
      }
    }

    if (!this.currentItem) {
      if (this.chapterFallback && this.subject && !this.pendingList) {
        if (!this.chapterLines.length) this.chapterStart = lineNo;
        this.chapterLines.push(t);
        return;
      }
      if (!this.orphanStart) this.orphanStart = lineNo;
      this.orphanLines.push(t);
      return;
    }
    this.currentBody.push(t);
  }

  /** 标记「当前处于列表提升模式」 */
  armPendingList(indent, lineNo) {
    this.pendingList = { indent, startLine: lineNo };
  }

  /** 结束列表提升模式 */
  flushPendingList() {
    this.pendingList = null;
  }

  /** 向后看：是否还有同缩进的列表项（用于判定「列表即知识点」） */
  countSiblingListItems(relIndent) {
    const base = this.baseIndent < 0 ? 0 : this.baseIndent;
    let n = 0;
    for (let j = this.cursor + 1, guard = 0; j < this.lines.length && guard < 80; j++, guard++) {
      const raw = this.lines[j];
      if (raw === null) continue;
      const s = raw.replace(/\s+$/, "");
      const t = s.trim();
      if (!t) return n; // 空行即分组结束
      const ind = countIndent(s) - base;
      if (ind < relIndent) return n;
      if (/^[-*+]\s+/.test(t)) {
        if (ind === relIndent) n++;
        continue;
      }
      if (ind === relIndent) return n; // 同级非列表行 → 分组结束
    }
    return n;
  }

  /**
   * 探测紧随其后的列表分组形态：
   *  - topLevels：同缩进顶层项个数
   *  - hasNested：顶层项之下是否还有缩进子项
   * 判定规则：顶层项 ≥ 2 → 各顶层项互为并列知识点（均提升）；
   *          顶层项 = 1 且含缩进子项 → 视为上一个知识点的内容（折叠为正文）。
   */
  peekListGroup() {
    const base = this.baseIndent < 0 ? 0 : this.baseIndent;
    let topLevels = 0;
    let hasNested = false;
    for (let j = this.cursor + 1, guard = 0; j < this.lines.length && guard < 120; j++, guard++) {
      const raw = this.lines[j];
      if (raw === null) continue;
      const s = raw.replace(/\s+$/, "");
      const t = s.trim();
      if (!t) break;
      const ind = countIndent(s) - base;
      if (ind < 0) break;
      if (/^[-*+]\s+/.test(t)) {
        if (ind === 0) topLevels++;
        else hasNested = true;
        continue;
      }
      if (ind === 0) break; // 顶层非列表行 → 分组结束
      hasNested = true;
    }
    const nested = topLevels === 1 && hasNested;
    return { topLevels, hasNested, nested, promoted: topLevels >= 2 };
  }

  /** 加粗标题之后是否为「单个顶层项 + 缩进子项」的嵌套列表 */
  boldFollowedByNestedList() {
    return this.peekListGroup().nested;
  }

  /**
   * 该列表分组是否应提升为知识点：
   *  - 顶层项 ≥ 2 → 明确是并列条目，提升；
   *  - 「1 个顶层项 + 缩进子项」且当前没有知识点可折叠 → 提升（否则内容会全部丢失）。
   */
  shouldPromoteListGroup(group) {
    if (group.topLevels >= 2) return true;
    if (group.nested) return !this.currentItem;
    return false;
  }

  /**
   * 宽松解析的兜底：某些内容文件在章节标题下直接写正文、没有任何列表或加粗标题，
   * 此时把该章节的正文整体作为一个知识点（标题取正文首行），避免内容全部被丢弃。
   * 仅在 relaxStructure 开启且正文有实质长度时生效。
   */
  flushChapterItem() {
    if (!this.chapterLines.length) return;
    const body = this.chapterLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    this.chapterLines = [];
    const plain = stripInlineMd(body).replace(/\s+/g, " ").trim();
    if (plain.length < 10) {
      this.issue(SEV.INFO, `章节「${truncate(this.chapter, 20)}」下的 ${plain.length} 字正文过短，未生成知识点。`, this.chapterStart || 1);
      this.result.stats.skippedLines++;
      return;
    }
    const firstLine = stripInlineMd(body.split("\n").find((l) => l.trim()) || this.chapter).trim();
    const title = truncate(firstLine.replace(/[。；;，,]$/, ""), 28) || this.chapter;
    this.startItem(title, this.chapterStart || 1, {
      promoted_from: "chapter",
      chapter_fallback: true,
    });
    this.currentBody.push(body);
    this.finishItem();
  }

  /** 已经收集到正文时，加粗行更可能是「正文内的强调」而非新知识点标题 */
  isContinuationOfBody() {
    if (!this.currentItem) return false;
    const bodyLen = this.currentBody.join("").length;
    const sections = this.currentItem.key_points.length + this.currentItem.common_mistakes.length;
    return bodyLen + sections > 0;
  }

  flushParagraph() {
    /* 正文以整行数组保存，段落之间保留空行由 join 处理；此处仅做占位以便扩展 */
  }

  flushOrphans() {
    if (!this.orphanLines.length) return;
    const sample = truncate(this.orphanLines.slice(0, 3).join(" / "), 60);
    this.issue(
      SEV.WARN,
      `第 ${this.orphanStart} 行起的 ${this.orphanLines.length} 行内容不属于任何知识点（缺少 ### 知识点标题），将被忽略：${sample}…`,
      this.orphanStart
    );
    this.result.stats.skippedLines += this.orphanLines.length;
    this.orphanLines = [];
    this.orphanStart = 0;
  }

  /* ---------- 区块 ---------- */
  handleBlockTitle(label, lineNo) {
    const map = {
      要点: "key_points",
      考点: "key_points",
      重点: "key_points",
      易错点: "common_mistakes",
      易错: "common_mistakes",
      题目: "questions",
    };
    const block = map[label];
    if (!block) return;
    if (!this.currentItem && this.promoteBold) {
      // 允许在没有显式知识点的情况下挂到「当前章节」的默认知识点
      this.startItem("本章要点", lineNo, { promoted_from: "block" });
    }
    if (!this.currentItem) {
      this.issue(
        SEV.WARN,
        `「${label}：」区块（第 ${lineNo} 行）不在任何知识点之下，将被忽略。请在其上方补充「### 知识点名称」。`,
        lineNo
      );
      this.block = null;
      return;
    }
    this.block = block;
    if (block === "questions" && !this.currentItem._hasQuestionHeader) {
      this.currentItem._hasQuestionHeader = true;
    }
  }

  /** 要点 / 易错点列表项 */
  handleListLine(t, lineNo) {
    const li = /^(?:[-*+]|\d{1,3}[.、)）])\s+(.*)$/.exec(t);
    if (!li) return false;
    const text = normalizeText(li[1]);
    if (!text) return false;
    if (this.block === "key_points") this.currentItem.key_points.push(text);
    else if (this.block === "common_mistakes") this.currentItem.common_mistakes.push(text);
    return true;
  }

  /* ---------- 元信息 ---------- */
  applyMeta(key, value, lineNo) {
    const item = this.currentItem;
    const val = normalizeText(value.replace(/(\*\*|__)/g, ""));
    switch (key) {
      case "难度":
      case "星级": {
        const n = parseDifficulty(val, lineNo, (m, s) => this.issue(s, m, lineNo));
        if (n) item.difficulty = n;
        break;
      }
      case "标签":
        item.tags.push(...val.split(/[,，、;；/\s]+/).map((s) => s.trim()).filter(Boolean));
        break;
      case "关联":
        item.related_titles.push(...val.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean));
        break;
      case "考频":
        item.frequency = val;
        break;
      case "备注":
        item.note_lines = item.note_lines || [];
        item.note_lines.push(val);
        break;
      default:
        break;
    }
  }

  /* ---------- 题目 ---------- */
  handleQuestionLine(line, lineNo) {
    const t = line.trim();
    const item = this.currentItem;
    if (!item) return;

    // 选项行（可能有缩进）
    const opt = RE_OPTION.exec(line);
    const qnum = RE_QNUM.exec(t);
    // 「1. 题干」优先于选项判断（题号必须是数字）
    if (qnum && !opt) {
      this.startQuestion(qnum[1], qnum[2], lineNo);
      return;
    }
    const cur = this.currentQuestion();
    if (!cur) {
      // 题目区块开头不是题号：可能直接写选项（兼容）或题干无题号
      if (opt) {
        this.startQuestion(String(this.questionOrder + 1), "", lineNo);
        this.pushOption(opt[1], opt[2], lineNo);
        return;
      }
      this.issue(
        SEV.WARN,
        `「题目：」区块中的第 ${lineNo} 行不符合题目规范（应以「1. 」开头），已忽略：${truncate(t, 40)}`,
        lineNo
      );
      this.result.stats.skippedLines++;
      return;
    }

    if (RE_ANSWER.test(t)) {
      const m = RE_ANSWER.exec(t);
      if (cur.answer_raw !== undefined && cur.answer_raw !== "") {
        this.issue(SEV.WARN, `第 ${cur.line} 行的题目出现了多个「答案：」，以第一个为准。`, lineNo);
        return;
      }
      cur.answer_raw = normalizeText(m[1]);
      cur.answer_line = lineNo; // 记录答案所在行，便于错误精确定位（验收：失败明细含行号）
      return;
    }
    if (RE_ANALYSIS.test(t)) {
      const m = RE_ANALYSIS.exec(t);
      cur.analysis = cur.analysis ? `${cur.analysis}\n${normalizeText(m[1])}` : normalizeText(m[1]);
      return;
    }
    if (opt) {
      if (cur.answer_raw !== undefined && cur.answer_raw !== "") {
        // 答案之后又出现选项：视为解析的续行
        cur.analysis = `${cur.analysis || ""}\n${t}`.trim();
        return;
      }
      this.pushOption(opt[1], opt[2], lineNo);
      return;
    }
    // 其余：题干续行（多行题干）
    if (cur.answer_raw !== undefined && cur.answer_raw !== "") {
      cur.analysis = `${cur.analysis || ""}\n${t}`.trim();
    } else {
      cur.stem = `${cur.stem}\n${t}`.trim();
    }
  }

  currentQuestion() {
    return this.currentItem?._questions?.[this.currentItem._questions.length - 1] || null;
  }

  startQuestion(num, stem, lineNo) {
    const item = this.currentItem;
    if (!item._questions) item._questions = [];
    const q = {
      num: Number(num),
      stem: normalizeText(stem),
      options: [],
      answer_raw: "",
      answer_line: 0,
      analysis: "",
      line: lineNo,
    };
    item._questions.push(q);
  }

  pushOption(letter, text, lineNo) {
    const cur = this.currentQuestion();
    if (!cur) return;
    const L = letter.toUpperCase();
    if (cur.options.some((o) => o.key === L)) {
      this.issue(SEV.WARN, `第 ${lineNo} 行的选项 ${L} 重复，已忽略重复项。`, lineNo);
      return;
    }
    cur.options.push({ key: L, text: normalizeText(text) });
  }

  /* ---------- 汇总：把题目冻结为 questions 记录 ---------- */
  freezeQuestions(item) {
    const list = item._questions || [];
    delete item._questions;
    for (const q of list) this.freezeOneQuestion(item, q);
  }

  freezeOneQuestion(item, q) {
    const type = detectType(q.stem, q.answer_raw, q.options);
    const stemClean = cleanStem(q.stem);
    const base = {
      item_id: item.id,
      subject: item.subject,
      chapter: item.chapter,
      type,
      stem: stemClean,
      options: q.options,
      answer: "",
      analysis: q.analysis || "",
      difficulty: item.difficulty || 1,
      order: ++this.questionOrder,
      line: q.line,
    };
    const validated = validateQuestion(base, q, {
      requireAnswer: this.opts.requireAnswer,
      strictAnswer: this.opts.strictAnswer,
    });
    for (const iss of validated.issues) {
      // 定位优先指向答案行；缺答案等情况回落到题干起始行
      this.issue(iss.severity, iss.message, q.answer_line || q.line, {
        title: item.title,
        question: truncate(stemClean, 30),
      });
    }
    if (!validated.ok) {
      this.result.stats.skippedLines++;
      return;
    }
    base.answer = validated.answer;
    base.id = `q_${stableKey(item.id, stemClean, String(q.num))}`;
    this.result.questions.push(base);
  }
}

/* ------------------------------ 题型判定与校验 ------------------------------ */

/** 题型判定：题干标记优先，其次看答案形态 */
export function detectType(stem, answerRaw, options = []) {
  if (RE_TYPE_MULTI.test(stem)) return "multi";
  if (RE_TYPE_TF.test(stem)) return "tf";
  if (RE_TYPE_MATCH.test(stem)) return "match";
  const ans = normalizeAnswerRaw(answerRaw);
  if (/^[对错正误TF]$/i.test(ans) || /^(正确|错误|是|否)$/.test(ans)) return "tf";
  if (/^[A-H]\s*[-—–]\s*\d/.test(ans)) return "match";
  if (/[,，、;；]/.test(ans) && /^[A-H][,，、;；A-H\s]*$/.test(ans)) return "multi";
  if (!options.length && /[,，、;；]/.test(ans)) return "match";
  return "single";
}

/** 清洗答案原文：去空格、统一标点、去「选」字 */
export function normalizeAnswerRaw(raw) {
  return normalizeText(String(raw ?? ""))
    .replace(/(\*\*|__)/g, "")
    .replace(/^选\s*/, "")
    .replace(/[。．.]$/, "")
    .replace(/：/g, ":")
    .trim();
}

/** 去掉题干里的题型标记，保留纯题干 */
export function cleanStem(stem) {
  return normalizeText(stem)
    .replace(RE_TYPE_MULTI, "")
    .replace(RE_TYPE_TF, "")
    .replace(RE_TYPE_MATCH, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 答案校验（提示词 4.1.3 / 4.1.4）
 * @returns {{ok:boolean, answer:string, issues:Array<{severity:string,message:string}>}}
 */
export function validateQuestion(q, raw, { requireAnswer = true, strictAnswer = true } = {}) {
  const issues = [];
  const ansRaw = normalizeAnswerRaw(raw.answer_raw);
  const letters = q.options.map((o) => o.key);

  if (!ansRaw) {
    if (requireAnswer) {
      issues.push({ severity: SEV.ERROR, message: "题目缺少「答案：」行，已跳过该题。" });
      return { ok: false, answer: "", issues };
    }
    return { ok: true, answer: "", issues };
  }

  const pushErr = (msg) => issues.push({ severity: SEV.ERROR, message: msg });
  const pushWarn = (msg) => issues.push({ severity: SEV.WARN, message: msg });

  // 判断题
  if (q.type === "tf") {
    const norm = ansRaw.replace(/[。．.\s]/g, "");
    if (/^(对|正确|是|T|true|√)$/i.test(norm)) return { ok: true, answer: "对", issues };
    if (/^(错|错误|否|F|false|×|x)$/i.test(norm)) return { ok: true, answer: "错", issues };
    pushErr(`判断题答案「${ansRaw}」非法，应为「对」或「错」，已跳过该题。`);
    return { ok: false, answer: "", issues };
  }

  // 配伍题
  if (q.type === "match") {
    const pairs = ansRaw
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const okPairs = [];
    for (const p of pairs) {
      const m = /^([A-Ha-h])\s*[-—–:：]\s*(\d{1,3})$/.exec(p);
      if (!m) {
        pushErr(`配伍题答案片段「${p}」格式非法（应为 A-1,B-2 形式），已跳过该题。`);
        return { ok: false, answer: "", issues };
      }
      okPairs.push(`${m[1].toUpperCase()}-${m[2]}`);
    }
    if (okPairs.length < 2) pushWarn("配伍题建议至少给出 2 组映射。");
    return { ok: true, answer: okPairs.join(","), issues };
  }

  // 单选 / 多选
  const parts = ansRaw.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  const lettersOut = [];
  for (const p of parts) {
    const m = /^[（(]?\s*([A-Ha-h])\s*[)）]?$/.exec(p);
    if (!m) {
      pushErr(`答案「${ansRaw}」格式非法（单选应为 A–H 字母，多选用逗号分隔），已跳过该题。`);
      return { ok: false, answer: "", issues };
    }
    const L = m[1].toUpperCase();
    if (!lettersOut.includes(L)) lettersOut.push(L);
    else pushWarn(`答案中的选项 ${L} 重复出现。`);
  }
  if (!lettersOut.length) {
    pushErr(`答案「${ansRaw}」为空或无法识别，已跳过该题。`);
    return { ok: false, answer: "", issues };
  }
  if (q.type === "single" && lettersOut.length > 1) {
    // 题干未标记多选但答案多个：按多选处理并提示
    pushWarn(`题干未标注「（多选）」但答案包含多个选项（${lettersOut.join(",")}），已按多选题处理。`);
    q.type = "multi";
  }
  if (strictAnswer && letters.length) {
    const missing = lettersOut.filter((L) => !letters.includes(L));
    if (missing.length) {
      pushWarn(`答案包含未列出的选项 ${missing.join(",")}（现有选项：${letters.join(",")}）。`);
    }
  }
  if (q.type === "single" && lettersOut.length > 1) {
    pushErr(`单选题只能有一个答案，当前为 ${lettersOut.join(",")}，已跳过该题。`);
    return { ok: false, answer: "", issues };
  }
  return { ok: true, answer: lettersOut.join(","), issues };
}

/** 难度解析：支持 1-3 数字、★ 数量 */
export function parseDifficulty(val, lineNo, report) {
  const t = normalizeText(val);
  const stars = (t.match(/[★⭐]/g) || []).length;
  if (stars) return Math.min(3, Math.max(1, stars));
  const n = Number((t.match(/[1-3]/) || [])[0]);
  if (n >= 1 && n <= 3) return n;
  if (report) report(`第 ${lineNo} 行的「难度：${t}」无法识别（应为 1–3 或 ★），已按 1 处理。`, SEV.WARN);
  return 1;
}

/** 供外部（导入管线）复用的题目冻结入口 */
export function freezeItemQuestions(engine, item) {
  engine.freezeQuestions(item);
}

export { DEFAULT_OPTION_LETTERS, hashStr };

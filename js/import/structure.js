/**
 * Markdown 结构预分析（结构探测）
 * 用户内容文件在实际使用中风格不一，这里只做「只读探测 + 建议」，
 * 真正的解析由 markdown.js 按探测结果执行；探测结果会在导入预览中展示，
 * 用户可手动覆盖。绝不编造内容（提示词硬性原则 1）。
 *
 * 支持的结构档案（profile）：
 *  - standard  ：# 科目 / ## 章节 / ### 知识点（提示词 4.1 标准规范）
 *  - h3-items  ：与文件名同名的一级标题视为文档标题并跳过，其余同 standard
 *  - h2-items  ：## 作为知识点（标题不像「章/篇/节」时）
 *  - h2-chapters：## 形如「第一章」→ 章节，但缺少 ### 知识点
 *  - h2-pages  ：## 形如「第 N 页」→ 无真实章节层级（导图/PDF 转录文件常见）
 *  - h1-items  ：只有 # 一级标题
 *  - flat      ：完全没有标题层级
 * @module import/structure
 */

import { normalizeText, truncate } from "../core/util.js";

const PAGE_LINE = /^(第\s*\d+\s*页|page\s*\d+|P\.?\s*\d+)$/i;
const DECORATION = /^(（?章节扉页）?|（?空白页[^）]*）?|（?目录）?|（?封面）?)$/;
/** 形如章节的标题：第一章 / 第2节 / 一、xxx / 绪论 / 总论 */
const CHAPTER_LIKE = /^(第\s*[0-9一二三四五六七八九十百]+\s*[章节篇部分]|Chapter\s*\d+|[0-9]{1,2}[.、]\s*\S|绪\s*论|总\s*论|引\s*言|前\s*言|附\s*录)/i;

/** 是否为「页码式」标题（导图/PDF 转录文件常见） */
export function isPageHeading(text) {
  const t = normalizeText(text).replace(/[（(].*?[)）]/g, "").trim();
  return PAGE_LINE.test(t);
}

/** 是否为装饰性标题（扉页/空白页等） */
export function isDecorationHeading(text) {
  const t = normalizeText(text);
  return DECORATION.test(t) || (/^（.*）$/.test(t) && t.length <= 12 && /扉页|空白|页码|水印|目录/.test(t));
}

/** 是否形如章节标题 */
export function isChapterLike(text) {
  const t = normalizeText(text);
  if (!t) return false;
  return CHAPTER_LIKE.test(t);
}

/**
 * 扫描全文标题，统计各层级数量并给出建议
 * @param {string} text
 * @param {{name?:string}} [meta]
 */
export function probeStructure(text, meta = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const headings = [];
  let inFence = false;
  let inFrontMatter = false;
  let frontMatterEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (i === 0 && /^---\s*$/.test(t)) {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (/^---\s*$/.test(t)) {
        inFrontMatter = false;
        frontMatterEnd = i;
      }
      continue;
    }
    if (/^(```|~~~)/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(t);
    if (m) {
      headings.push({
        level: m[1].length,
        text: normalizeText(m[2]),
        line: i + 1,
        page: isPageHeading(m[2]),
        decoration: isDecorationHeading(m[2]),
        chapterLike: isChapterLike(m[2]),
      });
    }
  }

  const real = headings.filter((h) => !h.page && !h.decoration);
  const count = (lv) => real.filter((h) => h.level === lv).length;
  const h1 = count(1);
  const h2 = count(2);
  const h3 = count(3);
  const pageHeadingCount = headings.filter((h) => h.page).length;
  const chapterLikeH2 = real.filter((h) => h.level === 2 && h.chapterLike).length;
  const firstH1 = real.find((h) => h.level === 1);
  const baseName = meta.name ? normalizeText(String(meta.name).replace(/\.md$/i, "")) : "";
  const firstH1LooksLikeDocTitle =
    !!firstH1 && !!baseName && (firstH1.text.includes(baseName) || baseName.includes(firstH1.text));

  const notes = [];
  let profile = "standard";

  if (h1 === 0 && h2 === 0 && h3 === 0) {
    profile = pageHeadingCount ? "h2-pages" : "flat";
    notes.push(
      pageHeadingCount
        ? `只发现 ${pageHeadingCount} 个「第 N 页」式标题，它们不构成知识层级；可开启「宽松解析」把加粗标题 / 列表项识别为知识点。`
        : "未发现任何 Markdown 标题（# / ## / ###），无法建立科目-章节-知识点层级。"
    );
  } else if (h3 > 0) {
    profile = firstH1LooksLikeDocTitle ? "h3-items" : "standard";
    if (firstH1LooksLikeDocTitle) {
      notes.push(`一级标题「${truncate(firstH1.text, 20)}」与文件名同名，视为文档标题并跳过，其余一级标题作为科目。`);
    }
  } else if (h2 > 0) {
    if (chapterLikeH2 > 0 && chapterLikeH2 * 2 >= h2) {
      profile = "h2-chapters";
      notes.push(`二级标题中有 ${chapterLikeH2} 个形如「第 X 章」的章节标题，但没有任何三级标题（知识点）。`);
    } else {
      profile = "h2-items";
      notes.push(`未发现三级标题，将把二级标题（共 ${h2} 个）直接作为知识点，一级标题作为科目。`);
    }
  } else {
    profile = "h1-items";
    notes.push(`只有一级标题（共 ${h1} 个），缺少章节/知识点层级；可开启「宽松解析」把加粗标题或列表项识别为知识点。`);
  }

  if (pageHeadingCount) {
    notes.push(`另有 ${pageHeadingCount} 个「第 N 页」式标题，将被跳过（不生成科目/章节）。`);
  }

  return {
    profile,
    headings,
    levels: { h1, h2, h3 },
    pageHeadingCount,
    chapterLikeH2,
    docTitle: firstH1LooksLikeDocTitle ? firstH1.text : "",
    lineCount: lines.length,
    frontMatterEnd,
    notes,
  };
}

/** 档案说明文案（展示给用户） */
export function profileLabel(profile) {
  return (
    {
      standard: "标准规范：# 科目 / ## 章节 / ### 知识点",
      "h3-items": "标准层级 + 跳过文档标题",
      "h2-items": "二级标题即知识点（无三级标题）",
      "h2-chapters": "二级标题为章节，缺少三级知识点",
      "h2-pages": "只有页码式标题（导图转录）",
      "h1-items": "只有科目层级",
      flat: "未识别到层级（无法解析）",
    }[profile] || profile
  );
}

/** 是否属于「需要宽松解析」的档案 */
export function needsRelax(profile) {
  return ["h2-chapters", "h2-pages", "h1-items"].includes(profile);
}

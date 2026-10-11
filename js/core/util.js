/**
 * 通用工具函数（纯函数优先，便于单元测试）
 * @module core/util
 */

/** 生成短 id（内容去重键 + 随机后缀） */
export function uid(prefix = "id") {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/** 稳定的字符串哈希（FNV-1a 32bit，转 36 进制），用于生成内容指纹 */
export function hashStr(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 由多段文本生成稳定键：同名知识点/同题干在重复导入时保持同一 id */
export function stableKey(...parts) {
  return hashStr(parts.map((p) => normalizeText(p)).join("\u0001"));
}

/** 归一化文本：去首尾空白、压缩连续空白、统一全角空格 */
export function normalizeText(s) {
  return String(s ?? "")
    .replace(/\u3000/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** 去掉 Markdown 行内标记（供需要纯文本的场景：卡片摘要、搜索索引） */
export function stripInlineMd(s) {
  return normalizeText(
    String(s ?? "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/<[^>]+>/g, "")
  );
}

/** 0 补位 */
export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 本地日期键 YYYY-MM-DD */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 今天的日期键 */
export function todayKey() {
  return dateKey(new Date());
}

/** 在某日期上加减天数，返回新 Date */
export function addDays(date, days) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** 两个日期相差的整天数（b - a） */
export function daysBetween(a, b) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
}

/** 相对时间描述（用于导入记录、错题时间） */
export function relTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
  return dateKey(new Date(ts));
}

/** 时间戳格式化 */
export function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${dateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 数字千分位 */
export function fmtNum(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

/** 百分比 */
export function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** HTML 转义（所有来自用户 Markdown 的文本在插入 DOM 前必须转义） */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 极简 Markdown → HTML（仅支持提示词允许的轻量语法）
 * 顺序：先转义 → 再替换行内标记 → 再处理块级（列表/引用/标题）
 * 仅用于可信来源（用户自己导入的 md）渲染，仍做转义以防脚本注入。
 */
export function mdToHtml(src) {
  const lines = String(src ?? "").split(/\r?\n/);
  const out = [];
  let listMode = null; // 'ul' | 'ol' | null
  let inQuote = false;

  const closeList = () => {
    if (listMode) {
      out.push(`</${listMode}>`);
      listMode = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      closeQuote();
      continue;
    }
    const t = line.trim();
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      closeList();
      closeQuote();
      const lvl = Math.min(6, h[1].length + 2); // 卡片内的标题降级显示
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      closeList();
      closeQuote();
      out.push("<hr />");
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    if (ul) {
      closeQuote();
      if (listMode !== "ul") {
        closeList();
        out.push("<ul>");
        listMode = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^(\d{1,3})[.、)]\s+(.*)$/.exec(t);
    if (ol) {
      closeQuote();
      if (listMode !== "ol") {
        closeList();
        out.push("<ol>");
        listMode = "ol";
      }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(t);
    if (q) {
      closeList();
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(`<p>${inline(q[1])}</p>`);
      continue;
    }
    closeList();
    closeQuote();
    out.push(`<p>${inline(t)}</p>`);
  }
  closeList();
  closeQuote();
  return out.join("\n");
}

/** 行内标记：加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 高亮 == == */
export function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
  t = t.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "<em>$1</em>");
  t = t.replace(/~~(.+?)~~/g, "<del>$1</del>");
  t = t.replace(/==(.+?)==/g, '<mark class="hl">$1</mark>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

/** 文本截断（保留完整词尾省略号） */
export function truncate(s, n = 80) {
  const t = normalizeText(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 数组去重 */
export function uniq(arr) {
  return Array.from(new Set(arr));
}

/** 按 key 分组 */
export function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** 稳定排序（按中文字符串） */
export function sortZh(arr, keyFn = (x) => x) {
  return [...arr].sort((a, b) => String(keyFn(a)).localeCompare(String(keyFn(b)), "zh-Hans-CN"));
}

/** 简易防抖 */
export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 数字转中文序数（用于章节排序展示） */
export function cnNum(n) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 10) return digits[n];
  if (n < 20) return `十${n % 10 ? digits[n % 10] : ""}`;
  const tens = Math.floor(n / 10);
  return `${digits[tens]}十${n % 10 ? digits[n % 10] : ""}`;
}

/** 星级文本：3 → ★★★，0 → ☆☆☆ */
export function starsText(n) {
  const v = Math.max(0, Math.min(3, Number(n) || 0));
  return "★".repeat(v) + "☆".repeat(3 - v);
}

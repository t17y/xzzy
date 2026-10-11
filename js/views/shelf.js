/**
 * 精华卡片书架（提示词 5.4 / 六.10）
 * 按科目 / 标签 / 来源（普通、错题精华）分组展示，显示卡片计数；含全文搜索与书签
 * @module views/shelf
 */

import { escapeHtml, truncate } from "../core/util.js";
import { toast } from "../core/dom.js";
import { navigate } from "../core/router.js";
import { shelf, listCards, syncBaseCards, readPosition } from "../core/cards.js";
import { listItems } from "../core/db.js";
import { on, EV } from "../core/events.js";

export const shelfView = {
  title: "卡片",
  tab: "cards",
  async render(ctx) {
    // 首次进入时补齐基础卡片（导入的知识点 → 基础卡片）
    const items = await listItems();
    if (items.length) await syncBaseCards(items);
    const data = await shelf();
    const source = ctx.query?.source || "";
    const subject = ctx.query?.subject || "";
    const tag = ctx.query?.tag || "";
    const q = ctx.query?.q || "";
    const bookmarkedOnly = ctx.query?.bookmarked === "1";

    if (!data.total) return emptyHtml();

    const filtered = await listCards({
      source: source || undefined,
      subject: subject || undefined,
      tag: tag || undefined,
      q: q || undefined,
      bookmarked: bookmarkedOnly || undefined,
    });
    const last = await readPosition(scopeOf({ source, subject, tag, q, bookmarkedOnly }));

    const subjectRows = data.subjects
      .map(
        (s) => `<button class="list-item" type="button" data-open-subject="${escapeHtml(s.subject)}">
          <span class="list-item-icon">📘</span>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(s.subject)}</div>
            <div class="list-item-sub">${s.total} 张卡片 · ${s.chapters} 章${s.wrong ? ` · 错题精华 ${s.wrong}` : ""}</div>
          </div>
          <span class="list-item-chev">›</span>
        </button>`
      )
      .join("");

    const tagChips = data.tags
      .slice(0, 20)
      .map((t) => `<button class="chip ${tag === t.tag ? "chip-on" : ""}" type="button" data-tag="${escapeHtml(t.tag)}">${escapeHtml(t.tag)} ${t.total}</button>`)
      .join("");

    return `
    <section class="section">
      <div class="stats">
        <div class="stat"><div class="stat-value">${data.total}</div><div class="stat-label">卡片总数</div></div>
        <div class="stat"><div class="stat-value">${data.baseCards}</div><div class="stat-label">基础卡片</div></div>
        <div class="stat"><div class="stat-value">${data.wrongCards}</div><div class="stat-label">错题精华</div></div>
        <div class="stat"><div class="stat-value">${data.bookmarked}</div><div class="stat-label">书签</div></div>
      </div>
    </section>

    <section class="section">
      <div class="row-wrap">
        <button class="btn grow" type="button" data-read="${escapeHtml(filterQuery({ source, subject, tag, q, bookmarkedOnly }))}">
          📖 ${last ? "继续阅读" : "开始翻阅"}（${filtered.length}）
        </button>
        ${filtered.length > 1 ? `<button class="btn btn-ghost" type="button" data-read-first="${escapeHtml(filterQuery({ source, subject, tag, q, bookmarkedOnly }))}">从第一张开始</button>` : ""}
      </div>
      ${last ? `<p class="field-hint mt">续读记忆：上次读到第 ${last.index + 1} 张（${new Date(last.at).toLocaleString("zh-CN")}）</p>` : ""}
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">分组</h2><span class="section-sub">科目 / 标签 / 来源</span></div>
      <div class="card">
        <div class="row-wrap">
          <button class="chip ${!source && !subject && !tag ? "chip-on" : ""}" type="button" data-clear="1">全部（${data.total}）</button>
          <button class="chip ${source === "base" ? "chip-on" : ""}" type="button" data-source="base">📗 普通卡片 ${data.baseCards}</button>
          <button class="chip ${source === "wrong" ? "chip-on" : ""}" type="button" data-source="wrong">✨ 错题精华 ${data.wrongCards}</button>
          <button class="chip ${bookmarkedOnly ? "chip-on" : ""}" type="button" data-bookmarked="1">🔖 书签 ${data.bookmarked}</button>
        </div>
        ${tagChips ? `<div class="row-wrap mt">${tagChips}</div>` : ""}
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-search="1">🔍 搜索卡片</button>
          ${subject ? `<button class="btn-quiet" type="button" data-clear="1">清除「${escapeHtml(subject)}」筛选</button>` : ""}
        </div>
      </div>
    </section>

    ${
      subject
        ? `<section class="section">
            <div class="section-head"><h2 class="section-title">${escapeHtml(subject)}</h2>
            <button class="btn-quiet" type="button" data-clear="1">全部科目</button></div>
            <div class="stack">${filtered
              .map(
                (c) => `<button class="card card-btn" type="button" data-read-card="${escapeHtml(c.id)}">
                  <div class="row-between">
                    <span class="badge ${c.source === "wrong" ? "badge-gold" : "badge-blue"}">${c.source === "wrong" ? "错题精华" : "基础"}</span>
                    <span class="tiny muted">${escapeHtml(truncate(c.chapter || "—", 12))}</span>
                  </div>
                  <div class="strong mt">${escapeHtml(c.title)}</div>
                  <div class="small muted">${escapeHtml(truncate(c.summary || "（无摘要）", 60))}</div>
                  <div class="row-wrap tiny mt">
                    ${(c.key_points || []).length ? `<span class="badge">要点 ${c.key_points.length}</span>` : ""}
                    ${(c.common_mistakes || []).length ? `<span class="badge">易错 ${c.common_mistakes.length}</span>` : ""}
                    ${c.note ? '<span class="badge badge-purple">有备注</span>' : ""}
                    ${c.bookmarked ? "<span>🔖</span>" : ""}
                  </div>
                </button>`
              )
              .join("")}</div>
          </section>`
        : `<section class="section">
            <div class="section-head"><h2 class="section-title">科目</h2><span class="section-sub">共 ${data.subjects.length} 个</span></div>
            <div class="list">${subjectRows}</div>
          </section>`
    }

    ${
      source || tag || q || bookmarkedOnly
        ? `<section class="section">
            <div class="section-head"><h2 class="section-title">筛选结果</h2><span class="section-sub">${filtered.length} 张</span></div>
            <div class="stack">${filtered
              .slice(0, 50)
              .map(
                (c) => `<button class="card card-btn" type="button" data-read-card="${escapeHtml(c.id)}">
                  <div class="strong">${escapeHtml(c.title)}</div>
                  <div class="small muted">${escapeHtml(c.subject)} · ${escapeHtml(truncate(c.summary || "（无摘要）", 50))}</div>
                </button>`
              )
              .join("")}</div>
            ${filtered.length > 50 ? `<p class="field-hint">仅显示前 50 张，可进入阅读器连续翻阅。</p>` : ""}
          </section>`
        : ""
    }

    <section class="section">
      <div class="card">
        <div class="kv"><div class="kv-key">卡片来源</div><div class="kv-val">基础卡片＝导入时按知识点自动生成；错题精华＝错题一键沉淀</div></div>
        <div class="kv"><div class="kv-key">内容规则</div><div class="kv-val">正文摘要 + 要点（正面）+ 易错点（背面），零 AI 生成、只做抽取排版</div></div>
        <div class="kv"><div class="kv-key">编辑</div><div class="kv-val">阅读时可编辑要点 / 易错点，并添加个人备注（不污染原始导入数据）</div></div>
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/import">管理导入内容</button>
          <button class="btn btn-ghost btn-sm" type="button" data-go="/wrong">错题本</button>
        </div>
      </div>
    </section>`;
  },

  mount(ctx, root) {
    root.addEventListener("click", async (ev) => {
      const el = ev.target.closest("[data-open-subject],[data-source],[data-tag],[data-bookmarked],[data-clear],[data-read],[data-read-first],[data-read-card],[data-search],[data-go]");
      if (!el) return;
      if (el.dataset.go) return navigate(el.dataset.go);
      if (el.dataset.openSubject) return navigate("/cards", { subject: el.dataset.openSubject });
      if (el.dataset.source) return navigate("/cards", { source: el.dataset.source });
      if (el.dataset.tag) return navigate("/cards", { tag: el.dataset.tag });
      if (el.hasAttribute("data-bookmarked")) return navigate("/cards", { bookmarked: "1" });
      if (el.hasAttribute("data-clear")) return navigate("/cards");
      if (el.dataset.read) return navigate("/reader", { filter: el.dataset.read, start: "last" });
      if (el.dataset.readFirst) return navigate("/reader", { filter: el.dataset.readFirst });
      if (el.dataset.readCard) return navigate("/reader", { filter: filterQuery({ source: "", subject: "" }), card: el.dataset.readCard });
      if (el.hasAttribute("data-search")) return searchDialog();
    });
    const off = on(EV.DATA_CHANGED, (p) => {
      if (["card-saved", "card-removed", "wrong-cards"].includes(p?.reason)) ctx.reload?.();
    });
    return () => off();
  },
};

function emptyHtml() {
  return `<section class="section"><div class="empty">
    <div class="empty-icon">📖</div>
    <div class="empty-title">书架还是空的</div>
    <p class="empty-text">
      导入 Markdown 后，每个知识点都会自动生成一张基础卡片（正文摘要 + 要点 + 易错点）。<br />
      错题本里还能「一键生成错题精华卡片」。
    </p>
    <div class="row-wrap" style="justify-content:center">
      <button class="btn" type="button" data-go="/import">📥 导入内容</button>
      <button class="btn btn-ghost" type="button" data-go="/wrong">错题本</button>
    </div>
  </div></section>`;
}

/** 把当前筛选编码为一个字符串，供阅读器复用 */
export function filterQuery({ source, subject, tag, q, bookmarkedOnly }) {
  const parts = [];
  if (source) parts.push(`source=${encodeURIComponent(source)}`);
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (tag) parts.push(`tag=${encodeURIComponent(tag)}`);
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (bookmarkedOnly) parts.push("bookmarked=1");
  return parts.join("&");
}

/** 解析筛选串 */
export function parseFilter(str) {
  const out = {};
  for (const pair of String(str || "").split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    out[k] = decodeURIComponent(v || "");
  }
  return out;
}

function scopeOf({ source, subject, tag, q, bookmarkedOnly }) {
  return ["reader", source || "-", subject || "-", tag || "-", q || "-", bookmarkedOnly ? "bm" : "-"].join("|");
}

/** 全文搜索对话框 */
async function searchDialog() {
  const { modal } = await import("../core/dom.js");
  const action = await modal({
    title: "搜索卡片",
    body: `<div class="field"><label class="field-label" for="card-q">关键词（标题 / 内容 / 标签 / 备注）</label>
      <input class="input" id="card-q" autocomplete="off" placeholder="例如：静息电位" /></div>
      <p class="field-hint">搜索只在你本机的卡片数据中进行，不会上传任何内容。</p>`,
    actions: [
      { label: "取消", value: "cancel", kind: "btn-ghost" },
      { label: "搜索", value: "go", kind: "btn" },
    ],
  });
  if (action !== "go") return;
  const input = document.getElementById("card-q");
  const q = (input?.value || "").trim();
  if (q) navigate("/cards", { q });
}

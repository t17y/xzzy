/**
 * 卡片阅读页 · 电子书式翻阅（提示词 5.4 / 六.11）
 * 交互：左右滑动 / 点击翻页、目录侧边栏、书签、搜索、续读记忆、自动播放、上下滚动模式切换
 * @module views/reader
 */

import { escapeHtml, mdToHtml, normalizeText, truncate } from "../core/util.js";
import { toast, sheet, modal } from "../core/dom.js";
import { navigate } from "../core/router.js";
import { listCards, saveReadPosition, readPosition, toggleBookmark, getCard, invalidateCardsCache } from "../core/cards.js";
import { readSettings, writeSettings } from "../core/db.js";

const S = {
  cards: [],
  index: 0,
  scope: "reader",
  filter: {},
  autoTimer: null,
  scrollMode: false,
  touchX: 0,
  touchY: 0,
};

export const readerView = {
  title: "卡片阅读",
  back: true,
  tab: null,
  async render(ctx) {
    const { parseFilter } = await import("./shelf.js");
    S.filter = parseFilter(ctx.query?.filter);
    S.scope = ["reader", S.filter.source || "-", S.filter.subject || "-", S.filter.tag || "-", S.filter.q || "-"].join("|");
    const settings = readSettings();
    S.scrollMode = (settings.readMode || "page") === "scroll";
    S.cards = await listCards(S.filter);

    if (!S.cards.length) {
      return `<section class="section"><div class="empty">
        <div class="empty-icon">📭</div><div class="empty-title">这里没有卡片</div>
        <p class="empty-text">换一个筛选条件，或先导入内容 / 生成错题精华卡片。</p>
        <button class="btn btn-block" type="button" data-go="/cards">回到书架</button>
      </div></section>`;
    }

    // 定位：优先 query.card，其次续读记忆
    let index = 0;
    if (ctx.query?.card) {
      const i = S.cards.findIndex((c) => c.id === ctx.query.card);
      if (i >= 0) index = i;
    } else {
      const last = await readPosition(S.scope);
      if (last?.cardId) {
        const i = S.cards.findIndex((c) => c.id === last.cardId);
        if (i >= 0) index = i;
      }
    }
    S.index = index;
    return shell();
  },
  mount(ctx, root) {
    bind(ctx, root);
    paint(ctx, root);
    startAutoPlay(ctx, root);
  },
  unmount() {
    stopAutoPlay();
    if (S.onKey) document.removeEventListener("keydown", S.onKey);
    S.onKey = null;
    S.cards = [];
    S.index = 0;
  },
};

function shell() {
  return `
  <div id="reader-top" class="reader-top"></div>
  <div id="reader-body"></div>
  <div id="reader-foot" class="quiz-foot"></div>`;
}

/* ------------------------------ 渲染 ------------------------------ */

function paint(ctx, root) {
  const top = root.querySelector("#reader-top");
  const body = root.querySelector("#reader-body");
  const foot = root.querySelector("#reader-foot");
  const card = S.cards[S.index];
  if (!card) return;

  top.innerHTML = `
  <div class="row-between">
    <span class="badge ${card.source === "wrong" ? "badge-gold" : "badge-blue"}">${
      card.source === "wrong" ? "错题精华" : "基础卡片"
    }</span>
    <span class="tiny muted">${S.index + 1} / ${S.cards.length}</span>
  </div>
  <div class="progress mt"><div class="progress-fill" style="width:${Math.round(((S.index + 1) / S.cards.length) * 100)}%"></div></div>
  <div class="row-between tiny muted mt">
    <span>${escapeHtml(card.subject)}${card.chapter ? ` · ${escapeHtml(truncate(card.chapter, 12))}` : ""}</span>
    <span>${S.scrollMode ? "滚动模式" : "翻页模式"}${S.autoTimer ? " · 自动播放中" : ""}</span>
  </div>`;

  body.innerHTML = S.scrollMode ? scrollModeHtml() : cardHtml(card, S.index);
  foot.innerHTML = footHtml();
  saveReadPosition(S.scope, card.id, S.index).catch(() => {});
}

function cardHtml(card, index) {
  const total = S.cards.length;
  const prev = index > 0 ? S.cards[index - 1] : null;
  const next = index < total - 1 ? S.cards[index + 1] : null;
  return `
  <div class="reader-stage" data-stage="1">
    <div class="reader-peek reader-peek-left" data-jump="${prev ? escapeHtml(prev.id) : ""}">${prev ? "‹" : ""}</div>
    <article class="book-page">
      <div class="row-between">
        <span class="tiny muted">${escapeHtml(card.subject)} · ${escapeHtml(truncate(card.chapter || "—", 14))}</span>
        <span class="tiny muted">难度 ${card.difficulty || 1}</span>
      </div>
      <h2 class="book-title">${escapeHtml(card.title)}</h2>
      ${card.summary ? `<p class="book-summary">${escapeHtml(card.summary)}</p>` : ""}
      ${
        card.key_points?.length
          ? `<div class="book-face book-front">
              <div class="book-face-label">要点（正面）</div>
              <ul class="tight">${card.key_points.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul>
            </div>`
          : ""
      }
      ${
        card.common_mistakes?.length
          ? `<div class="book-face book-back">
              <div class="book-face-label">易错点（背面）</div>
              <ul class="tight">${card.common_mistakes.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul>
            </div>`
          : ""
      }
      ${card.content ? `<details class="acc mt"><summary>展开完整正文</summary><div class="md-body">${mdToHtml(card.content)}</div></details>` : ""}
      ${card.analysis?.length ? `<div class="note mt"><span>📝</span><div><strong>本题解析</strong><ul class="tight">${card.analysis.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul></div></div>` : ""}
      ${card.note ? `<div class="note note-ok mt"><span>📌</span><div><strong>我的备注</strong><div>${escapeHtml(card.note)}</div></div></div>` : ""}
      ${(card.tags || []).length ? `<div class="row-wrap mt">${card.tags.map((t) => `<span class="badge badge-purple">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="book-page-footer">第 ${index + 1} / ${total} 页</div>
    </article>
    <div class="reader-peek reader-peek-right" data-jump="${next ? escapeHtml(next.id) : ""}">${next ? "›" : ""}</div>
  </div>`;
}

function scrollModeHtml() {
  return `<div class="stack">${S.cards
    .map(
      (c, i) => `<article class="book-page" id="card-${i}">
        <div class="row-between"><span class="tiny muted">${escapeHtml(c.subject)}</span><span class="tiny muted">${i + 1} / ${S.cards.length}</span></div>
        <h3 class="book-title" style="font-size:1.05rem">${escapeHtml(c.title)}</h3>
        ${c.summary ? `<p class="book-summary">${escapeHtml(c.summary)}</p>` : ""}
        ${
          c.key_points?.length
            ? `<div class="book-face book-front"><div class="book-face-label">要点</div><ul class="tight">${c.key_points
                .map((k) => `<li>${escapeHtml(k)}</li>`)
                .join("")}</ul></div>`
            : ""
        }
        ${
          c.common_mistakes?.length
            ? `<div class="book-face book-back"><div class="book-face-label">易错点</div><ul class="tight">${c.common_mistakes
                .map((k) => `<li>${escapeHtml(k)}</li>`)
                .join("")}</ul></div>`
            : ""
        }
        ${c.note ? `<div class="note note-ok mt"><span>📌</span><div>${escapeHtml(c.note)}</div></div>` : ""}
      </article>`
    )
    .join("")}</div>`;
}

function footHtml() {
  const card = S.cards[S.index];
  return `<div class="col">
    <div class="row" style="gap:8px">
      <button class="btn btn-ghost grow" type="button" data-act="prev" ${S.index === 0 && S.scrollMode ? "disabled" : ""}>‹ 上一张</button>
      <button class="btn grow" type="button" data-act="next">下一张 ›</button>
    </div>
    <div class="row-wrap" style="justify-content:center">
      <button class="btn-quiet" type="button" data-act="toc">目录</button>
      <button class="btn-quiet" type="button" data-act="bookmark">${card?.bookmarked ? "🔖 已收藏" : "🔖 收藏"}</button>
      <button class="btn-quiet" type="button" data-act="edit">✏️ 编辑</button>
      <button class="btn-quiet" type="button" data-act="search">🔍 搜索</button>
      <button class="btn-quiet" type="button" data-act="auto">${S.autoTimer ? "⏸ 停止播放" : "▶️ 自动播放"}</button>
      <button class="btn-quiet" type="button" data-act="mode">${S.scrollMode ? "📄 翻页模式" : "📜 滚动模式"}</button>
    </div>
  </div>`;
}

/* ------------------------------ 交互 ------------------------------ */

function bind(ctx, root) {
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-act],[data-jump]");
    if (!el) return;
    if (el.dataset.jump) {
      const i = S.cards.findIndex((c) => c.id === el.dataset.jump);
      if (i >= 0) return go(ctx, root, i);
      return;
    }
    const act = el.dataset.act;
    if (act === "prev") return go(ctx, root, S.index - 1);
    if (act === "next") {
      if (S.index >= S.cards.length - 1) {
        stopAutoPlay();
        return toast("已经是最后一张卡片", { type: "ok" });
      }
      return go(ctx, root, S.index + 1);
    }
    if (act === "toc") return showToc(ctx, root);
    if (act === "bookmark") return doBookmark(ctx, root);
    if (act === "edit") return navigate("/card-edit", { id: S.cards[S.index].id, filter: ctx.query?.filter || "" });
    if (act === "search") return cardSearch(ctx, root);
    if (act === "auto") return toggleAuto(ctx, root);
    if (act === "mode") return switchMode(ctx, root);
    if (act === "go-card") {
      const i = S.cards.findIndex((c) => c.id === el.dataset.id);
      if (i >= 0) go(ctx, root, i);
    }
  });

  // 键盘翻页（桌面调试友好）；在 unmount 中移除
  const onKey = (ev) => {
    if (ev.key === "ArrowLeft") go(ctx, root, S.index - 1);
    if (ev.key === "ArrowRight") go(ctx, root, S.index + 1);
  };
  document.addEventListener("keydown", onKey);
  S.onKey = onKey;

  // 触摸滑动翻页
  const stage = () => root.querySelector('[data-stage="1"]');
  root.addEventListener(
    "touchstart",
    (ev) => {
      const t = ev.touches?.[0];
      if (!t) return;
      S.touchX = t.clientX;
      S.touchY = t.clientY;
    },
    { passive: true }
  );
  root.addEventListener(
    "touchend",
    (ev) => {
      if (S.scrollMode || !stage()) return;
      const t = ev.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - S.touchX;
      const dy = t.clientY - S.touchY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) go(ctx, root, S.index + 1);
        else go(ctx, root, S.index - 1);
      }
    },
    { passive: true }
  );
}

function go(ctx, root, index) {
  if (index < 0) {
    toast("已经是第一张卡片", { type: "ok" });
    return;
  }
  S.index = Math.max(0, Math.min(S.cards.length - 1, index));
  if (S.scrollMode) {
    const el = root.querySelector(`#card-${S.index}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    const top = root.querySelector("#reader-top");
    if (top) paint(ctx, root);
    return;
  }
  paint(ctx, root);
  window.scrollTo?.({ top: 0, behavior: "smooth" });
}

async function doBookmark(ctx, root) {
  const card = S.cards[S.index];
  const updated = await toggleBookmark(card.id);
  S.cards[S.index] = { ...card, ...updated };
  invalidateCardsCache();
  toast(updated.bookmarked ? "已加入书签" : "已取消书签", { type: "ok" });
  paint(ctx, root);
}

async function switchMode(ctx, root) {
  S.scrollMode = !S.scrollMode;
  writeSettings({ readMode: S.scrollMode ? "scroll" : "page" });
  toast(S.scrollMode ? "已切换为上下滚动模式" : "已切换为翻页模式", { type: "ok" });
  paint(ctx, root);
}

/** 目录侧边栏：科目 → 章节 → 卡片 */
async function showToc(ctx, root) {
  const bySubject = new Map();
  for (const [i, c] of S.cards.entries()) {
    if (!bySubject.has(c.subject)) bySubject.set(c.subject, []);
    bySubject.get(c.subject).push({ ...c, _i: i });
  }
  const html = [...bySubject.entries()]
    .map(
      ([subject, cards]) => `<div class="toc-subject">${escapeHtml(subject)}（${cards.length}）</div>
      <div class="stack">${cards
        .map(
          (c) => `<button class="toc-item ${c._i === S.index ? "toc-current" : ""}" type="button" data-act="go-card" data-id="${escapeHtml(c.id)}">
            <span class="tiny muted">${c._i + 1}</span>
            <span class="grow">${escapeHtml(truncate(c.title, 20))}</span>
            ${c.bookmarked ? "<span>🔖</span>" : ""}
          </button>`
        )
        .join("")}</div>`
    )
    .join("");
  const s = sheet({
    title: `目录（${S.cards.length} 张）`,
    body: `<div class="toc">${html}</div>`,
  });
  s.el.querySelector(".sheet-body")?.addEventListener("click", (ev) => {
    const el = ev.target.closest('[data-act="go-card"]');
    if (!el) return;
    const i = S.cards.findIndex((c) => c.id === el.dataset.id);
    s.close();
    if (i >= 0) go(ctx, root, i);
  });
}

/** 卡片内搜索（定位到匹配的卡片） */
async function cardSearch(ctx, root) {
  const action = await modal({
    title: "在本组卡片中搜索",
    body: `<div class="field"><label class="field-label" for="reader-q">关键词</label>
      <input class="input" id="reader-q" autocomplete="off" placeholder="标题 / 内容 / 标签 / 备注" /></div>`,
    actions: [
      { label: "取消", value: "cancel", kind: "btn-ghost" },
      { label: "查找", value: "go", kind: "btn" },
    ],
  });
  if (action !== "go") return;
  const q = normalizeText(document.getElementById("reader-q")?.value || "");
  if (!q) return;
  const hit = S.cards.findIndex((c) =>
    [c.title, c.summary, c.content, (c.key_points || []).join(" "), (c.common_mistakes || []).join(" "), c.note, (c.tags || []).join(" ")]
      .join(" ")
      .includes(q)
  );
  if (hit < 0) {
    toast("本组卡片中没有匹配项", { type: "warn" });
    return;
  }
  go(ctx, root, hit);
  toast(`已定位到第 ${hit + 1} 张`, { type: "ok" });
}

/* ------------------------------ 自动播放 ------------------------------ */

function startAutoPlay(ctx, root) {
  const settings = readSettings();
  const sec = Number(settings.autoPlaySec) || 10;
  const auto = settings.autoPlay === true; // 默认关闭，用户手动开启
  if (auto) {
    S.autoTimer = setInterval(() => {
      if (S.index >= S.cards.length - 1) {
        stopAutoPlay();
        paint(ctx, root);
        toast("自动播放结束", { type: "ok" });
        return;
      }
      go(ctx, root, S.index + 1);
    }, sec * 1000);
  }
}

function toggleAuto(ctx, root) {
  if (S.autoTimer) {
    stopAutoPlay();
    toast("已停止自动播放", { type: "ok" });
  } else {
    const sec = Number(readSettings().autoPlaySec) || 10;
    S.autoTimer = setInterval(() => {
      if (S.index >= S.cards.length - 1) {
        stopAutoPlay();
        paint(ctx, root);
        return;
      }
      go(ctx, root, S.index + 1);
    }, sec * 1000);
    toast(`已开始自动播放（每 ${sec} 秒翻页）`, { type: "ok" });
  }
  paint(ctx, root);
}

function stopAutoPlay() {
  if (S.autoTimer) clearInterval(S.autoTimer);
  S.autoTimer = null;
}

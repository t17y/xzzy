/**
 * 错题本页（提示词 5.5 / 六.13）
 * 自动收集的错题列表 + 按科目/知识点分组 + 薄弱知识点榜 + 一键生成错题精华卡片
 * @module views/wrong
 */

import { escapeHtml, groupBy, pct, truncate } from "../core/util.js";
import { toast, confirmDialog, modal } from "../core/dom.js";
import { navigate } from "../core/router.js";
import {
  listWrong,
  weakRanking,
  generateWrongCards,
  addCardsToReview,
  formatAnswer,
  groupWrong,
  listCards,
} from "../core/cards.js";
import { typeLabel } from "../core/level.js";
import { refreshSummary } from "../core/state.js";
import { state } from "../core/state.js";

const S = {
  filter: "", // 科目筛选
  includeResolved: false,
  busy: false,
  progress: null,
  lastReport: null,
};

export const wrongView = {
  title: "错题本",
  back: true,
  tab: null,
  async render() {
    const rows = await listWrong({ includeResolved: S.includeResolved });
    const ranking = await weakRanking(15);
    const wrongCards = await listCards({ source: "wrong" });
    const filtered = S.filter ? rows.filter((r) => r.subject === S.filter) : rows;
    const subjects = [...new Set(rows.map((r) => r.subject || "未分类"))];

    if (!rows.length && !S.includeResolved) return emptyHtml();

    const totalTimes = rows.reduce((n, r) => n + (r.times || 1), 0);

    const rowsHtml = filtered
      .slice(0, 120)
      .map(
        (r) => `<div class="card">
          <div class="row-wrap tiny">
            <span class="badge badge-red">${typeLabel(r.type)}</span>
            <span class="badge">${escapeHtml(r.subject || "未分类")}</span>
            <span class="badge">${escapeHtml(truncate(r.chapter || "—", 10))}</span>
            ${r.times > 1 ? `<span class="badge badge-gold">错 ${r.times} 次</span>` : ""}
            ${r.correct_streak ? `<span class="badge badge-green">连对 ${r.correct_streak}/3</span>` : ""}
            ${r.resolved ? '<span class="badge badge-blue">已移出</span>' : ""}
          </div>
          <p class="card-text mt">${escapeHtml(r.stem)}</p>
          <div class="row-wrap small mt">
            <span class="badge badge-red">你的答案：${escapeHtml(r.user_answer || "未作答")}</span>
            <span class="badge badge-green">正确答案：${escapeHtml(r.answer)}</span>
          </div>
          ${r.analysis ? `<p class="small muted mt">${escapeHtml(r.analysis)}</p>` : ""}
          <div class="row-wrap mt tiny muted">
            <span>所属知识点：${escapeHtml(truncate(r.item_id ? (ranking.find((x) => x.item_id === r.item_id)?.title || "—") : "—", 20))}</span>
            <span>最近错于 ${new Date(r.last_wrong_at || Date.now()).toLocaleString("zh-CN")}</span>
          </div>
        </div>`
      )
      .join("");

    const rankingHtml = ranking
      .map(
        (r, i) => `<button class="list-item" type="button" data-item="${escapeHtml(r.item_id)}">
          <span class="list-item-icon">${i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`}</span>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(truncate(r.title, 22))}</div>
            <div class="list-item-sub">${escapeHtml(r.subject)} · 错 ${r.times} 次 · 涉及 ${r.questions} 道题</div>
          </div>
          <span class="badge badge-red">${r.times}</span>
        </button>`
      )
      .join("");

    return `
    <section class="section">
      <div class="card">
        <div class="row-between">
          <div>
            <div class="tiny muted">未移出错题</div>
            <div class="strong" style="font-size:1.5rem;line-height:1.2">${rows.length}</div>
          </div>
          <div class="col" style="align-items:flex-end;gap:4px">
            <span class="badge badge-red">累计错误 ${totalTimes} 次</span>
            <span class="badge badge-gold">错题精华卡片 ${wrongCards.length} 张</span>
          </div>
        </div>
        <button class="btn btn-lg btn-block mt" type="button" data-generate ${rows.length ? "" : "disabled"}>
          ✨ 一键生成错题精华卡片
        </button>
        <p class="field-hint mt">
          自动扫描所选错题 → 提取所属知识点 → 按知识点去重聚合 → 用其要点 / 易错点 / 正文生成卡片 → 放入「错题精华」书架并加入今日复习队列。
          已生成过的知识点只做合并更新，不会重复建卡。
        </p>
        ${S.progress ? progressHtml() : ""}
        ${S.lastReport ? reportHtml() : ""}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">薄弱知识点榜</h2><span class="section-sub">按错误次数排序</span></div>
      <div class="list">${rankingHtml || '<p class="small muted">暂无数据。</p>'}</div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">错题明细</h2>
        <span class="section-sub">共 ${filtered.length} 条${filtered.length > 120 ? "（显示前 120）" : ""}</span>
      </div>
      <div class="row-wrap mb">
        ${subjects
          .map((s) => `<button class="chip ${S.filter === s ? "chip-on" : ""}" type="button" data-filter="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
          .join("")}
        ${S.filter ? '<button class="chip" type="button" data-filter="">全部</button>' : ""}
        <button class="chip ${S.includeResolved ? "chip-on" : ""}" type="button" data-resolved="1">含已移出</button>
      </div>
      <div class="stack">${rowsHtml || '<div class="note note-ok"><span>✅</span><div>当前筛选下没有错题。</div></div>'}</div>
    </section>

    <section class="section">
      <div class="card">
        <div class="kv"><div class="kv-key">移出规则</div><div class="kv-val">同一道题连续 3 次答对即移出错题本（保留历史统计）</div></div>
        <div class="kv"><div class="kv-key">错题来源</div><div class="kv-val">点/线/面关卡答错、复习测验答错，都会自动收进错题本</div></div>
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/cards?source=wrong">查看错题精华卡片</button>
          <button class="btn btn-ghost btn-sm" type="button" data-go="/learn">去关卡练习</button>
        </div>
      </div>
    </section>`;
  },

  mount(ctx, root) {
    root.addEventListener("click", async (ev) => {
      const el = ev.target.closest("[data-generate],[data-filter],[data-resolved],[data-item],[data-go]");
      if (!el) return;
      if (el.dataset.go) return navigate(el.dataset.go);
      if (el.dataset.filter !== undefined && el.hasAttribute("data-filter")) {
        S.filter = el.dataset.filter;
        return ctx.reload?.();
      }
      if (el.hasAttribute("data-resolved")) {
        S.includeResolved = !S.includeResolved;
        return ctx.reload?.();
      }
      if (el.dataset.item) {
        return showItemWrongs(el.dataset.item);
      }
      if (el.hasAttribute("data-generate")) {
        return runGenerate(ctx, root);
      }
    });
  },
};

function emptyHtml() {
  return `<section class="section"><div class="empty">
    <div class="empty-icon">❌</div>
    <div class="empty-title">错题本还是空的</div>
    <p class="empty-text">
      任何测验或复习答错都会自动记录到这里（含题目、你的答案、正确答案、解析、所属知识点与错误次数）。<br />
      有错题后即可「一键生成错题精华卡片」，把它们沉淀成可随时翻阅的卡片。
    </p>
    <div class="row-wrap" style="justify-content:center">
      <button class="btn" type="button" data-go="/learn">去关卡练习</button>
      <button class="btn btn-ghost" type="button" data-go="/review">去复习</button>
    </div>
  </div></section>`;
}

function progressHtml() {
  const p = S.progress || { done: 0, total: 1, title: "" };
  return `<div class="mt">
    <div class="row-between small"><span>正在生成：${escapeHtml(truncate(p.title, 18))}</span><span>${p.done}/${p.total}</span></div>
    <div class="progress mt"><div class="progress-fill" style="width:${pct(p.done, Math.max(1, p.total))}%"></div></div>
  </div>`;
}

function reportHtml() {
  const r = S.lastReport;
  return `<div class="note note-ok mt"><span>🎉</span><div>
    <strong>生成完成</strong>：扫描 ${r.scanned} 道错题 → 涉及 ${r.knowledgePoints} 个知识点 → 新建 ${r.created} 张、合并更新 ${r.merged} 张卡片
    ${r.queued ? `；已把 ${r.queued} 个知识点加入今日复习队列` : ""}
    <div class="row-wrap mt">
      <button class="btn btn-sm" type="button" data-go="/cards?source=wrong">立即翻阅</button>
    </div>
  </div></div>`;
}

/** 执行一键生成（带进度与完成报告） */
async function runGenerate(ctx, root) {
  if (S.busy) return;
  const rows = await listWrong();
  if (!rows.length) return toast("还没有错题可沉淀", { type: "warn" });
  const ok = await confirmDialog(
    "一键生成错题精华卡片？",
    `将扫描 ${rows.length} 道错题，按所属知识点去重聚合生成卡片，并加入今日复习队列。已生成过的知识点只做合并更新。`,
    { okLabel: "开始生成" }
  );
  if (!ok) return;
  S.busy = true;
  S.progress = { done: 0, total: rows.length, title: "准备中…" };
  const paintProgress = async () => {
    const box = root.querySelector("#view");
    if (box) {
      const holder = box.querySelector("[data-generate]")?.parentElement;
      if (holder) {
        const old = holder.querySelector(".mt");
        if (old) old.remove();
        holder.insertAdjacentHTML("beforeend", progressHtml());
      }
    }
  };
  await paintProgress();
  try {
    const result = await generateWrongCards({
      onProgress: (p) => {
        S.progress = p;
        if (p.done % 3 === 0 || p.done === p.total) paintProgress();
      },
    });
    const queued = await addCardsToReview(result.cards);
    S.lastReport = { ...result, queued: queued.queued };
    await refreshSummary();
    toast(`生成完成：新建 ${result.created} 张，合并 ${result.merged} 张`, { type: "ok" });
  } catch (err) {
    toast(`生成失败：${err.message}`, { type: "err" });
  }
  S.busy = false;
  S.progress = null;
  ctx.reload?.();
}

/** 某知识点的全部错题 */async function showItemWrongs(itemId) {
  const rows = (await listWrong({ includeResolved: true })).filter((r) => r.item_id === itemId);
  if (!rows.length) return toast("该知识点没有错题记录", { type: "warn" });
  const title = truncate(rows[0].stem, 20);
  await modal({
    title: `该知识点的错题（${rows.length}）`,
    body: rows
      .map(
        (r) => `<div class="card">
        <div class="row-wrap tiny"><span class="badge badge-red">${typeLabel(r.type)}</span>
          ${r.times > 1 ? `<span class="badge badge-gold">错 ${r.times} 次</span>` : ""}
          ${r.resolved ? '<span class="badge badge-green">已移出</span>' : ""}</div>
        <p class="card-text mt">${escapeHtml(r.stem)}</p>
        <div class="small"><span class="badge badge-red">你的答案 ${escapeHtml(r.user_answer || "—")}</span>
        <span class="badge badge-green">正确 ${escapeHtml(r.answer)}</span></div>
        ${r.analysis ? `<p class="small muted mt">${escapeHtml(r.analysis)}</p>` : ""}
      </div>`
      )
      .join(""),
    actions: [{ label: "知道了", value: "ok", kind: "btn" }],
  });
}

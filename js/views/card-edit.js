/**
 * 卡片编辑器（提示词 5.4 / 六.12）
 * 可增删改要点 / 易错点，添加个人备注；本地保存，不污染原始导入数据
 * @module views/card-edit
 */

import { escapeHtml } from "../core/util.js";
import { toast, confirmDialog } from "../core/dom.js";
import { navigate } from "../core/router.js";
import { getCard, saveCard, removeCard } from "../core/cards.js";
import { refreshSummary } from "../core/state.js";

const S = { card: null, filter: "" };

export const cardEditView = {
  title: "编辑卡片",
  back: true,
  tab: null,
  async render(ctx) {
    const id = ctx.query?.id || "";
    S.filter = ctx.query?.filter || "";
    S.card = id ? await getCard(id) : null;
    if (!S.card) {
      return `<section class="section"><div class="empty">
        <div class="empty-icon">🗂️</div><div class="empty-title">找不到这张卡片</div>
        <p class="empty-text">它可能已被删除或重新导入。</p>
        <button class="btn btn-block" type="button" data-go="/cards">回到书架</button>
      </div></section>`;
    }
    return formHtml(S.card);
  },
  mount(ctx, root) {
    root.addEventListener("click", async (ev) => {
      const el = ev.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      if (act === "add-kp") return addRow(root, "key_points");
      if (act === "add-mistake") return addRow(root, "common_mistakes");
      if (act === "del-row") return el.closest(".edit-row")?.remove();
      if (act === "save") return save(ctx, root);
      if (act === "cancel") return navigate("/cards");
      if (act === "delete") {
        const ok = await confirmDialog("删除这张卡片？", "删除后可在书架重新生成基础卡片（导入内容不受影响）。", {
          okLabel: "删除",
          danger: true,
        });
        if (!ok) return;
        await removeCard(S.card.id);
        await refreshSummary();
        toast("卡片已删除", { type: "ok" });
        navigate("/cards");
      }
      if (act === "preview") return togglePreview(root);
    });
  },
};

function formHtml(card) {
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny">
        <span class="badge ${card.source === "wrong" ? "badge-gold" : "badge-blue"}">${card.source === "wrong" ? "错题精华" : "基础卡片"}</span>
        <span class="badge">${escapeHtml(card.subject)}</span>
        <span class="badge">${escapeHtml(card.chapter || "—")}</span>
      </div>
      <h2 class="card-title mt">${escapeHtml(card.title)}</h2>
      <p class="small muted">编辑只影响这张卡片（保存在本机），不会改动你导入的 Markdown 原文。</p>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="row-between"><span class="strong">要点（卡片正面）</span>
        <button class="btn-quiet" type="button" data-act="add-kp">+ 添加</button></div>
      <div id="kp-list" class="stack mt">
        ${(card.key_points || []).map((k) => rowHtml(k)).join("") || '<p class="small muted">暂无要点，点「+ 添加」新建一条。</p>'}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="row-between"><span class="strong">易错点（卡片背面）</span>
        <button class="btn-quiet" type="button" data-act="add-mistake">+ 添加</button></div>
      <div id="mistake-list" class="stack mt">
        ${(card.common_mistakes || []).map((k) => rowHtml(k)).join("") || '<p class="small muted">暂无易错点。</p>'}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <label class="field-label" for="card-note">我的备注</label>
      <textarea class="textarea" id="card-note" rows="4" placeholder="例如：这题我总是记混，注意 XXX">${escapeHtml(card.note || "")}</textarea>
      <p class="field-hint">备注会显示在阅读页，并参与卡片搜索。</p>
      <div class="row-wrap mt">
        <button class="btn btn-ghost btn-sm" type="button" data-act="preview">👁 预览卡片</button>
      </div>
    </div>
  </section>

  <div id="card-preview" hidden></div>

  <section class="section">
    <div class="row-wrap">
      <button class="btn btn-lg grow" type="button" data-act="save">保存</button>
      <button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
      <button class="btn btn-red btn-sm" type="button" data-act="delete">删除卡片</button>
    </div>
  </section>`;
}

function rowHtml(text = "") {
  return `<div class="edit-row">
    <textarea class="textarea" rows="2" data-field="row">${escapeHtml(text)}</textarea>
    <button class="btn-quiet" type="button" data-act="del-row">删除</button>
  </div>`;
}

function addRow(root, field) {
  const list = root.querySelector(field === "key_points" ? "#kp-list" : "#mistake-list");
  if (!list) return;
  const emptyHint = list.querySelector("p.muted");
  if (emptyHint) emptyHint.remove();
  list.insertAdjacentHTML("beforeend", rowHtml(""));
  const rows = list.querySelectorAll(".edit-row textarea");
  rows[rows.length - 1]?.focus();
}

function collect(root, field) {
  const list = root.querySelector(field === "key_points" ? "#kp-list" : "#mistake-list");
  return [...(list?.querySelectorAll('[data-field="row"]') || [])]
    .map((el) => el.value.trim())
    .filter(Boolean);
}

async function save(ctx, root) {
  const card = { ...S.card };
  card.key_points = collect(root, "key_points");
  card.common_mistakes = collect(root, "common_mistakes");
  card.note = root.querySelector("#card-note")?.value.trim() || "";
  await saveCard(card);
  await refreshSummary();
  toast("卡片已保存", { type: "ok" });
  navigate("/cards");
}

function togglePreview(root) {
  const box = root.querySelector("#card-preview");
  if (!box) return;
  if (!box.hidden) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const kp = collect(root, "key_points");
  const mk = collect(root, "common_mistakes");
  const note = root.querySelector("#card-note")?.value.trim() || "";
  box.hidden = false;
  box.innerHTML = `<section class="section">
    <div class="section-head"><h2 class="section-title">预览</h2></div>
    <article class="book-page">
      <h3 class="book-title" style="font-size:1.05rem">${escapeHtml(S.card.title)}</h3>
      ${S.card.summary ? `<p class="book-summary">${escapeHtml(S.card.summary)}</p>` : ""}
      ${kp.length ? `<div class="book-face book-front"><div class="book-face-label">要点</div><ul class="tight">${kp.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul></div>` : ""}
      ${mk.length ? `<div class="book-face book-back"><div class="book-face-label">易错点</div><ul class="tight">${mk.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul></div>` : ""}
      ${note ? `<div class="note note-ok mt"><span>📌</span><div>${escapeHtml(note)}</div></div>` : ""}
    </article>
  </section>`;
  box.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

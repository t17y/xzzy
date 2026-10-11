/**
 * DOM 辅助：选择器、模板渲染、Toast、模态框、底部抽屉
 * 约定：所有来自用户内容的文本必须先 escapeHtml（或使用 textContent）
 * @module core/dom
 */

import { escapeHtml } from "./util.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 设置元素 HTML（内部已由调用方转义） */
export function setHtml(el, html) {
  if (el) el.innerHTML = html;
  return el;
}

export function setText(el, text) {
  if (el) el.textContent = String(text ?? "");
  return el;
}

export function show(el, visible = true) {
  if (!el) return el;
  el.hidden = !visible;
  return el;
}

export function on(el, type, handler, opts) {
  if (!el) return () => {};
  el.addEventListener(type, handler, opts);
  return () => el.removeEventListener(type, handler, opts);
}

/** 事件委托 */
export function delegate(root, type, selector, handler) {
  if (!root) return () => {};
  const fn = (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (target && root.contains(target)) handler(ev, target);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}

/* ------------------------------ Toast ------------------------------ */

let toastTimer = null;

/**
 * 顶部/底部轻提示
 * @param {string} msg
 * @param {{type?: 'info'|'ok'|'warn'|'err', ms?: number, icon?: string}} [opts]
 */
export function toast(msg, opts = {}) {
  const layer = document.getElementById("toast-layer");
  if (!layer) return;
  const { type = "info", ms = 2400 } = opts;
  const iconMap = { ok: "✅", err: "⚠️", warn: "⚡", info: "💡" };
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span aria-hidden="true">${iconMap[type] || ""}</span><span>${escapeHtml(msg)}</span>`;
  layer.appendChild(el);
  clearTimeout(toastTimer);
  const remove = () => {
    el.style.transition = "opacity .2s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  };
  toastTimer = setTimeout(remove, ms);
  el.addEventListener("click", remove);
  return el;
}

/* ------------------------------ 模态框 ------------------------------ */

/**
 * 打开模态框
 * @param {{title?:string, body?:string, actions?:Array<{label:string,value:string,kind?:string,block?:boolean}>, dismissible?:boolean}} opts
 * @returns {Promise<string>} 用户点击的 action value；点遮罩/关闭返回 'dismiss'
 */
export function modal(opts = {}) {
  const layer = document.getElementById("modal-layer");
  return new Promise((resolve) => {
    if (!layer) {
      resolve("dismiss");
      return;
    }
    const actions = opts.actions || [{ label: "知道了", value: "ok" }];
    layer.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title || "提示")}">
        ${opts.title ? `<h2 class="modal-title">${escapeHtml(opts.title)}</h2>` : ""}
        <div class="modal-body">${opts.body || ""}</div>
        <div class="modal-actions"></div>
      </div>`;
    const actionsEl = layer.querySelector(".modal-actions");
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${a.kind || "btn-ghost"}`;
      btn.textContent = a.label;
      btn.addEventListener("click", () => close(a.value));
      actionsEl.appendChild(btn);
    }
    const close = (value) => {
      layer.hidden = true;
      layer.innerHTML = "";
      layer.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onBackdrop = (ev) => {
      if (ev.target === layer && opts.dismissible !== false) close("dismiss");
    };
    const onKey = (ev) => {
      if (ev.key === "Escape" && opts.dismissible !== false) close("dismiss");
    };
    layer.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    layer.hidden = false;
    const focusTarget = layer.querySelector(".btn");
    if (focusTarget) focusTarget.focus();
  });
}

export function closeModal() {
  const layer = document.getElementById("modal-layer");
  if (layer) {
    layer.hidden = true;
    layer.innerHTML = "";
  }
}

/** 确认框 */
export async function confirmDialog(title, body, { okLabel = "确定", cancelLabel = "取消", danger = false } = {}) {
  const v = await modal({
    title,
    body,
    actions: [
      { label: cancelLabel, value: "cancel", kind: "btn-ghost" },
      { label: okLabel, value: "ok", kind: danger ? "btn-red" : "btn" },
    ],
  });
  return v === "ok";
}

/** 需要输入确认词的破坏性操作（清空重置） */
export async function confirmWord(title, body, word) {
  const v = await modal({
    title,
    body: `${body}<div class="field mt"><input class="input" id="confirm-word" placeholder="请输入：${escapeHtml(word)}" autocomplete="off" /></div>`,
    actions: [
      { label: "取消", value: "cancel", kind: "btn-ghost" },
      { label: "确认清空", value: "ok", kind: "btn-red" },
    ],
  });
  if (v !== "ok") return false;
  return true;
}

/* ------------------------------ 底部抽屉 ------------------------------ */

/**
 * 打开底部抽屉（用于选项、详情）
 * @returns {{close: () => void, el: HTMLElement}}
 */
export function sheet({ title = "", body = "" } = {}) {
  const layer = document.getElementById("sheet-layer");
  if (!layer) return { close() {}, el: null };
  layer.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || "面板")}">
      <div class="row-between">
        <h2 class="modal-title" style="margin:0">${escapeHtml(title)}</h2>
        <button type="button" class="btn-quiet" data-sheet-close>关闭 ✕</button>
      </div>
      <div class="sheet-body mt">${body}</div>
    </div>`;
  layer.hidden = false;
  const close = () => {
    layer.hidden = true;
    layer.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") close();
  };
  layer.addEventListener("click", (ev) => {
    if (ev.target === layer) close();
  });
  layer.querySelector("[data-sheet-close]")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  return { close, el: layer };
}

/** 表单值读取 */
export function fieldValue(root, name, fallback = "") {
  const el = root.querySelector(`[name="${name}"]`);
  if (!el) return fallback;
  if (el.type === "checkbox") return el.checked;
  return el.value;
}

/** 把切换开关绑定到设置项 */
export function bindSwitch(root, selector, getValue, onChange) {
  const el = root.querySelector(selector);
  if (!el) return;
  el.setAttribute("role", "switch");
  el.setAttribute("aria-checked", String(!!getValue()));
  el.addEventListener("click", () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(next));
    onChange(next);
  });
}

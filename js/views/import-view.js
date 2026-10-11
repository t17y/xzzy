/**
 * 导入向导（首次引导 / 导入页）：欢迎 → 选择文件 → 解析预览 → 校验 → 导入报告
 * 提示词 3.4 / 六.1 / 验收 2
 * @module views/import
 */

import { escapeHtml, pct, relTime, truncate } from "../core/util.js";
import { toast, confirmDialog } from "../core/dom.js";
import { navigate } from "../core/router.js";
import { SEV } from "../import/parse-result.js";
import { profileLabel, needsRelax } from "../import/structure.js";
import {
  analyzeFiles,
  commitImport,
  buildReport,
  downloadText,
  fetchTemplate,
  previewSummary,
  outlineTree,
  fileKind,
  recentImports,
} from "../import/pipeline.js";
import { refreshSummary } from "../core/state.js";
import { removeImport } from "../core/db.js";

const STEPS = [
  { key: "welcome", label: "模板" },
  { key: "files", label: "选择文件" },
  { key: "preview", label: "解析预览" },
  { key: "report", label: "导入报告" },
];

/** 向导状态（单次会话内有效，离开页面即重置） */
const st = {
  step: "welcome",
  files: [],
  merged: null,
  commit: null,
  mode: "strict", // strict | relaxed
  profile: "auto",
  busy: false,
  error: "",
};

export const importView = {
  title: "导入学习内容",
  back: true,
  tab: null,
  async render() {
    return shell(st.step);
  },
  async mount(ctx, root) {
    bind(ctx, root);
  },
  unmount() {
    // 离开页面重置向导，避免下次进入残留上一次的解析结果
    Object.assign(st, { step: "welcome", files: [], merged: null, commit: null, busy: false, error: "" });
  },
};

/* ------------------------------ 骨架 ------------------------------ */

function shell(step) {
  return `
  <div class="wizard-steps">
    ${STEPS.map((s, i) => {
      const idx = STEPS.findIndex((x) => x.key === step);
      const state = i === idx ? "active" : i < idx ? "done" : "todo";
      return `<span class="wizard-step" data-state="${state}"><span class="wizard-dot">${i + 1}</span>${s.label}</span>${
        i < STEPS.length - 1 ? '<span class="muted tiny">›</span>' : ""
      }`;
    }).join("")}
  </div>
  <div id="wizard-body"></div>`;
}

function bind(ctx, root) {
  const body = root.querySelector("#wizard-body");
  if (!body) return;
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "template") return downloadTemplate(el.dataset.kind || "md");
    if (action === "to-files") return go(ctx, root, "files");
    if (action === "to-welcome") return go(ctx, root, "welcome");
    if (action === "pick") return root.querySelector("#file-input")?.click();
    if (action === "clear-files") {
      st.files = [];
      st.merged = null;
      return paint(ctx, root, "files");
    }
    if (action === "parse") return runParse(ctx, root);
    if (action === "toggle-mode") {
      st.mode = st.mode === "strict" ? "relaxed" : "strict";
      return runParse(ctx, root);
    }
    if (action === "commit") return runCommit(ctx, root);
    if (action === "restart") {
      Object.assign(st, { step: "welcome", files: [], merged: null, commit: null, error: "" });
      return paint(ctx, root, "welcome");
    }
    if (action === "go-home") return navigate("/home");
    if (action === "go-learn") return navigate("/learn");
    if (action === "remove-import") {
      const id = el.dataset.id;
      const ok = await confirmDialog("删除这次导入？", "将删除该次导入产生的知识点与题目（复习记录、卡片不受影响的除外）。此操作不可撤销。", {
        okLabel: "删除",
        danger: true,
      });
      if (!ok) return;
      await removeImport(id);
      await refreshSummary();
      toast("已删除该次导入", { type: "ok" });
      return paint(ctx, root, st.step);
    }
  });

  root.addEventListener("change", async (ev) => {
    const el = ev.target;
    if (el.id === "file-input") {
      st.files = Array.from(el.files || []);
      st.merged = null;
      st.commit = null;
      return paint(ctx, root, st.files.length ? "files" : "welcome");
    }
    if (el.id === "mode-select") {
      st.mode = el.value;
      return runParse(ctx, root);
    }
  });

  // 拖拽上传
  const dz = root.querySelector("#dropzone");
  if (dz) {
    for (const type of ["dragenter", "dragover"]) {
      dz.addEventListener(type, (ev) => {
        ev.preventDefault();
        dz.dataset.over = "1";
      });
    }
    for (const type of ["dragleave", "drop"]) {
      dz.addEventListener(type, (ev) => {
        ev.preventDefault();
        dz.dataset.over = "0";
      });
    }
    dz.addEventListener("drop", (ev) => {
      const dropped = Array.from(ev.dataTransfer?.files || []);
      if (dropped.length) {
        st.files = dropped;
        st.merged = null;
        paint(ctx, root, "files");
      }
    });
  }

  paint(ctx, root, st.step);
}

function go(ctx, root, step) {
  paint(ctx, root, step);
}

function paint(ctx, root, step) {
  st.step = step;
  const body = root.querySelector("#wizard-body");
  const steps = root.querySelector(".wizard-steps");
  if (steps) {
    const idx = STEPS.findIndex((x) => x.key === step);
    steps.innerHTML = STEPS.map((s, i) => {
      const state = i === idx ? "active" : i < idx ? "done" : "todo";
      return `<span class="wizard-step" data-state="${state}"><span class="wizard-dot">${i + 1}</span>${s.label}</span>${
        i < STEPS.length - 1 ? '<span class="muted tiny">›</span>' : ""
      }`;
    }).join("");
  }
  if (!body) return;
  if (step === "welcome") {
    body.innerHTML = welcomeHtml();
    paintRecent(root);
  } else if (step === "files") body.innerHTML = filesHtml();
  else if (step === "preview") body.innerHTML = previewHtml();
  else if (step === "report") body.innerHTML = reportHtml();
}

/* ------------------------------ 步骤 1：模板 ------------------------------ */

function welcomeHtml() {
  return `
  <section class="section">
    <div class="card">
      <div class="card-head"><span style="font-size:1.4rem">📄</span><h2 class="card-title">第一步：下载《内容导入模板.md》</h2></div>
      <p class="card-text">
        本应用不内置任何题库，所有内容来自你的 Markdown 文件。模板中的示例行全部标注「仅格式示例」，请替换为你自己的学习内容。
      </p>
      <div class="note mt">
        <span>💡</span>
        <div><strong>一句话规则：</strong><code>#</code>=科目，<code>##</code>=章节，<code>###</code>=知识点；知识点下用「要点 / 易错点 / 题目」区块。</div>
      </div>
      <div class="row-wrap mt">
        <button class="btn" type="button" data-action="template" data-kind="md">⬇️ 下载 Markdown 模板</button>
        <button class="btn btn-ghost" type="button" data-action="template" data-kind="csv">CSV 模板</button>
        <button class="btn btn-ghost" type="button" data-action="template" data-kind="json">JSON 模板</button>
        <button class="btn btn-ghost" type="button" data-go="/guide">📘 编写规范说明</button>
      </div>
      <p class="small muted mt">模板与说明文件随应用一起离线可用，无需联网。</p>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="card-head"><span style="font-size:1.4rem">📥</span><h2 class="card-title">第二步：选择文件</h2></div>
      <p class="card-text">一次可以选择多个 <code>.md</code> 文件（一个文件也可以包含多个科目）。也支持兼容格式 <code>.csv</code> / <code>.xlsx</code> / <code>.json</code>。</p>
      <button class="btn btn-block mt" type="button" data-action="to-files">开始选择文件 →</button>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">最近导入</h2></div>
    <div id="recent-imports" class="card"><p class="muted small">加载中…</p></div>
  </section>`;
}

/* ------------------------------ 步骤 2：选择文件 ------------------------------ */

function filesHtml() {
  const list = st.files
    .map(
      (f, i) => `
      <div class="file-chip">
        <span>${kindIcon(fileKind(f.name))}</span>
        <span class="grow nowrap" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.name)}</span>
        <span class="badge">${(f.size / 1024).toFixed(1)} KB</span>
      </div>`
    )
    .join("");
  return `
  <section class="section">
    <div class="dropzone" id="dropzone">
      <div class="dropzone-icon">📂</div>
      <div class="strong">点击选择或把文件拖到这里</div>
      <p class="small muted">支持 .md（主格式，可多选）· .csv · .xlsx · .json</p>
      <button class="btn" type="button" data-action="pick">选择文件</button>
      <input id="file-input" type="file" multiple accept=".md,.markdown,.csv,.tsv,.xlsx,.xls,.json,text/markdown,text/plain" hidden />
    </div>
  </section>

  ${
    st.files.length
      ? `<section class="section">
          <div class="section-head"><h2 class="section-title">已选择 ${st.files.length} 个文件</h2>
          <button class="btn-quiet" type="button" data-action="clear-files">清空</button></div>
          <div class="file-list">${list}</div>
        </section>
        <section class="section">
          <label class="field-label" for="mode-select">解析模式</label>
          <select class="select" id="mode-select">
            <option value="strict" ${st.mode === "strict" ? "selected" : ""}>严格模式（按《Markdown 内容规范》，推荐）</option>
            <option value="relaxed" ${st.mode === "relaxed" ? "selected" : ""}>宽松模式（把加粗标题 / 列表项也识别为知识点）</option>
          </select>
          <p class="field-hint">笔记里没有 <code>###</code> 知识点标题时（例如 PDF / 导图转录稿），可试试宽松模式；解析前会显示识别结果，不满意可随时切回。</p>
          <button class="btn btn-lg btn-block mt" type="button" data-action="parse">🔍 解析并预览</button>
        </section>`
      : `<section class="section"><div class="note note-warn"><span>⚠️</span><div>还没有选择文件。可以点上面的「选择文件」，或先下载模板填写内容。</div></div>
         <button class="btn btn-ghost btn-block mt" type="button" data-action="to-welcome">← 返回下载模板</button></section>`
  }`;
}

/* ------------------------------ 步骤 3：预览 + 校验 ------------------------------ */

function previewHtml() {
  if (st.error) {
    return `<section class="section"><div class="note note-error"><span>⛔</span><div>${escapeHtml(st.error)}</div></div>
      <button class="btn btn-ghost btn-block mt" type="button" data-action="to-files">← 重新选择文件</button></section>`;
  }
  if (st.busy) return busyHtml("正在解析文件…");
  if (!st.merged) return `<section class="section"><p class="muted">尚未解析。</p></section>`;

  const s = previewSummary(st.merged);
  const report = buildReport(st.merged);
  const tree = outlineTree(st.merged, 300);
  const treeHtml = tree
    .map((n) =>
      n.kind === "subject"
        ? `<div class="subj">📘 ${escapeHtml(n.text)}</div>`
        : n.kind === "chapter"
          ? `<div class="chap">└ ${escapeHtml(n.text)}</div>`
          : `<div class="item">• ${escapeHtml(n.text)}</div>`
    )
    .join("");
  const types = Object.entries(s.typeCounts)
    .map(([k, v]) => `<span class="badge badge-blue">${typeLabel(k)} ${v}</span>`)
    .join(" ");
  const modeNote =
    st.mode === "relaxed"
      ? "当前为宽松模式：加粗标题 / 顶层列表项也会生成知识点，命中内容会在下方「结构识别」里说明。"
      : "当前为严格模式：只有 <code>###</code> 三级标题会生成知识点。若知识点数量明显偏少，可切换到宽松模式再试。";

  return `
  <section class="section">
    <div class="note ${st.mode === "relaxed" ? "note-warn" : ""}"><span>🧭</span><div>${modeNote}</div></div>
  </section>

  <section class="section">
    <div class="stats">
      <div class="stat"><div class="stat-value">${s.itemCount}</div><div class="stat-label">知识点</div></div>
      <div class="stat"><div class="stat-value">${s.questionCount}</div><div class="stat-label">题目</div></div>
      <div class="stat"><div class="stat-value">${s.subjects.length}</div><div class="stat-label">科目</div></div>
      <div class="stat"><div class="stat-value">${s.keyPoints}</div><div class="stat-label">要点</div></div>
      <div class="stat"><div class="stat-value">${s.mistakes}</div><div class="stat-label">易错点</div></div>
      <div class="stat"><div class="stat-value" style="color:${s.errors ? "var(--red)" : "inherit"}">${s.errors}</div><div class="stat-label">错误</div></div>
      <div class="stat"><div class="stat-value" style="color:${s.warnings ? "var(--orange)" : "inherit"}">${s.warnings}</div><div class="stat-label">警告</div></div>
      <div class="stat"><div class="stat-value">${s.duplicateItems}</div><div class="stat-label">已存在</div></div>
    </div>
    ${types ? `<div class="row-wrap mt">${types}</div>` : ""}
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">结构预览</h2><span class="section-sub">科目 ${s.subjects.length} · 共 ${s.itemCount} 个知识点</span></div>
    <div class="preview-tree">${treeHtml || '<p class="muted small">没有解析到任何知识点。</p>'}</div>
    <p class="field-hint">此处仅展示前 300 个知识点，导入后全部可用。</p>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">校验报告</h2>
      <span class="section-sub">错误 ${report.errors.length} · 警告 ${report.warnings.length} · 提示 ${report.infos.length}</span></div>
    ${issuesHtml(report)}
  </section>

  <section class="section">
    <div class="row-wrap">
      <button class="btn btn-lg grow" type="button" data-action="commit" ${s.itemCount ? "" : "disabled"}>
        ✅ 确认导入（${s.itemCount} 知识点 / ${s.questionCount} 题）
      </button>
      <button class="btn btn-ghost" type="button" data-action="toggle-mode">切换${
        st.mode === "strict" ? "宽松" : "严格"
      }模式</button>
      <button class="btn btn-ghost" type="button" data-action="to-files">重选文件</button>
    </div>
    ${
      s.errors
        ? `<div class="note note-error mt"><span>⛔</span><div>存在 ${s.errors} 条错误：这些条目会被跳过（题目缺答案 / 答案格式非法 / 缺少层级等），其余内容仍可正常导入。</div></div>`
        : ""
    }
  </section>`;
}

function issuesHtml(report) {
  const rows = [
    ...report.errors.map((i) => issueRow(i, "error")),
    ...report.warnings.slice(0, 60).map((i) => issueRow(i, "warn")),
    ...report.infos.slice(0, 20).map((i) => issueRow(i, "info")),
  ];
  if (!rows.length) return `<div class="note note-ok"><span>✅</span><div>校验通过，没有发现问题。</div></div>`;
  const more =
    report.warnings.length > 60 ? `<p class="small muted">另有 ${report.warnings.length - 60} 条警告未展开显示。</p>` : "";
  return `<div>${rows.join("")}</div>${more}`;
}

function issueRow(i, kind) {
  const loc = [i.file, i.line ? `第 ${i.line} 行` : "", i.title ? `知识点：${i.title}` : "", i.question ? `题目：${i.question}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<div class="issue issue-${kind}">
    <div>${escapeHtml(i.message)}</div>
    ${loc ? `<div class="issue-loc">${escapeHtml(loc)}</div>` : ""}
  </div>`;
}

/* ------------------------------ 步骤 4：导入报告 ------------------------------ */

function reportHtml() {
  if (st.busy) return busyHtml("正在写入本地数据库…");
  const c = st.commit;
  if (!c) return `<section class="section"><p class="muted">尚未导入。</p></section>`;
  const report = st.merged ? buildReport(st.merged) : { errors: [], warnings: [], infos: [] };
  const errRows = report.errors.map((i) => issueRow(i, "error")).join("") || '<p class="small muted">没有错误。</p>';
  const warnRows = report.warnings.slice(0, 40).map((i) => issueRow(i, "warn")).join("") || '<p class="small muted">没有警告。</p>';

  return `
  <section class="section">
    <div class="card center">
      <div style="font-size:56px">🎉</div>
      <h2 class="card-title">导入完成</h2>
      <p class="card-text">成功写入 ${c.items} 个知识点、${c.questions} 道题，用时 ${c.durationMs} ms。</p>
      <div class="row-wrap mt" style="justify-content:center">
        ${(c.subjects || []).map((s) => `<span class="badge badge-green">${escapeHtml(s)}</span>`).join("")}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="stats">
      <div class="stat"><div class="stat-value">${c.items}</div><div class="stat-label">知识点入库</div></div>
      <div class="stat"><div class="stat-value">${c.questions}</div><div class="stat-label">题目入库</div></div>
      <div class="stat"><div class="stat-value">${c.skipped?.length || 0}</div><div class="stat-label">跳过条目</div></div>
      <div class="stat"><div class="stat-value">${report.errors.length}</div><div class="stat-label">错误</div></div>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">失败明细（错误）</h2></div>
    <div>${errRows}</div>
  </section>

  <section class="section">
    <details class="acc">
      <summary>警告明细（${report.warnings.length}）</summary>
      <div>${warnRows}</div>
    </details>
    <details class="acc">
      <summary>解析说明（${report.infos.length}）</summary>
      <div>${report.infos.slice(0, 30).map((i) => issueRow(i, "info")).join("") || '<p class="small muted">无。</p>'}</div>
    </details>
  </section>

  <section class="section">
    <div class="row-wrap">
      <button class="btn btn-lg grow" type="button" data-action="go-home">回到首页</button>
      <button class="btn btn-ghost" type="button" data-action="go-learn">查看科目</button>
      <button class="btn btn-ghost" type="button" data-action="restart">再导入其他文件</button>
    </div>
  </section>`;
}

function busyHtml(text) {
  return `<section class="section"><div class="card center">
    <div style="font-size:40px">⏳</div>
    <div class="strong">${escapeHtml(text)}</div>
    <div class="progress mt"><div class="progress-fill" style="width:100%"></div></div>
  </div></section>`;
}

/* ------------------------------ 动作 ------------------------------ */

async function downloadTemplate(kind) {
  try {
    const text = await fetchTemplate(kind);
    const name = { md: "内容导入模板.md", csv: "内容导入模板.csv", json: "内容导入模板.json" }[kind];
    downloadText(name, text, kind === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8");
    toast(`已开始下载 ${name}`, { type: "ok" });
  } catch (err) {
    toast(`模板下载失败：${err.message}`, { type: "err" });
  }
}

async function runParse(ctx, root) {
  if (!st.files.length) {
    toast("请先选择至少一个文件", { type: "warn" });
    return;
  }
  st.busy = true;
  st.error = "";
  paint(ctx, root, "preview");
  try {
    const unknown = st.files.filter((f) => fileKind(f.name) === "unknown");
    const usable = st.files.filter((f) => fileKind(f.name) !== "unknown");
    if (unknown.length && !usable.length) {
      throw new Error(`不支持的文件类型：${unknown.map((f) => f.name).join("、")}。支持 .md / .csv / .xlsx / .json。`);
    }
    if (unknown.length) toast(`已跳过 ${unknown.length} 个不支持的文件`, { type: "warn" });
    const { merged } = await analyzeFiles(usable, { mode: st.mode, profile: st.profile });
    st.merged = merged;
    st.busy = false;
    const s = previewSummary(merged);
    if (!s.itemCount) {
      st.error =
        st.mode === "strict"
          ? "严格模式下没有解析到知识点：你的文件可能缺少 ### 三级标题。可以切换到「宽松模式」，或按模板补全标题层级。"
          : "没有解析到任何知识点，请检查文件内容是否为 Markdown 标题结构。";
    }
  } catch (err) {
    st.busy = false;
    st.error = err.message || String(err);
  }
  paint(ctx, root, "preview");
}

async function runCommit(ctx, root) {
  st.busy = true;
  paint(ctx, root, "report");
  try {
    const result = await commitImport(st.merged, { sourceNames: st.files.map((f) => f.name) });
    st.commit = result;
    await refreshSummary();
    toast(`导入成功：${result.items} 知识点 / ${result.questions} 题`, { type: "ok" });
  } catch (err) {
    st.busy = false;
    st.step = "preview";
    toast(`导入失败：${err.message}`, { type: "err" });
    paint(ctx, root, "preview");
    return;
  }
  st.busy = false;
  paint(ctx, root, "report");
}

/* ------------------------------ 小工具 ------------------------------ */

function kindIcon(kind) {
  return { markdown: "📝", csv: "📄", xlsx: "📊", json: "🧾", unknown: "❓" }[kind] || "📄";
}

function typeLabel(type) {
  return { single: "单选", multi: "多选", tf: "判断", match: "配伍" }[type] || type;
}

// 最近导入列表异步填充（不阻塞首屏）
async function paintRecent(root) {
  const box = root.querySelector("#recent-imports");
  if (!box) return;
  const list = await recentImports(5);
  if (!list.length) {
    box.innerHTML = '<p class="muted small">还没有导入记录。下载模板 → 选择文件 → 解析预览 → 导入。</p>';
    return;
  }
  box.innerHTML = list
    .map(
      (m) => `
      <div class="row-between" style="padding:6px 0;border-bottom:1px dashed var(--border)">
        <div class="grow" style="min-width:0">
          <div class="nowrap" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml((m.files || []).join("、") || "未命名导入")}</div>
          <div class="small muted">${m.items} 知识点 · ${m.questions} 题 · ${relTime(m.created_at)}</div>
        </div>
        <button class="btn-quiet" type="button" data-action="remove-import" data-id="${m.id}">删除</button>
      </div>`
    )
    .join("");
}

export { fileKind, truncate, pct };

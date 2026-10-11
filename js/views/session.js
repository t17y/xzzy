/**
 * 关卡会话页（点 / 线 / 面 共用的测验运行时）
 * 交互类型：card（学习卡）/ single·multi·tf·match（题目）/ order（排序）/ match-pairs（连线）/ compare（对比选择）
 * 提示词 5.1、5.2：即时反馈、红心扣减、连击统计、结算页
 * @module views/session
 */

import { escapeHtml, mdToHtml, normalizeText, truncate } from "../core/util.js";
import { toast, confirmDialog } from "../core/dom.js";
import { navigate } from "../core/router.js";
import {
  buildSession,
  gradeStep,
  accumulate,
  sessionTotal,
  previewStars,
  toSettleInput,
  typeLabel,
  LINE_KINDS,
  NODE_META,
} from "../core/level.js";
import { loadGame, markCardSeen, setHearts, settleNode, settleCardOnly } from "../core/game.js";
import { listItems, readSettings } from "../core/db.js";
import { refreshSummary } from "../core/state.js";
import { EV, emit } from "../core/events.js";

/** 会话状态（单页面生命周期内） */
const S = {
  session: null,
  idx: 0,
  phase: "answer", // answer | feedback
  last: null, // 上一步判分结果
  pending: null, // 当前作答缓存（题目选项 / 排序 / 配对 / 对比）
  combo: 0,
  hearts: 0,
  heartsMax: 5,
  sound: true,
  titleMap: new Map(),
  busy: false,
  finished: false,
  result: null,
  node: null,
};

export const sessionView = {
  title: "关卡",
  back: true,
  tab: null,
  async render(ctx) {
    S.node = ctx.query?.node ? JSON.parse(decodeURIComponent(ctx.query.node)) : null;
    if (!S.node) {
      return `<section class="section"><div class="empty">
        <div class="empty-icon">🧭</div><div class="empty-title">缺少关卡信息</div>
        <p class="empty-text">请从科目路径进入关卡。</p>
        <button class="btn btn-block" type="button" data-go="/learn">返回关卡地图</button>
      </div></section>`;
    }
    if (!S.session || S.session.nodeKey !== S.node.nodeKey) {
      await startSession(S.node);
    }
    return shell();
  },
  async mount(ctx, root) {
    bind(ctx, root);
    paint(ctx, root);
  },
  unmount() {
    S.session = null;
    S.idx = 0;
    S.phase = "answer";
    S.last = null;
    S.pending = null;
    S.combo = 0;
    S.finished = false;
    S.result = null;
  },
};

/* ------------------------------ 会话启动 ------------------------------ */

async function startSession(node) {
  const settings = readSettings();
  const game = await loadGame();
  S.session = await buildSession(node, { maxQuestions: node.type === "face" ? 8 : 3 });
  S.idx = 0;
  S.phase = "answer";
  S.last = null;
  S.pending = null;
  S.combo = 0;
  S.hearts = game.hearts.hearts;
  S.heartsMax = game.hearts.max;
  S.sound = settings.sound !== false;
  S.finished = false;
  S.result = null;
  S.session.correctCount = 0;
  S.session.pointsEarned = 0;
  S.session.combo = 0;
  S.session.maxCombo = 0;
  S.session.mistakes = [];
  S.session.answers = {};
  S.session.hasQuestions = S.session.steps.some((s) => s.kind !== "card");

  // 关联知识点标题表（学习卡上显示「关联」）
  const items = await listItems(node.subject);
  S.titleMap = new Map(items.map((i) => [i.id, i.title]));
  // 学习卡第一次进入即计为「学习新卡」
  for (const st of S.session.steps) {
    if (st.kind === "card") st.isNew = true;
  }
}

function step() {
  return S.session?.steps[S.idx] || null;
}

function totalSteps() {
  return S.session?.steps.length || 0;
}

/* ------------------------------ 骨架 ------------------------------ */

function shell() {
  return `
  <div id="quiz-top" class="quiz-top"></div>
  <div id="quiz-body"></div>
  <div id="quiz-foot" class="quiz-foot"></div>`;
}

function bind(ctx, root) {
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-act]");
    if (el) {
      const act = el.dataset.act;
      if (act === "option") return pickOption(el.dataset.key);
      if (act === "order-pick") return pickOrder(Number(el.dataset.index));
      if (act === "order-undo") return undoOrder();
      if (act === "match-left") return pickMatch("left", el.dataset.id, root);
      if (act === "match-right") return pickMatch("right", el.dataset.id, root);
      if (act === "match-reset") {
        S.pending = { pairs: [], leftSel: null, rightSel: null };
        return paint(ctx, root);
      }
      if (act === "compare-pick") return pickCompare(el.dataset.item, el.dataset.answer);
      if (act === "submit") return submit(ctx, root);
      if (act === "continue") return next(ctx, root);
      if (act === "learned") return markLearned(ctx, root);
      if (act === "restart") {
        await startSession(S.node);
        return paint(ctx, root);
      }
      if (act === "back-map") return navigate("/learn", { subject: S.session?.subject || "" });
      if (act === "retry-mistakes") return retryMistakes(ctx, root);
      if (act === "show-answer") return showAnswer();
      return;
    }
  });
}

/* ------------------------------ 渲染 ------------------------------ */

function paint(ctx, root) {
  const top = root.querySelector("#quiz-top");
  const body = root.querySelector("#quiz-body");
  const foot = root.querySelector("#quiz-foot");
  if (!top || !body || !foot) return;

  if (S.finished) {
    top.innerHTML = "";
    body.innerHTML = resultHtml();
    foot.innerHTML = `<div class="row-wrap">
      <button class="btn btn-lg grow" type="button" data-act="back-map">回到关卡地图</button>
      <button class="btn btn-ghost" type="button" data-act="restart">再练一次</button>
      ${S.session.mistakes.length ? '<button class="btn btn-ghost" type="button" data-act="retry-mistakes">重练错题</button>' : ""}
    </div>`;
    return;
  }

  const st = step();
  if (!st) {
    // 该关卡没有可作答步骤（例如知识点没有题目）
    top.innerHTML = "";
    body.innerHTML = emptyStepsHtml();
    foot.innerHTML = `<div class="row-wrap">
      <button class="btn btn-lg grow" type="button" data-act="back-map">回到关卡地图</button>
      <button class="btn btn-ghost" type="button" data-go="/import">去补充题目</button>
    </div>`;
    return;
  }

  top.innerHTML = topHtml(st);
  body.innerHTML = stepHtml(st);
  foot.innerHTML = footHtml(st);
}

function topHtml(st) {
  const stars = previewStars(S.session);
  const hearts = Array.from({ length: S.heartsMax }, (_, i) => (i < S.hearts ? "❤️" : "🖤")).join("");
  const kindName = st.kind === "card" ? "学习卡" : st.kind === "question" ? typeLabel(st.type) : LINE_KINDS[st.kind]?.name || "练习";
  return `
  <div class="row-between">
    <span class="badge badge-blue">${escapeHtml(NODE_META[S.session.nodeType]?.name || "关卡")} · ${escapeHtml(kindName)}</span>
    <span class="nowrap" style="letter-spacing:1px">${hearts}</span>
  </div>
  <div class="progress mt"><div class="progress-fill" style="width:${Math.round((S.idx / Math.max(1, totalSteps())) * 100)}%"></div></div>
  <div class="row-between mt tiny muted">
    <span>第 ${S.idx + 1} / ${totalSteps()} 步</span>
    <span>连击 ${S.combo} · 预计 ${"★".repeat(stars)}${"☆".repeat(3 - stars)}</span>
  </div>`;
}

function stepHtml(st) {
  if (st.kind === "card") return cardHtml(st);
  if (st.kind === "question") return questionHtml(st);
  if (st.kind === "order") return orderHtml(st);
  if (st.kind === "match") return matchHtml(st);
  if (st.kind === "compare") return compareHtml(st);
  return '<p class="muted">未知步骤</p>';
}

function cardHtml(st) {
  const related = (st.relatedIds || []).map((id) => S.titleMap.get(id)).filter(Boolean);
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny">
        <span class="badge badge-green">难度 ${st.difficulty}</span>
        <span class="badge">${escapeHtml(st.subject)}</span>
        <span class="badge">${escapeHtml(st.chapter)}</span>
        ${st.isNew ? '<span class="badge badge-gold">新卡片 +10 XP</span>' : ""}
      </div>
      <h2 class="card-title mt">${escapeHtml(st.title)}</h2>
      <div class="md-body">${st.content ? mdToHtml(st.content) : '<p class="muted">（此知识点没有正文）</p>'}</div>
      ${
        st.keyPoints?.length
          ? `<div class="note note-ok mt"><span>🔑</span><div><strong>要点</strong><ul class="tight">${st.keyPoints
              .map((k) => `<li>${escapeHtml(k)}</li>`)
              .join("")}</ul></div></div>`
          : ""
      }
      ${
        st.mistakes?.length
          ? `<div class="note note-warn mt"><span>⚠️</span><div><strong>易错点</strong><ul class="tight">${st.mistakes
              .map((k) => `<li>${escapeHtml(k)}</li>`)
              .join("")}</ul></div></div>`
          : ""
      }
      ${related.length ? `<p class="small muted mt">关联知识点：${related.map(escapeHtml).join("、")}</p>` : ""}
      ${st.tags?.length ? `<div class="row-wrap mt">${st.tags.map((t) => `<span class="badge badge-purple">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    </div>
  </section>`;
}

function questionHtml(st) {
  const answered = S.phase === "feedback";
  const sel = S.pending || (st.type === "multi" ? [] : "");
  const opts = st.options.length
    ? st.options
    : [
        { key: "对", text: "对" },
        { key: "错", text: "错" },
      ];
  const expected = new Set(
    normalizeText(st.answer)
      .split(/[,，、;；\s]+/)
      .map((s) => s.toUpperCase())
  );
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny">
        <span class="badge badge-blue">${typeLabel(st.type)}</span>
        <span class="badge">难度 ${st.difficulty}</span>
        ${st.line ? `<span class="badge">第 ${st.line} 行</span>` : ""}
      </div>
      <h2 class="card-title mt" style="font-size:1.05rem">${escapeHtml(st.stem)}</h2>
      ${st.type === "multi" ? '<p class="small muted">多选题：可选择多个选项</p>' : ""}
      <div class="stack mt">
        ${opts
          .map((o) => {
            const key = o.key.toUpperCase();
            const isSel = st.type === "multi" ? (sel || []).includes(key) : sel === key;
            const isRight = expected.has(key);
            let cls = "opt";
            if (answered) {
              if (isRight) cls += " opt-right";
              else if (isSel) cls += " opt-wrong";
            } else if (isSel) cls += " opt-sel";
            return `<button class="${cls}" type="button" data-act="option" data-key="${escapeHtml(key)}" ${
              answered ? "disabled" : ""
            }>
              <span class="opt-key">${escapeHtml(key)}</span>
              <span class="grow">${escapeHtml(o.text)}</span>
              ${answered && isRight ? "<span>✅</span>" : ""}
              ${answered && isSel && !isRight ? "<span>❌</span>" : ""}
            </button>`;
          })
          .join("")}
      </div>
      ${
        answered
          ? `<div class="note ${S.last?.correct ? "note-ok" : "note-error"} mt">
              <span>${S.last?.correct ? "✅" : "❌"}</span>
              <div>
                <strong>${S.last?.correct ? "回答正确" : `正确答案：${escapeHtml(st.answer)}`}</strong>
                ${st.analysis ? `<div class="mt small">${escapeHtml(st.analysis)}</div>` : ""}
              </div>
            </div>`
          : ""
      }
    </div>
  </section>`;
}

function orderHtml(st) {
  const picked = S.pending?.order || [];
  const answered = S.phase === "feedback";
  const remaining = st.options.filter((o) => !picked.includes(o.id));
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny"><span class="badge badge-purple">${LINE_KINDS.order.name}</span><span class="badge">${escapeHtml(S.session.chapter)}</span></div>
      <h2 class="card-title mt" style="font-size:1.05rem">${escapeHtml(st.prompt)}</h2>
      <div class="stack mt">
        ${picked
          .map((id, i) => {
            const o = st.options.find((x) => x.id === id);
            const rightOrder = answered && st.correct[i] === id;
            return `<div class="opt ${answered ? (rightOrder ? "opt-right" : "opt-wrong") : "opt-sel"}">
              <span class="opt-key">${i + 1}</span>
              <span class="grow">${escapeHtml(o?.text || "")}</span>
              ${answered ? `<span>${rightOrder ? "✅" : `应为 ${escapeHtml(st.options.find((x) => x.id === st.correct[i])?.text || "")}`}</span>` : ""}
            </div>`;
          })
          .join("") || '<p class="small muted">点下面的条目依次放入</p>'}
      </div>
      ${
        answered
          ? `<div class="note ${S.last?.correct ? "note-ok" : "note-error"} mt"><span>${S.last?.correct ? "✅" : "❌"}</span>
              <div><strong>正确顺序</strong><ol class="tight">${st.correct.map((id) => `<li>${escapeHtml(st.options.find((x) => x.id === id)?.text || "")}</li>`).join("")}</ol></div></div>`
          : `<div class="row-wrap mt">
              ${remaining
                .map(
                  (o, i) => `<button class="btn btn-ghost btn-sm" type="button" data-act="order-pick" data-index="${st.options.indexOf(o)}">${escapeHtml(o.text)}</button>`
                )
                .join("")}
              ${picked.length ? '<button class="btn-quiet" type="button" data-act="order-undo">撤销上一个</button>' : ""}
            </div>`
      }
    </div>
  </section>`;
}

function matchHtml(st) {
  const pairs = S.pending?.pairs || [];
  const leftSel = S.pending?.leftSel || null;
  const rightSel = S.pending?.rightSel || null;
  const answered = S.phase === "feedback";
  const usedLeft = new Set(pairs.map((p) => p.left));
  const usedRight = new Set(pairs.map((p) => p.right));
  const correctSet = new Set(st.correct.map((p) => `${p.left}=${p.right}`));
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny"><span class="badge badge-purple">${LINE_KINDS.match.name}</span><span class="badge">${escapeHtml(S.session.chapter)}</span></div>
      <h2 class="card-title mt" style="font-size:1.05rem">${escapeHtml(st.prompt)}</h2>
      ${
        pairs.length
          ? `<div class="stack mt">${pairs
              .map((p) => {
                const ok = correctSet.has(`${p.left}=${p.right}`);
                const lt = st.left.find((x) => x.id === p.left)?.text || "";
                const rt = st.right.find((x) => x.id === p.right)?.text || "";
                return `<div class="opt ${answered ? (ok ? "opt-right" : "opt-wrong") : "opt-sel"}">
                  <span class="grow">${escapeHtml(lt)} ↔ ${escapeHtml(rt)}</span>${answered ? `<span>${ok ? "✅" : "❌"}</span>` : ""}
                </div>`;
              })
              .join("")}</div>`
          : ""
      }
      ${
        answered
          ? `<div class="stack mt">${st.correct
              .map((c) => {
                const lt = st.left.find((x) => x.id === c.left)?.text || "";
                const rt = st.right.find((x) => x.id === c.right)?.text || "";
                return `<div class="opt opt-right"><span class="grow">${escapeHtml(lt)} ↔ ${escapeHtml(rt)}</span><span>✅</span></div>`;
              })
              .join("")}</div>`
          : `<div class="match-grid mt">
              <div class="stack">
                ${st.left
                  .map((o) => {
                    const used = usedLeft.has(o.id);
                    const cls = `opt ${leftSel === o.id ? "opt-sel" : ""} ${used ? "opt-done" : ""}`;
                    return `<button class="${cls}" type="button" data-act="match-left" data-id="${escapeHtml(o.id)}" ${used ? "disabled" : ""}>
                      <span class="grow">${escapeHtml(o.text)}</span></button>`;
                  })
                  .join("")}
              </div>
              <div class="stack">
                ${st.right
                  .map((o) => {
                    const used = usedRight.has(o.id);
                    const cls = `opt ${rightSel === o.id ? "opt-sel" : ""} ${used ? "opt-done" : ""}`;
                    return `<button class="${cls}" type="button" data-act="match-right" data-id="${escapeHtml(o.id)}" ${used ? "disabled" : ""}>
                      <span class="grow">${escapeHtml(o.text)}</span></button>`;
                  })
                  .join("")}
              </div>
            </div>
            <div class="row-wrap mt"><button class="btn-quiet" type="button" data-act="match-reset">重新配对</button><span class="small muted">已配对 ${pairs.length} / ${st.correct.length}</span></div>`
      }
      ${
        answered
          ? `<div class="note ${S.last?.correct ? "note-ok" : "note-error"} mt"><span>${S.last?.correct ? "✅" : "❌"}</span>
              <div>配对正确 ${S.last?.detail?.hits || 0} / ${S.last?.detail?.total || 0} 对${
                S.last?.correct ? "" : "（正确配对见上方）"
              }</div></div>`
          : ""
      }
    </div>
  </section>`;
}

function compareHtml(st) {
  const answers = S.pending?.compare || {};
  const answered = S.phase === "feedback";
  const r0 = st.rounds[0];
  if (!r0) return '<p class="muted">没有可对比的内容</p>';
  const currentIndex = answered ? (S.last?.detail?.results || []).findIndex((r) => !r.correct) : -1;
  const shown = answered && currentIndex >= 0 ? st.rounds[currentIndex] : r0;
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny"><span class="badge badge-purple">${LINE_KINDS.compare.name}</span><span class="badge">${st.rounds.length} 题</span></div>
      <h2 class="card-title mt" style="font-size:1.05rem">${escapeHtml(st.prompt)}</h2>
      <p class="card-text strong mt">「${escapeHtml(shown.desc)}」</p>
      <div class="stack mt">
        ${shown.options
          .map((o) => {
            const sel = answers[shown.itemId];
            const isSel = sel === o.id;
            const isRight = shown.answer === o.id;
            let cls = "opt";
            if (answered) {
              if (isRight) cls += " opt-right";
              else if (isSel) cls += " opt-wrong";
            } else if (isSel) cls += " opt-sel";
            return `<button class="${cls}" type="button" data-act="compare-pick" data-item="${escapeHtml(shown.itemId)}" data-answer="${escapeHtml(o.id)}" ${
              answered ? "disabled" : ""
            }><span class="grow">${escapeHtml(o.text)}</span>${answered && isRight ? "<span>✅</span>" : ""}${
              answered && isSel && !isRight ? "<span>❌</span>" : ""
            }</button>`;
          })
          .join("")}
      </div>
      ${
        answered
          ? `<div class="note ${S.last?.correct ? "note-ok" : "note-error"} mt"><span>${S.last?.correct ? "✅" : "❌"}</span>
              <div>答对 ${S.last?.detail?.hits || 0} / ${S.last?.detail?.total || 0}
              <ul class="tight small">${(S.last?.detail?.results || [])
                .map(
                  (r) =>
                    `<li>${r.correct ? "✅" : "❌"} ${escapeHtml(truncate(st.rounds.find((x) => x.itemId === r.itemId)?.desc || "", 24))} → 应为「${escapeHtml(
                      shown.options.find((o) => o.id === r.expected)?.text || ""
                    )}」</li>`
                )
                .join("")}</ul></div></div>`
          : ""
      }
    </div>
  </section>`;
}

function footHtml(st) {
  if (st.kind === "card") {
    const last = S.idx === totalSteps() - 1;
    if (last && !S.session.hasQuestions) {
      // 只有学习卡：不结算星级/XP，明确告知
      return `<div class="col">
        <div class="note"><span>ℹ️</span><div>本关只有学习卡（该知识点没有题目），因此不计入星级与 XP。在笔记里补充「题目：」区块后重新导入即可开启测验。</div></div>
        <button class="btn btn-lg btn-block" type="button" data-act="learned">完成学习并返回</button>
      </div>`;
    }
    return `<button class="btn btn-lg btn-block" type="button" data-act="learned">我记住了，继续 →</button>`;
  }
  if (S.phase === "feedback") {
    const last = S.idx === totalSteps() - 1;
    return `<button class="btn btn-lg btn-block ${S.last?.correct ? "" : "btn-orange"}" type="button" data-act="continue">${
      last ? "查看结算 →" : "继续 →"
    }</button>`;
  }
  const ready =
    (st.kind === "question" && (st.type === "multi" ? (S.pending || []).length > 0 : !!S.pending)) ||
    (st.kind === "order" && (S.pending?.order || []).length === st.options.length) ||
    (st.kind === "match" && (S.pending?.pairs || []).length === st.correct.length) ||
    (st.kind === "compare" && Object.keys(S.pending?.compare || {}).length === st.rounds.length);
  return `<div class="col">
    ${st.kind === "question" && st.type === "tf" && !st.options.length ? "" : ""}
    <button class="btn btn-lg btn-block" type="button" data-act="submit" ${ready ? "" : "disabled"}>检查</button>
    ${st.kind === "question" ? '<button class="btn-quiet" type="button" data-act="show-answer">跳过本题（记为错误）</button>' : ""}
  </div>`;
}

/* ------------------------------ 交互 ------------------------------ */

function pickOption(key) {
  const st = step();
  if (!st || S.phase === "feedback") return;
  if (st.type === "multi") {
    const cur = new Set(S.pending || []);
    if (cur.has(key)) cur.delete(key);
    else cur.add(key);
    S.pending = [...cur];
  } else {
    S.pending = key;
  }
  repaint();
}

function pickOrder(index) {
  const st = step();
  if (!st || S.phase === "feedback") return;
  const opt = st.options[index];
  if (!opt) return;
  S.pending = S.pending || { order: [] };
  if (S.pending.order.includes(opt.id)) return;
  S.pending.order.push(opt.id);
  repaint();
}

function undoOrder() {
  if (S.pending?.order?.length) S.pending.order.pop();
  repaint();
}

function pickMatch(side, id, root) {
  const st = step();
  if (!st || S.phase === "feedback") return;
  S.pending = S.pending || { pairs: [], leftSel: null, rightSel: null };
  if (side === "left") {
    S.pending.leftSel = id;
  } else {
    S.pending.rightSel = id;
  }
  if (S.pending.leftSel && S.pending.rightSel) {
    const pair = { left: S.pending.leftSel, right: S.pending.rightSel };
    if (!S.pending.pairs.some((p) => p.left === pair.left || p.right === pair.right)) S.pending.pairs.push(pair);
    S.pending.leftSel = null;
    S.pending.rightSel = null;
  }
  repaint();
}

function pickCompare(itemId, answer) {
  const st = step();
  if (!st || S.phase === "feedback") return;
  S.pending = S.pending || { compare: {} };
  S.pending.compare[itemId] = answer;
  repaint();
}

function showAnswer() {
  const st = step();
  if (!st) return;
  S.pending = st.kind === "question" ? (st.type === "multi" ? [] : "__skip__") : S.pending;
  submitCurrent(true);
}

/** 提交当前步骤作答 */
function submit(ctx, root) {
  submitCurrent(false);
}

function submitCurrent(force) {
  const st = step();
  if (!st) return;
  let answer;
  if (st.kind === "question") {
    answer = force ? "__skip__" : S.pending;
  } else if (st.kind === "order") {
    answer = S.pending?.order || [];
  } else if (st.kind === "match") {
    answer = S.pending?.pairs || [];
  } else if (st.kind === "compare") {
    answer = S.pending?.compare || {};
  } else {
    answer = true;
  }
  const graded = gradeStep(st, answer);
  if (st.kind === "question" && force) graded.correct = false;
  S.last = { ...graded, stepKey: st.stepKey, kind: st.kind };

  // 错题本（Phase 4）：答错自动收集，答对推进「连续 3 次正确可移出」
  if (st.kind === "question") {
    recordAnswer(st, graded, answer).catch((err) => console.warn("[wrong] 记录失败", err));
  }

  accumulate(S.session, S.last);
  if (S.last.correct) {
    S.combo = S.session.combo;
    if (st.kind === "match") S.session.matchedPairs = (S.session.matchedPairs || 0) + (graded.detail?.hits || 0);
    if (st.kind === "compare") S.session.matchedPairs = (S.session.matchedPairs || 0) + (graded.detail?.hits || 0);
  } else {
    S.combo = 0;
    S.hearts = Math.max(0, S.hearts - 1);
    setHearts(S.hearts).catch(() => {});
  }
  S.phase = "feedback";
  repaint();
  document.getElementById("quiz-foot")?.scrollIntoView({ block: "end", behavior: "smooth" });
}

async function markLearned(ctx, root) {
  const st = step();
  if (!st || st.kind !== "card") return;
  const isNew = await markCardSeen(st.itemId || `${st.subject}|${st.title}`);
  if (isNew) S.session.newCards = (S.session.newCards || 0) + 1;
  S.last = { correct: true, expected: true, stepKey: st.stepKey, kind: "card" };

  const isLast = S.idx >= totalSteps() - 1;
  if (isLast && !S.session.hasQuestions) {
    // 只有学习卡：记录 XP 与连续打卡，但不结算星级（该知识点没有题目）
    try {
      const res = await settleCardOnly({
        nodeKey: S.session.nodeKey,
        nodeType: S.session.nodeType,
        subject: S.session.subject,
        chapter: S.session.chapter,
        newCards: S.session.newCards || 0,
        startedAt: S.session.startedAt,
      });
      S.result = res;
      toast(`学习完成：+${res.xp.total} XP${res.streak?.streak ? ` · 连续打卡 ${res.streak.streak} 天` : ""}`, { type: "ok" });
      await refreshSummary();
    } catch (err) {
      toast(`记录失败：${err.message}`, { type: "err" });
    }
    navigate("/learn", { subject: S.session.subject });
    return;
  }
  next(ctx, root);
}

function next(ctx, root) {
  if (S.idx >= totalSteps() - 1) {
    finish(ctx, root);
    return;
  }
  S.idx += 1;
  S.phase = "answer";
  S.last = null;
  S.pending = null;
  const st = step();
  // 为不同步骤预设作答缓存
  if (st?.kind === "order") S.pending = { order: [] };
  if (st?.kind === "match") S.pending = { pairs: [], leftSel: null, rightSel: null };
  if (st?.kind === "compare") S.pending = { compare: {} };
  if (st?.kind === "question" && st.type === "multi") S.pending = [];
  paint(ctx, root);
  window.scrollTo?.({ top: 0, behavior: "smooth" });
}

async function finish(ctx, root) {
  if (S.busy) return;
  S.busy = true;
  const input = toSettleInput(S.session);
  try {
    const result = await settleNode(input);
    S.result = result;
    emit(EV.DATA_CHANGED, { reason: "session-finished", nodeKey: input.nodeKey });
    if (result.badges?.length) {
      toast(`获得新徽章：${result.badges.map((b) => `${b.icon} ${b.name}`).join("、")}`, { type: "ok", ms: 4000 });
    }
  } catch (err) {
    toast(`结算失败：${err.message}`, { type: "err" });
  }
  S.busy = false;
  S.finished = true;
  paint(ctx, root);
  try {
    await refreshSummary();
  } catch {
    /* 统计刷新失败不影响结算结果 */
  }
}

/* ------------------------------ 结算页 ------------------------------ */

function resultHtml() {
  const r = S.result;
  const total = sessionTotal(S.session);
  const correct = S.session.pointsEarned || 0;
  if (!r) {
    return `<section class="section"><div class="card center"><div style="font-size:44px">😵</div><p class="muted">结算失败，请返回地图重试。</p></div></section>`;
  }
  const stars = "★".repeat(r.stars) + "☆".repeat(3 - r.stars);
  const goal = r.goal || { percent: 0, reached: false };
  const xpRows = (r.xp?.items || [])
    .map((i) => `<div class="kv"><div class="kv-key">${escapeHtml(i.label)}</div><div class="kv-val">+${i.xp} XP</div></div>`)
    .join("");
  const rank = r.rank || null;
  return `
  <section class="section">
    <div class="card center">
      <div style="font-size:52px">${r.stars >= 3 ? "🎉" : r.stars >= 1 ? "👏" : "💪"}</div>
      <h2 class="card-title">${r.stars >= 1 ? "关卡通过！" : "再来一次会更好"}</h2>
      <div style="font-size:2rem;letter-spacing:4px;color:var(--gold)">${stars}</div>
      <p class="muted small">${escapeHtml(S.session.title)}</p>
      <div class="stats mt">
        <div class="stat"><div class="stat-value">${correct}/${total}</div><div class="stat-label">答对</div></div>
        <div class="stat"><div class="stat-value">${r.accuracy}%</div><div class="stat-label">正确率</div></div>
        <div class="stat"><div class="stat-value">+${r.xp?.total || 0}</div><div class="stat-label">本次 XP</div></div>
        <div class="stat"><div class="stat-value">${S.session.maxCombo || 0}</div><div class="stat-label">最高连击</div></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="card-head"><span>✨</span><h3 class="card-title">XP 明细</h3></div>
      ${xpRows || '<p class="small muted">本次没有获得 XP。</p>'}
      <div class="kv"><div class="kv-key strong">合计</div><div class="kv-val strong">+${r.xp?.total || 0} XP（累计 ${r.xpTotal || 0}）</div></div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="row-between"><span class="strong">🔥 连续打卡</span><span class="badge badge-gold">${r.streak?.streak || 0} 天</span></div>
      ${r.streak?.brokenDays ? `<p class="small muted mt">上次断签 ${r.streak.brokenDays} 天，今天重新开始，坚持就是胜利。</p>` : ""}
      <div class="row-between mt"><span class="strong">🎯 今日目标</span><span class="badge ${goal.reached ? "badge-green" : ""}">${
        goal.percent || 0
      }%</span></div>
      <div class="progress mt"><div class="progress-fill" style="width:${goal.percent || 0}%"></div></div>
      ${goal.reached ? '<p class="small mt" style="color:var(--green-dark)">今日目标已达成，太棒了！</p>' : `<p class="small muted mt">还差 ${goal.remaining || 0} XP 达成今日目标</p>`}
      ${rank ? `<div class="row-between mt"><span class="strong">${rank.icon} 段位</span><span class="badge badge-purple">${escapeHtml(rank.name)} · ${rank.progress}%</span></div>` : ""}
    </div>
  </section>

  ${
    S.session.mistakes.length
      ? `<section class="section">
          <div class="section-head"><h2 class="section-title">错题回顾</h2><span class="section-sub">${S.session.mistakes.length} 处</span></div>
          <div class="stack">
            ${S.session.mistakes
              .map((m) => {
                const st = S.session.steps.find((x) => x.stepKey === m.stepKey);
                if (!st) return "";
                if (st.kind === "question") {
                  return `<div class="card">
                    <div class="card-head"><span class="badge badge-red">${typeLabel(st.type)}</span></div>
                    <p class="card-text">${escapeHtml(st.stem)}</p>
                    <p class="small mt"><span class="strong">正确答案：</span>${escapeHtml(st.answer)}</p>
                    ${st.analysis ? `<p class="small muted">${escapeHtml(st.analysis)}</p>` : ""}
                  </div>`;
                }
                if (st.kind === "order") {
                  return `<div class="card"><div class="card-head"><span class="badge badge-red">顺序排列</span></div>
                    <ol class="tight small">${st.correct.map((id) => `<li>${escapeHtml(st.options.find((o) => o.id === id)?.text || "")}</li>`).join("")}</ol></div>`;
                }
                if (st.kind === "match") {
                  return `<div class="card"><div class="card-head"><span class="badge badge-red">连线匹配</span></div>
                    <ul class="tight small">${st.correct
                      .map(
                        (p) =>
                          `<li>${escapeHtml(st.left.find((x) => x.id === p.left)?.text || "")} ↔ ${escapeHtml(
                            st.right.find((x) => x.id === p.right)?.text || ""
                          )}</li>`
                      )
                      .join("")}</ul></div>`;
                }
                return `<div class="card"><div class="card-head"><span class="badge badge-red">对比选择</span></div>
                  <ul class="tight small">${st.rounds
                    .map((rr) => `<li>${escapeHtml(truncate(rr.desc, 30))} → ${escapeHtml(st.options.find((o) => o.id === rr.answer)?.text || "")}</li>`)
                    .join("")}</ul></div>`;
              })
              .join("")}
          </div>
        </section>`
      : ""
  }

  ${
    r.badges?.length
      ? `<section class="section"><div class="card center">
          <div style="font-size:40px">🏅</div>
          <div class="strong">获得新徽章</div>
          <div class="row-wrap mt" style="justify-content:center">${r.badges
            .map((b) => `<span class="badge badge-gold">${b.icon} ${escapeHtml(b.name)}</span>`)
            .join("")}</div>
        </div></section>`
      : ""
  }

  <p class="small muted center">
    ${r.heartsNote ? escapeHtml(r.heartsNote) : ""}
    ${S.hearts <= 0 ? "红心已用完：等待 30 分钟恢复 1 心，或完成「复习 5 题」立即恢复。" : `剩余红心 ${S.hearts} / ${S.heartsMax}`}
  </p>`;
}

/** 没有可作答步骤时的说明（不显示虚构题目） */
function emptyStepsHtml() {
  const node = S.node || {};
  return `
  <section class="section">
    <div class="empty">
      <div class="empty-icon">📝</div>
      <div class="empty-title">这个关卡还没有题目</div>
      <p class="empty-text">
        本应用不内置题库、也不生成题目。<br />
        ${
          node.type === "face"
            ? "面关卡由你的题库组成：请先在笔记里为知识点补充「题目：」区块，再重新导入（重复导入不会重复建点）。"
            : "该知识点暂时没有题目，可以先看学习卡，或在笔记里补充「题目：」区块后重新导入。"
        }
      </p>
      <div class="row-wrap" style="justify-content:center">
        <button class="btn" type="button" data-act="back-map">返回关卡地图</button>
        <button class="btn btn-ghost" type="button" data-go="/guide">看题目书写规范</button>
      </div>
    </div>
  </section>`;
}

/** 错题本记录（懒加载，避免会话启动时额外负担） */
async function recordAnswer(st, graded, userAnswer) {
  const { recordWrong, recordCorrect } = await import("../core/cards.js");
  const q = {
    id: st.questionId,
    item_id: st.itemId,
    subject: S.session.subject,
    chapter: S.session.chapter,
    type: st.type,
    stem: st.stem,
    options: st.options,
    answer: st.answer,
    analysis: st.analysis,
  };
  if (graded.correct) await recordCorrect(q);
  else await recordWrong({ question: q, userAnswer, correctAnswer: st.answer, source: "level", nodeKey: S.session.nodeKey });
}

/** 重练错题（只做答错的题，结果不重复计 XP） */async function retryMistakes(ctx, root) {
  const mistakeSteps = S.session.steps.filter((st) => S.session.mistakes.some((m) => m.stepKey === st.stepKey));
  if (!mistakeSteps.length) return;
  const ok = await confirmDialog("重练错题？", `将重做 ${mistakeSteps.length} 个错题步骤，不计入星级与 XP（仅供巩固）。`, {
    okLabel: "开始重练",
  });
  if (!ok) return;
  S.session = {
    ...S.session,
    id: `s_${Date.now().toString(36)}`,
    steps: mistakeSteps,
    answers: {},
    mistakes: [],
    correctCount: 0,
    pointsEarned: 0,
    combo: 0,
    maxCombo: 0,
    startedAt: Date.now(),
    retry: true,
  };
  S.idx = 0;
  S.phase = "answer";
  S.pending = null;
  S.finished = false;
  S.result = null;
  paint(ctx, root);
}

/** 重绘（不重排 DOM 结构，避免丢焦点） */
function repaint() {
  const root = document.getElementById("view");
  if (root) paint(null, root);
}

/**
 * 复习会话页（提示词 5.3 两种复习模式）
 *   闪卡自评：显示知识点 → 回忆 → 自评「记得 / 模糊 / 忘记」
 *   测验复习：从该知识点的题目抽题 → 作答 → 结果驱动调度
 * 每完成 HEART_RULES.reviewTaskSize 道复习题可立即恢复 1 颗红心。
 * @module views/review-session
 */

import { escapeHtml, mdToHtml, truncate } from "../core/util.js";
import { toast } from "../core/dom.js";
import { navigate } from "../core/router.js";
import { readSettings, listQuestions, get, STORES, bumpDailyStats } from "../core/db.js";
import {
  buildQueue,
  listRecords,
  applyReview,
  GRADES,
  reviewStats,
} from "../core/scheduler.js";
import { gradeStep, typeLabel } from "../core/level.js";
import { grantHeartByReviewTask, addXp, touchStreak, settleBadges, XP_RULES } from "../core/game.js";
import { refreshSummary } from "../core/state.js";
import { emit, EV } from "../core/events.js";
const S = {
  mode: "flash", // flash | quiz
  queue: [],
  idx: 0,
  phase: "ask", // ask | reveal | feedback
  pending: null, // 题目作答缓存
  last: null,
  session: null,
  busy: false,
  done: false,
  subject: "",
};

export const reviewSessionView = {
  title: "复习",
  back: true,
  tab: null,
  async render(ctx) {
    const mode = ctx.query?.mode === "quiz" ? "quiz" : "flash";
    const subject = ctx.query?.subject || "";
    if (!S.session || S.session.mode !== mode || S.session.subject !== subject) {
      await start(mode, subject);
    }
    return `<div id="rev-top" class="quiz-top"></div><div id="rev-body"></div><div id="rev-foot" class="quiz-foot"></div>`;
  },
  async mount(ctx, root) {
    bind(ctx, root);
    paint(ctx, root);
  },
  unmount() {
    S.session = null;
    S.queue = [];
    S.idx = 0;
    S.done = false;
    S.pending = null;
    S.last = null;
  },
};

/* ------------------------------ 启动 ------------------------------ */

async function start(mode, subject) {
  const settings = readSettings();
  const records = await listRecords();
  const q = buildQueue(records, { dailyNewLimit: settings.dailyNewLimit ?? 20, subject: subject || undefined });
  const queue = q.queue.slice(0, 30); // 一次复习最多 30 项，避免过载
  const steps = [];
  for (const rec of queue) {
    if (mode === "quiz") {
      const item = rec.target_type === "item" ? await get(STORES.learn_items, rec.target_id) : null;
      const itemId = rec.target_type === "item" ? rec.target_id : rec.item_id;
      const source = item || (await get(STORES.learn_items, itemId));
      const qs = source ? await listQuestions(source.id) : [];
      if (!qs.length) {
        // 没有题目 → 退化为闪卡
        steps.push({ kind: "flash", record: rec, item: source, fallback: true });
        continue;
      }
      steps.push({ kind: "quiz", record: rec, item: source, question: qs[(S.idx + steps.length) % qs.length], questionIndex: (S.idx + steps.length) % qs.length });
    } else {
      const item = await get(STORES.learn_items, rec.target_type === "item" ? rec.target_id : rec.item_id);
      steps.push({ kind: "flash", record: rec, item });
    }
  }
  S.session = { mode, subject, steps, startedAt: Date.now(), reviewed: 0, correct: 0, total: 0, heartsRecovered: 0 };
  S.mode = mode;
  S.subject = subject;
  S.idx = 0;
  S.phase = "ask";
  S.pending = null;
  S.last = null;
  S.done = false;
}

function step() {
  return S.session?.steps[S.idx] || null;
}

/* ------------------------------ 交互 ------------------------------ */

function bind(ctx, root) {
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "reveal") {
      S.phase = "reveal";
      return paint(ctx, root);
    }
    if (act === "grade") return grade(ctx, root, el.dataset.grade);
    if (act === "option") {
      const st = step();
      if (!st || S.phase !== "ask") return;
      if (st.question.type === "multi") {
        const cur = new Set(Array.isArray(S.pending) ? S.pending : []);
        const key = el.dataset.key;
        if (cur.has(key)) cur.delete(key);
        else cur.add(key);
        S.pending = [...cur];
      } else {
        S.pending = el.dataset.key;
      }
      return paint(ctx, root);
    }
    if (act === "submit") return submitQuiz(ctx, root);
    if (act === "skip") return grade(ctx, root, "forgot");
    if (act === "next") return next(ctx, root);
    if (act === "finish") return finish(ctx, root);
    if (act === "back") return navigate("/review");
  });
}

async function grade(ctx, root, g) {
  const st = step();
  if (!st) return;
  await applyGrade(st, g);
  S.last = { grade: g, correct: g === "remembered" };
  S.phase = "feedback";
  paint(ctx, root);
}

async function applyGrade(st, g) {
  const updated = await applyReview(st.record, g);
  st.record = updated;
  S.session.reviewed += 1;
  S.session.total += 1;
  if (g === "remembered") S.session.correct += 1;
  emit(EV.DATA_CHANGED, { reason: "review", recordId: updated.id });
  // 复习 XP（+3/题）与当日统计
  await addXp(XP_RULES.review);
  await bumpDailyStats({ xp: XP_RULES.review, reviews: 1, correct: g === "remembered" ? 1 : 0, total: 1 });
  await touchStreak();
  // 每复习 5 题恢复 1 颗心
  const size = 5;
  if (S.session.reviewed % size === 0) {
    const ok = await grantHeartByReviewTask();
    if (ok) {
      S.session.heartsRecovered += 1;
      toast("完成复习任务，恢复 1 颗红心 ❤️", { type: "ok" });
    }
  }
}

async function submitQuiz(ctx, root) {
  const st = step();
  if (!st) return;
  const graded = gradeStep(
    { kind: "question", type: st.question.type, answer: st.question.answer, options: st.question.options },
    S.pending
  );  const g = graded.correct ? "remembered" : "forgot";
  await applyGrade(st, g);
  // 错题本（Phase 4）：复习答错同样收集
  try {
    const { recordWrong, recordCorrect } = await import("../core/cards.js");
    const q = {
      id: st.question.id,
      item_id: st.question.item_id,
      subject: st.question.subject || st.record.subject,
      chapter: st.question.chapter || st.record.chapter,
      type: st.question.type,
      stem: st.question.stem,
      options: st.question.options,
      answer: st.question.answer,
      analysis: st.question.analysis,
    };
    if (graded.correct) await recordCorrect(q);
    else await recordWrong({ question: q, userAnswer: S.pending, correctAnswer: st.question.answer, source: "review" });
  } catch (err) {
    console.warn("[wrong] 复习错题记录失败", err);
  }
  S.last = { correct: graded.correct, expected: st.question.answer, grade: g };
  S.phase = "feedback";
  paint(ctx, root);
}

function next(ctx, root) {
  if (S.idx >= (S.session?.steps.length || 0) - 1) return finish(ctx, root);
  S.idx += 1;
  S.phase = "ask";
  S.pending = null;
  S.last = null;
  paint(ctx, root);
  window.scrollTo?.({ top: 0, behavior: "smooth" });
}

async function finish(ctx, root) {
  if (S.busy) return;
  S.busy = true;
  try {
    const badges = await settleBadges();
    if (badges.length) toast(`获得新徽章：${badges.map((b) => `${b.icon} ${b.name}`).join("、")}`, { type: "ok", ms: 4000 });
    S.session.badges = badges;
    const records = await listRecords();
    S.session.stats = reviewStats(records);
    await refreshSummary();
  } catch (err) {
    toast(`结算失败：${err.message}`, { type: "err" });
  }
  S.busy = false;
  S.done = true;
  paint(ctx, root);
}

/* ------------------------------ 渲染 ------------------------------ */

function paint(ctx, root) {
  const top = root.querySelector("#rev-top");
  const body = root.querySelector("#rev-body");
  const foot = root.querySelector("#rev-foot");
  if (!top || !body || !foot) return;

  if (S.done) {
    top.innerHTML = "";
    body.innerHTML = summaryHtml();
    foot.innerHTML = `<div class="row-wrap">
      <button class="btn btn-lg grow" type="button" data-act="back">回到复习队列</button>
      <button class="btn btn-ghost" type="button" data-go="/learn">去关卡</button>
    </div>`;
    return;
  }

  const st = step();
  if (!st) {
    S.done = true;
    return paint(ctx, root);
  }

  const total = S.session.steps.length;
  top.innerHTML = `
  <div class="row-between">
    <span class="badge badge-blue">${S.mode === "quiz" ? "测验复习" : "闪卡自评"} · ${escapeHtml(st.record.subject || "")}</span>
    <span class="tiny muted">${S.idx + 1} / ${total}</span>
  </div>
  <div class="progress mt"><div class="progress-fill" style="width:${Math.round((S.idx / Math.max(1, total)) * 100)}%"></div></div>
  <div class="row-between tiny muted mt">
    <span>已复习 ${S.session.reviewed} · 记得 ${S.session.correct}</span>
    <span>${st.record.status === "mastered" ? "已掌握（巡访）" : `间隔 ${st.record.interval || 0} 天`}</span>
  </div>`;

  body.innerHTML = st.kind === "quiz" ? quizHtml(st) : flashHtml(st);
  foot.innerHTML = footHtml(st);
}

function flashHtml(st) {
  const item = st.item;
  const rec = st.record;
  const revealed = S.phase !== "ask";
  if (!item) {
    return `<section class="section"><div class="note note-warn"><span>⚠️</span><div>该复习条目对应的知识点已被删除，可跳过。</div></div></section>`;
  }
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny">
        ${st.fallback ? '<span class="badge badge-gold">无题目 → 闪卡</span>' : ""}
        <span class="badge">难度 ${item.difficulty || 1}</span>
        <span class="badge">${escapeHtml(item.chapter || "—")}</span>
        <span class="badge ${rec.status === "mastered" ? "badge-green" : "badge-blue"}">${
          rec.status === "mastered" ? "已掌握" : rec.status === "new" ? "新内容" : "学习中"
        }</span>
        ${rec.lapses ? `<span class="badge badge-red">答错 ${rec.lapses} 次</span>` : ""}
      </div>
      <h2 class="card-title mt">${escapeHtml(item.title)}</h2>
      ${
        revealed
          ? `<div class="md-body">${item.content ? mdToHtml(item.content) : '<p class="muted">（无正文）</p>'}</div>
             ${
               item.key_points?.length
                 ? `<div class="note note-ok mt"><span>🔑</span><div><strong>要点</strong><ul class="tight">${item.key_points
                     .map((k) => `<li>${escapeHtml(k)}</li>`)
                     .join("")}</ul></div></div>`
                 : ""
             }
             ${
               item.common_mistakes?.length
                 ? `<div class="note note-warn mt"><span>⚠️</span><div><strong>易错点</strong><ul class="tight">${item.common_mistakes
                     .map((k) => `<li>${escapeHtml(k)}</li>`)
                     .join("")}</ul></div></div>`
                 : ""
             }`
          : `<p class="muted">先在心里回忆这个知识点，再点「显示答案」核对。</p>`
      }
    </div>
  </section>`;
}

function quizHtml(st) {
  const q = st.question;
  if (!q) return flashHtml(st);
  const answered = S.phase === "feedback";
  const expected = new Set(
    String(q.answer)
      .split(/[,，、;；\s]+/)
      .map((x) => x.trim().toUpperCase())
  );
  const sel = S.pending;
  return `
  <section class="section">
    <div class="card">
      <div class="row-wrap tiny">
        <span class="badge badge-blue">${typeLabel(q.type)}</span>
        <span class="badge">${escapeHtml(st.record.subject || "")}</span>
        <span class="badge">${escapeHtml(truncate(st.item?.title || "", 14))}</span>
      </div>
      <h2 class="card-title mt" style="font-size:1.05rem">${escapeHtml(q.stem)}</h2>
      <div class="stack mt">
        ${(q.options || [])
          .map((o) => {
            const key = o.key.toUpperCase();
            const isSel = q.type === "multi" ? (sel || []).includes(key) : sel === key;
            const isRight = expected.has(key);
            let cls = "opt";
            if (answered) {
              if (isRight) cls += " opt-right";
              else if (isSel) cls += " opt-wrong";
            } else if (isSel) cls += " opt-sel";
            return `<button class="${cls}" type="button" data-act="option" data-key="${escapeHtml(key)}" ${
              answered ? "disabled" : ""
            }><span class="opt-key">${escapeHtml(key)}</span><span class="grow">${escapeHtml(o.text)}</span>${
              answered && isRight ? "<span>✅</span>" : answered && isSel ? "<span>❌</span>" : ""
            }</button>`;
          })
          .join("")}
      </div>
      ${
        answered
          ? `<div class="note ${S.last?.correct ? "note-ok" : "note-error"} mt">
              <span>${S.last?.correct ? "✅" : "❌"}</span>
              <div><strong>${S.last?.correct ? "回答正确" : `正确答案：${escapeHtml(q.answer)}`}</strong>
              ${q.analysis ? `<div class="small mt">${escapeHtml(q.analysis)}</div>` : ""}
              <div class="small mt muted">调度结果：${gradeLabel(st.record.last_result)} → 间隔 ${st.record.interval} 天（下次 ${
                st.record.next_review_date
              }）</div></div>
            </div>`
          : ""
      }
    </div>
  </section>`;
}

function gradeLabel(g) {
  return { remembered: "记得", fuzzy: "模糊", forgot: "忘记" }[g] || g;
}

function footHtml(st) {
  if (S.phase === "ask") {
    if (st.kind === "quiz") {
      const ready =
        st.question.type === "multi" ? Array.isArray(S.pending) && S.pending.length > 0 : !!S.pending;
      return `<div class="col">
        <button class="btn btn-lg btn-block" type="button" data-act="submit" ${ready ? "" : "disabled"}>检查</button>
        <button class="btn-quiet" type="button" data-act="skip">不会，记为忘记</button>
      </div>`;
    }
    return `<button class="btn btn-lg btn-block" type="button" data-act="reveal">显示答案</button>`;
  }
  if (S.phase === "feedback") {
    return `<button class="btn btn-lg btn-block" type="button" data-act="next">${
      S.idx >= S.session.steps.length - 1 ? "完成复习 →" : "下一个 →"
    }</button>`;
  }
  return `<div class="col">
    <button class="btn btn-lg btn-block" type="button" data-act="next">${
      S.idx >= S.session.steps.length - 1 ? "完成复习 →" : "下一个 →"
    }</button>
    <div class="row" style="gap:8px">
      ${Object.values(GRADES)
        .map(
          (g) =>
            `<button class="btn ${g.key === "remembered" ? "" : g.key === "fuzzy" ? "btn-gold" : "btn-red"} grow" type="button" data-act="grade" data-grade="${g.key}">${g.icon} ${g.label}</button>`
        )
        .join("")}
    </div>
    <p class="field-hint center">记得 → 拉长间隔；模糊 → 保持间隔；忘记 → 重置为 1 天</p>
  </div>`;
}

function summaryHtml() {
  const s = S.session;
  const acc = s.total ? Math.round((s.correct / s.total) * 100) : 0;
  const xp = s.reviewed * XP_RULES.review;
  const stats = s.stats || {};
  const reviewed = s.steps.filter((st) => st.record.review_count > 0);
  return `
  <section class="section">
    <div class="card center">
      <div style="font-size:48px">${s.reviewed ? "🎯" : "✅"}</div>
      <h2 class="card-title">${s.reviewed ? "复习完成" : "今天没有待复习内容"}</h2>
      <p class="card-text">${
        s.reviewed
          ? `本次复习 ${s.reviewed} 项，记得 ${s.correct} 项（${acc}%）`
          : "复习队列已清空。可以去关卡继续闯关，或导入更多内容。"
      }</p>
      <div class="stats mt">
        <div class="stat"><div class="stat-value">+${xp}</div><div class="stat-label">复习 XP</div></div>
        <div class="stat"><div class="stat-value">${s.heartsRecovered}</div><div class="stat-label">恢复红心</div></div>
        <div class="stat"><div class="stat-value">${stats.mastered ?? 0}</div><div class="stat-label">已掌握</div></div>
        <div class="stat"><div class="stat-value">${stats.weak ?? 0}</div><div class="stat-label">薄弱</div></div>
      </div>
    </div>
  </section>

  ${
    reviewed.length
      ? `<section class="section">
          <div class="section-head"><h2 class="section-title">本次调度结果</h2></div>
          <div class="stack">
            ${reviewed
              .map((st) => {
                const r = st.record;
                const next =
                  r.last_result === "remembered"
                    ? `间隔拉长到 ${r.interval} 天`
                    : r.last_result === "fuzzy"
                      ? `保持间隔 ${r.interval} 天`
                      : "重置为 1 天，进入薄弱队列";
                return `<div class="card">
                  <div class="card-head">
                    <span class="badge ${
                      r.last_result === "remembered" ? "badge-green" : r.last_result === "forgot" ? "badge-red" : "badge-gold"
                    }">${gradeLabel(r.last_result)}</span>
                    <span class="badge">${r.status === "mastered" ? "已掌握" : "学习中"}</span>
                  </div>
                  <div class="strong">${escapeHtml(truncate(st.item?.title || st.record.title, 30))}</div>
                  <div class="small muted">${next} · 下次复习 ${r.next_review_date}${
                    r.lapses ? ` · 累计答错 ${r.lapses} 次` : ""
                  }</div>
                </div>`;
              })
              .join("")}
          </div>
        </section>`
      : ""
  }

  ${
    s.badges?.length
      ? `<section class="section"><div class="card center"><div style="font-size:36px">🏅</div>
          <div class="strong">获得新徽章</div>
          <div class="row-wrap mt" style="justify-content:center">${s.badges
            .map((b) => `<span class="badge badge-gold">${b.icon} ${escapeHtml(b.name)}</span>`)
            .join("")}</div></div></section>`
      : ""
  }`;
}

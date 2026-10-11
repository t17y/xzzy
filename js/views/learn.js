/**
 * 关卡地图页（提示词 5.1 / 六.3）
 * 科目 → 章节 → 点 / 线 / 面 关卡路径；显示星级、锁定状态、进度与解锁条件
 * @module views/learn
 */

import { escapeHtml, starsText, truncate } from "../core/util.js";
import { listSubjects, readSettings } from "../core/db.js";
import { navigate } from "../core/router.js";
import { buildMap, NODE_META, LINE_KINDS } from "../core/level.js";
import { rankOf, loadGame, BADGES } from "../core/game.js";
import { state } from "../core/state.js";

export const learnView = {
  title: "关卡",
  tab: "learn",
  async render(ctx) {
    const subject = ctx.query?.subject || "";
    const subjects = await listSubjects();
    if (!subjects.length) return emptyHtml();
    if (!subject) return await subjectListHtml(subjects);
    return await pathHtml(subject);
  },
  mount(ctx, root) {
    root.addEventListener("click", (ev) => {
      const expand = ev.target.closest("[data-expand]");
      if (expand) {
        expanded.add(expand.dataset.expand);
        ctx.reload?.();
        return;
      }
      const el = ev.target.closest("[data-subject]");
      if (el) {
        navigate("/learn", { subject: el.dataset.subject });
        return;
      }
      const play = ev.target.closest("[data-play]");
      if (play) {
        const node = JSON.parse(decodeURIComponent(play.dataset.play));
        if (node.locked) return;
        navigate("/session", { node: encodeURIComponent(JSON.stringify(node)) });
      }
    });
  },
};

function emptyHtml() {
  return `<section class="section"><div class="empty">
    <div class="empty-icon">🗺️</div>
    <div class="empty-title">还没有可闯关的内容</div>
    <p class="empty-text">导入 Markdown 内容后，科目路径会出现在这里。</p>
    <button class="btn btn-lg btn-block" type="button" data-go="/import">📥 导入内容</button>
  </div></section>`;
}

async function subjectListHtml(subjects) {
  const settings = readSettings();
  const rows = [];
  for (const s of subjects) {
    const map = await buildMap(s, { unlockStars: settings.unlockStars });
    const percent = map.stats.maxStars ? Math.round((map.stats.stars / map.stats.maxStars) * 100) : 0;
    rows.push(`
      <button class="list-item" type="button" data-subject="${escapeHtml(s)}">
        <span class="list-item-icon">📘</span>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(s)}</div>
          <div class="list-item-sub">${map.chapters.length} 章 · 点 ${map.stats.points} / 线 ${map.stats.lines} / 面 ${map.stats.faces}</div>
          <div class="progress mt"><div class="progress-fill" style="width:${percent}%"></div></div>
          <div class="tiny muted mt">⭐ ${map.stats.stars} / ${map.stats.maxStars} 星 · 已通过 ${map.stats.cleared} 关${
            map.nextNode ? ` · 下一关：${escapeHtml(truncate(map.nextNode.title, 16))}` : ""
          }</div>
        </div>
        <span class="list-item-chev">›</span>
      </button>`);
  }
  const game = await loadGame();
  const rank = rankOf(game.xp);
  return `
  <section class="section">
    <div class="card">
      <div class="row-between">
        <div><div class="tiny muted">累计 XP</div><div class="strong" style="font-size:1.15rem">${game.xp}</div></div>
        <div class="badge badge-purple">${rank.icon} ${escapeHtml(rank.name)}</div>
      </div>
      <div class="progress mt"><div class="progress-fill" style="width:${rank.progress}%"></div></div>
      <div class="tiny muted mt">${rank.next ? `距 ${escapeHtml(rank.next.name)} 还需 ${rank.toNext} XP` : "已达最高段位"}</div>
      <div class="row-wrap mt">
        <span class="badge badge-gold">🔥 连续 ${game.streak.streak} 天</span>
        <span class="badge">⭐ 合计 ${state.summary.stars || 0} 星</span>
        <span class="badge">🏅 徽章 ${game.badges.length} / ${BADGES.length}</span>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">科目路径</h2><span class="section-sub">共 ${subjects.length} 个</span></div>
    <div class="list">${rows.join("")}</div>
  </section>`;
}

/** 章节内一次渲染的关卡数（内容文件常有上百个知识点，一次全渲染会让手机排版卡顿） */
const NODE_PAGE = 40;
/** 每个章节的展开状态（仅本次会话有效） */
const expanded = new Set();

async function pathHtml(subject) {
  const settings = readSettings();
  const map = await buildMap(subject, { unlockStars: settings.unlockStars });
  const groups = new Map();
  for (const n of map.nodes) {
    const key = n.chapter || "（全科）";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  const chaptersHtml = [...groups.entries()]
    .map(([chapter, nodes]) => {
      const chapterUnlocked = nodes.some((n) => n.unlocked);
      const stars = nodes.reduce((n, x) => n + (x.stars || 0), 0);
      const max = nodes.length * 3;
      const isOpen = expanded.has(chapter) || nodes.length <= NODE_PAGE;
      // 已解锁的关卡优先展示（未解锁的大多只是占位，没必要一次全画出来）
      const visible = isOpen
        ? nodes
        : [
            ...nodes.filter((n) => n.unlocked || n.cleared),
            ...nodes.filter((n) => !n.unlocked && !n.cleared).slice(0, Math.max(0, NODE_PAGE - nodes.filter((n) => n.unlocked || n.cleared).length)),
          ].sort((a, b) => a.order - b.order);
      const hidden = nodes.length - visible.length;
      return `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${escapeHtml(chapter)}</h2>
          <span class="section-sub">⭐ ${stars}/${max} · ${nodes.length} 关</span>
        </div>
        <div class="path ${chapterUnlocked ? "" : "path-locked"}">
          ${visible.map((n, i) => nodeHtml(n, i)).join("")}
        </div>
        ${
          hidden > 0
            ? `<button class="btn btn-ghost btn-block btn-sm mt" type="button" data-expand="${escapeHtml(chapter)}">显示其余 ${hidden} 个关卡</button>`
            : ""
        }
        ${
          chapterUnlocked
            ? ""
            : `<div class="note note-warn mt"><span>🔒</span><div>本章尚未解锁：先把上一章的点关卡全部通过，或让任一上一章线关卡拿到 ${map.unlockStars} 星。</div></div>`
        }
      </section>`;
    })
    .join("");

  return `
  <section class="section">
    <div class="row-between">
      <div>
        <h2 class="section-title">${escapeHtml(subject)}</h2>
        <p class="small muted">${map.chapters.length} 章 · 点 ${map.stats.points} / 线 ${map.stats.lines} / 面 ${map.stats.faces}</p>
      </div>
      <button class="btn-quiet" type="button" data-go="/learn">全部科目</button>
    </div>
    <div class="progress mt"><div class="progress-fill" style="width:${
      map.stats.maxStars ? Math.round((map.stats.stars / map.stats.maxStars) * 100) : 0
    }%"></div></div>
    <div class="tiny muted mt">⭐ ${map.stats.stars} / ${map.stats.maxStars} · 已通过 ${map.stats.cleared} 关 · 解锁条件：前一关获得 ${map.unlockStars} 星</div>
  </section>
  ${chaptersHtml}`;
}

function nodeHtml(n, index) {
  const meta = NODE_META[n.type];
  const locked = !n.unlocked;
  const stars = "★".repeat(n.stars || 0) + "☆".repeat(3 - (n.stars || 0));
  const side = index % 2 === 0 ? "left" : "right";
  const data = encodeURIComponent(
    JSON.stringify({
      nodeKey: n.nodeKey,
      type: n.type,
      subject: n.subject,
      chapter: n.chapter,
      title: n.title,
      lineKind: n.lineKind || n.meta?.lineKind || null,
      itemId: n.itemId || null,
      meta: n.meta || {},
      questionCount: n.questionCount || 0,
    })
  );
  const badgeText =
    n.type === "point"
      ? `${meta.label} · ${n.questionCount ? `${n.questionCount} 题` : "暂无题目"}`
      : n.type === "line"
        ? `${meta.label} · ${LINE_KINDS[n.lineKind]?.name || ""}`
        : `${meta.label} · ${n.questionCount} 题`;
  return `
  <div class="path-node path-${side} ${locked ? "locked" : ""}">
    <button class="node-btn node-${n.type}" type="button" data-play="${data}" ${locked ? 'aria-disabled="true"' : ""}>
      <span class="node-icon">${locked ? "🔒" : n.cleared ? "✅" : meta.icon}</span>
    </button>
    <div class="node-info">
      <div class="node-title">${escapeHtml(truncate(n.title, 26))}</div>
      <div class="node-meta">
        <span class="badge ${n.type === "point" ? "badge-blue" : n.type === "line" ? "badge-purple" : "badge-gold"}">${escapeHtml(
          badgeText
        )}</span>
        <span class="stars" title="最高星级">${stars}</span>
      </div>
      ${locked ? '<div class="tiny muted">🔒 完成前一关（≥2 星）后解锁</div>' : ""}
    </div>
  </div>`;
}

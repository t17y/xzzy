/**
 * 徽章墙 + 段位进度（提示词 5.2）
 * @module views/badges
 */

import { escapeHtml } from "../core/util.js";
import { BADGES, RANKS, loadGame, rankOf, collectStats, badgeInfo } from "../core/game.js";
import { navigate } from "../core/router.js";

export const badgesView = {
  title: "徽章墙",
  back: true,
  tab: null,
  async render() {
    const game = await loadGame();
    const stats = await collectStats(game);
    const rank = rankOf(game.xp);
    const owned = new Set(game.badges);
    const badgeCards = BADGES.map((b) => {
      const has = owned.has(b.key);
      return `<div class="badge-card ${has ? "badge-owned" : "badge-locked"}">
        <div class="badge-icon">${has ? b.icon : "🔒"}</div>
        <div class="grow">
          <div class="strong">${escapeHtml(b.name)}</div>
          <div class="tiny muted">${escapeHtml(b.desc)}</div>
        </div>
        ${has ? '<span class="badge badge-gold">已获得</span>' : '<span class="badge">未获得</span>'}
      </div>`;
    }).join("");

    const rankRows = RANKS.map((r, i) => {
      const reached = game.xp >= r.min;
      const isCurrent = rank.key === r.key;
      return `<div class="row-between ${isCurrent ? "strong" : ""}" style="padding:6px 0;border-bottom:1px dashed var(--border)">
        <span>${r.icon} ${escapeHtml(r.name)}${isCurrent ? "（当前）" : ""}</span>
        <span class="small muted">${reached ? "✅ 已达成" : `需 ${r.min} XP`}</span>
      </div>`;
    }).join("");

    return `
    <section class="section">
      <div class="card">
        <div class="row-between">
          <div>
            <div class="tiny muted">累计 XP</div>
            <div class="strong" style="font-size:1.4rem">${game.xp}</div>
          </div>
          <div class="badge badge-purple" style="font-size:0.9rem">${rank.icon} ${escapeHtml(rank.name)}</div>
        </div>
        <div class="progress mt"><div class="progress-fill" style="width:${rank.progress}%"></div></div>
        <div class="tiny muted mt">${rank.next ? `距 ${escapeHtml(rank.next.name)} 还需 ${rank.toNext} XP` : "已达最高段位，继续巩固！"}</div>
      </div>
    </section>

    <section class="section">
      <div class="stats">
        <div class="stat"><div class="stat-value">${owned.size}/${BADGES.length}</div><div class="stat-label">徽章</div></div>
        <div class="stat"><div class="stat-value">${stats.clearedNodes}</div><div class="stat-label">通过关卡</div></div>
        <div class="stat"><div class="stat-value">${stats.stars}</div><div class="stat-label">获得星数</div></div>
        <div class="stat"><div class="stat-value">${stats.streak}</div><div class="stat-label">连续打卡</div></div>
        <div class="stat"><div class="stat-value">${stats.bestStreak}</div><div class="stat-label">最长连击(天)</div></div>
        <div class="stat"><div class="stat-value">${stats.maxCombo}</div><div class="stat-label">最高连击(题)</div></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">徽章</h2><span class="section-sub">共 ${BADGES.length} 枚</span></div>
      <div class="stack">${badgeCards}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">段位体系</h2></div>
      <div class="card">${rankRows}</div>
      <p class="field-hint">段位按累计 XP 升级：青铜 → 白银 → 黄金 → 铂金 → 钻石 → 大师。</p>
    </section>

    <section class="section">
      <button class="btn btn-lg btn-block" type="button" data-go="/learn">去闯关拿 XP</button>
    </section>`;
  },
  mount(ctx, root) {
    root.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-go]");
      if (el) navigate(el.dataset.go);
    });
  },
};

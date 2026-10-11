/**
 * 学习统计页（提示词 六.14 / 5.2）
 * 每日 XP 热力图、掌握曲线、错题趋势、卡片数量、科目分布、复习状态；全部为本地真实数据 + 内联 SVG 图表
 * @module views/stats
 */

import { escapeHtml, fmtNum, pct } from "../core/util.js";
import { navigate } from "../core/router.js";
import { state, refreshSummary } from "../core/state.js";
import { readSettings, listImports, storageEstimate, migrationLog } from "../core/db.js";
import { loadGame, collectStats, BADGES, rankOf } from "../core/game.js";
import { listMapSummary } from "../core/level.js";
import { fullStats, lineChartSvg, barChartSvg, heatmapSvg } from "../core/analytics.js";
import { APP } from "../config.js";

export const statsView = {
  title: "学习统计",
  back: true,
  async render() {
    await refreshSummary();
    const settings = readSettings();
    const maps = await listMapSummary({ unlockStars: settings.unlockStars });
    const stats = await fullStats({ maps });
    const game = await loadGame();
    const totals = await collectStats(game);
    const rank = rankOf(game.xp);
    const imports = await listImports();
    const est = await storageEstimate();

    const hasData = stats.totals.xp > 0 || state.summary.items > 0;

    const xpHeat = heatmapSvg({
      values: stats.daily.map((d) => d.xp),
      labels: stats.labels,
      height: 76,
      goal: stats.dailyGoal,
    });

    const masteryChart = lineChartSvg({
      series: [
        { name: "已学", color: "var(--blue)", points: stats.mastery.map((m) => m.learned) },
        { name: "已掌握", color: "var(--green)", points: stats.mastery.map((m) => m.mastered) },
      ],
      labels: stats.labels,
      height: 130,
    });

    const wrongChart = barChartSvg({
      bars: stats.wrong.map((w) => ({ value: w.added })),
      labels: stats.labels,
      height: 110,
      color: "var(--red)",
    });

    const reviewChart = barChartSvg({
      bars: stats.daily.map((d) => ({ value: d.reviews })),
      labels: stats.labels,
      height: 96,
      color: "var(--purple)",
    });

    const subjectRows = stats.subjects
      .map(
        (s) => `<div class="kv"><div class="kv-key">${escapeHtml(s.subject)}</div>
        <div class="kv-val">⭐ ${s.stars}/${s.maxStars || 0}（${pct(s.stars, s.maxStars || 1)}%） · 关卡 ${s.cleared}/${s.nodes} · 卡片 ${s.cards}${
          s.wrongCards ? `（精华 ${s.wrongCards}）` : ""
        } · 未移出错题 ${s.wrongs}${s.wrongTimes ? `（错 ${s.wrongTimes} 次）` : ""}</div></div>`
      )
      .join("") || '<p class="small muted">还没有内容。</p>';

    const cardRows = [
      ["卡片总数", stats.cards.total],
      ["基础卡片", stats.cards.base],
      ["错题精华", stats.cards.wrong],
      ["已收藏（书签）", stats.cards.bookmarked],
      ["含个人备注", stats.cards.noted],
    ]
      .map(([k, v]) => `<div class="kv"><div class="kv-key">${k}</div><div class="kv-val">${fmtNum(v)}</div></div>`)
      .join("");

    const reviewRows = [
      ["复习档案总数", stats.review.total],
      ["已掌握", stats.review.mastered],
      ["学习中", stats.review.learning],
      ["尚未复习", stats.review.new],
      ["当前已到期", stats.review.due],
      ["累计答错", stats.review.lapses],
    ]
      .map(([k, v]) => `<div class="kv"><div class="kv-key">${k}</div><div class="kv-val">${fmtNum(v)}</div></div>`)
      .join("");

    const accuracy = stats.totals.total ? Math.round((stats.totals.correct / stats.totals.total) * 100) : 0;

    return `
    <section class="section">
      <div class="stats">
        <div class="stat"><div class="stat-value">${fmtNum(game.xp)}</div><div class="stat-label">累计 XP</div></div>
        <div class="stat"><div class="stat-value">${stats.activeDays}</div><div class="stat-label">近 30 天活跃</div></div>
        <div class="stat"><div class="stat-value">${totals.clearedNodes}</div><div class="stat-label">通过关卡</div></div>
        <div class="stat"><div class="stat-value">${totals.stars}</div><div class="stat-label">星数</div></div>
        <div class="stat"><div class="stat-value">${accuracy}%</div><div class="stat-label">总正确率</div></div>
        <div class="stat"><div class="stat-value">${game.badges.length}</div><div class="stat-label">徽章</div></div>
      </div>
      <div class="card mt">
        <div class="row-between"><span class="strong">${rank.icon} ${escapeHtml(rank.name)}</span><span class="badge badge-purple">${
          rank.progress
        }%</span></div>
        <div class="progress mt"><div class="progress-fill" style="width:${rank.progress}%"></div></div>
        <div class="tiny muted mt">${rank.next ? `距 ${escapeHtml(rank.next.name)} 还需 ${rank.toNext} XP` : "已达最高段位"}</div>
      </div>
    </section>

    ${
      hasData
        ? `
    <section class="section">
      <div class="section-head"><h2 class="section-title">每日 XP</h2><span class="section-sub">近 30 天 · 共 ${stats.totals.xp} XP · 目标 ${
            stats.dailyGoal
          }/天</span></div>
      <div class="card">
        ${xpHeat}
        <div class="row-between tiny muted mt"><span>30 天前</span><span>今天</span></div>
        <p class="field-hint">实心绿柱表示当天达到每日目标；虚线为目标线（见下方柱状图）。</p>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">掌握曲线</h2><span class="section-sub">已学 / 已掌握累计</span></div>
      <div class="card">
        ${masteryChart}
        <p class="field-hint">「已掌握」＝连续走完间隔阶梯（默认 60 天档）的知识点；曲线取自每次复习后记录的档案状态。</p>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">错题趋势</h2><span class="section-sub">每日新增错题</span></div>
      <div class="card">
        ${wrongChart}
        <div class="row-between small mt"><span>未移出错题 <strong>${state.summary.wrongs || 0}</strong> 条</span>
          <button class="btn-quiet" type="button" data-go="/wrong">去错题本 ›</button></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">复习量</h2><span class="section-sub">每日复习题数</span></div>
      <div class="card">
        ${reviewChart}
        <p class="field-hint">近 30 天共复习 ${stats.totals.reviews} 题，复习 ${stats.totals.lessons} 次关卡，答对 ${stats.totals.correct}/${
            stats.totals.total
          } 题。</p>
      </div>
    </section>`
        : `<section class="section"><div class="empty">
            <div class="empty-icon">📊</div>
            <div class="empty-title">还没有可统计的学习记录</div>
            <p class="empty-text">导入内容并完成几个关卡或复习后，这里会出现 XP 热力图、掌握曲线与错题趋势。</p>
            <div class="row-wrap" style="justify-content:center">
              <button class="btn" type="button" data-go="/import">📥 导入内容</button>
              <button class="btn btn-ghost" type="button" data-go="/learn">去关卡</button>
            </div>
          </div></section>`
    }

    <section class="section">
      <div class="section-head"><h2 class="section-title">科目分布</h2><span class="section-sub">共 ${stats.subjects.length} 个</span></div>
      <div class="card">${subjectRows}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">卡片与复习状态</h2></div>
      <div class="card">
        ${cardRows}
        <hr />
        ${reviewRows}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">学习行为</h2></div>
      <div class="card">
        <div class="kv"><div class="kv-key">测验会话</div><div class="kv-val">${fmtNum(state.summary.sessions || 0)} 次</div></div>
        <div class="kv"><div class="kv-key">累计答题</div><div class="kv-val">${totals.correct}/${totals.total}</div></div>
        <div class="kv"><div class="kv-key">最高连击</div><div class="kv-val">${totals.maxCombo} 题</div></div>
        <div class="kv"><div class="kv-key">连续打卡 / 最长</div><div class="kv-val">${totals.streak} 天 / ${totals.bestStreak} 天</div></div>
        <div class="kv"><div class="kv-key">满星关卡</div><div class="kv-val">${totals.perfectNodes} 个</div></div>
        <div class="kv"><div class="kv-key">导入次数</div><div class="kv-val">${imports.length} 次</div></div>
        <div class="kv"><div class="kv-key">本地占用</div><div class="kv-val">${
          est ? `${(est.usage / 1048576).toFixed(2)} MB / 配额 ${(est.quota / 1048576).toFixed(0)} MB` : "浏览器未提供估算"
        }</div></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">关于统计口径</h2></div>
      <div class="card">
        <div class="kv"><div class="kv-key">数据来源</div><div class="kv-val">本机 IndexedDB（daily_stats / progress / review_records / wrong_answers / cards / quiz_sessions）</div></div>
        <div class="kv"><div class="kv-key">统计方式</div><div class="kv-val">每日聚合 + 档案状态回放，无云端、无估算、无虚构</div></div>
        <div class="kv"><div class="kv-key">图表实现</div><div class="kv-val">内联 SVG 绘制，零第三方依赖、离线可用</div></div>
        <div class="kv"><div class="kv-key">数据库迁移</div><div class="kv-val">${escapeHtml(migrationLog().join("；") || "本次会话未执行迁移")}</div></div>
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/badges">徽章墙</button>
          <button class="btn btn-ghost btn-sm" type="button" data-go="/about">验收自检说明</button>
        </div>
      </div>
    </section>

    <section class="section">
      <button class="btn btn-lg btn-block" type="button" data-go="/learn">继续闯关</button>
    </section>`;
  },
  mount(ctx, root) {
    root.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-go]");
      if (el) navigate(el.dataset.go);
    });
  },
};

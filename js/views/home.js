/**
 * 首页（提示词 六.2 + 5.2）
 * 今日任务（学习/复习数量）、连击、XP 与段位、红心、快捷入口、薄弱提醒、空状态引导
 * 所有数字都来自真实学习记录；无内容时绝不显示虚构数据（验收 9）
 * @module views/home
 */

import { state, refreshSummary } from "../core/state.js";
import { escapeHtml, fmtTime, relTime, truncate } from "../core/util.js";
import { recentImports } from "../import/pipeline.js";
import { APP } from "../config.js";
import { on, EV } from "../core/events.js";
import { getAll, STORES, readSettings } from "../core/db.js";
import { todayOverview, rankOf, BADGES } from "../core/game.js";
import { listMapSummary } from "../core/level.js";
import { buildQueue, listRecords, ensureRecordsForItems } from "../core/scheduler.js";

export const homeView = {
  title: APP.name,
  tab: "home",
  async render() {
    await refreshSummary();
    if (!state.summary.hasContent) return emptyHtml();
    return await contentHtml();
  },
  mount(ctx, root) {
    // 红心恢复倒计时（每秒刷新提示文本）
    const timer = setInterval(() => {
      const el = root.querySelector("#heart-timer");
      if (!el) return clearInterval(timer);
      const sec = Number(el.dataset.sec || 0) - 1;
      if (sec <= 0) {
        clearInterval(timer);
        ctx.reload?.();
        return;
      }
      el.dataset.sec = String(sec);
      el.textContent = `下一颗红心 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    }, 1000);
    const off = on(EV.DATA_CHANGED, () => ctx.reload?.());
    return () => {
      clearInterval(timer);
      off();
    };
  },
};

function emptyHtml() {
  return `
  <section class="section">
    <div class="empty">
      <div class="empty-icon">🩺</div>
      <div class="empty-title">还没有学习内容</div>
      <p class="empty-text">
        本应用不内置任何题库——所有知识点、题目、解析都来自你自己的 Markdown 文件。<br />
        导入后即可开始「点 → 线 → 面」闯关、艾宾浩斯复习与卡片翻阅。
      </p>
      <button class="btn btn-lg btn-block" type="button" data-go="/import">📥 导入我的内容</button>
      <div class="row-wrap mt" style="justify-content:center">
        <button class="btn btn-ghost btn-sm" type="button" data-go="/settings">先看看设置</button>
        <button class="btn btn-ghost btn-sm" type="button" data-go="/guide">内容怎么写？</button>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">三步开始</h2></div>
    <div class="card">
      <div class="row"><span class="badge badge-green">1</span><div class="grow"><span class="strong">下载《内容导入模板.md》</span><div class="small muted">按「# 科目 / ## 章节 / ### 知识点」整理你的笔记</div></div></div>
      <hr />
      <div class="row"><span class="badge badge-green">2</span><div class="grow"><span class="strong">把 .md 文件拖进来</span><div class="small muted">支持一次选多个文件，导入前会显示解析预览与校验报告</div></div></div>
      <hr />
      <div class="row"><span class="badge badge-green">3</span><div class="grow"><span class="strong">开始闯关与复习</span><div class="small muted">点线面关卡 → 错题沉淀 → 精华卡片 → 遗忘曲线复习</div></div></div>
    </div>
  </section>

  <p class="small muted center">纯本地运行 · 无后端 · 无登录 · 断网可用</p>`;
}

async function contentHtml() {
  const settings = readSettings();
  const ov = await todayOverview();
  const rank = rankOf(ov.xp);
  const maps = await listMapSummary({ unlockStars: settings.unlockStars });
  const totalNodes = maps.reduce((n, m) => n + m.total, 0);
  const clearedNodes = maps.reduce((n, m) => n + m.cleared, 0);
  const nextMap = maps.find((m) => m.nextNode);

  const items = await getAll(STORES.learn_items);
  // 复习队列（Phase 3）：补齐档案后统计今日到期
  await ensureRecordsForItems(items);
  const records = await listRecords();
  const queue = buildQueue(records, { dailyNewLimit: settings.dailyNewLimit ?? 20 });
  const reviewDue = queue.dueCount + queue.newCount;
  const imports = await recentImports(3);
  const bySubject = new Map();
  for (const it of items) {
    if (!bySubject.has(it.subject)) bySubject.set(it.subject, { items: 0, questions: 0 });
    bySubject.get(it.subject).items++;
  }
  for (const q of await getAll(STORES.questions)) {
    if (!bySubject.has(q.subject)) bySubject.set(q.subject, { items: 0, questions: 0 });
    bySubject.get(q.subject).questions++;
  }
  const subjectRows = [...bySubject.entries()]
    .map(
      ([name, s]) => `
      <button class="list-item" type="button" data-subject="${escapeHtml(name)}">
        <span class="list-item-icon">📘</span>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(name)}</div>
          <div class="list-item-sub">知识点 ${s.items} · 题目 ${s.questions}</div>
        </div>
        <span class="list-item-chev">›</span>
      </button>`
    )
    .join("");

  const importRows = imports
    .map(
      (m) => `
      <div class="kv">
        <div class="kv-key">${escapeHtml((m.files || []).join("、") || "导入记录")}</div>
        <div class="kv-val">${m.items} 知识点 / ${m.questions} 题 · ${relTime(m.created_at)}</div>
      </div>`
    )
    .join("");

  const hearts = Array.from({ length: ov.hearts.max }, (_, i) => (i < ov.hearts.hearts ? "❤️" : "🖤")).join("");
  const questionsTotal = state.summary.questions;
  const quizHint =
    questionsTotal === 0
      ? "你的内容里还没有题目：点关卡会以「学习卡 + 自测」形式进行"
      : `题库共 ${questionsTotal} 题 · 点关卡每关抽 1–3 题`;

  return `
  <section class="section">
    <div class="card">
      <div class="row-between">
        <div>
          <div class="tiny muted">今日任务</div>
          <div class="strong" style="font-size:1.05rem">${
            ov.goal.reached ? "今日目标已达成 🎉" : `还差 ${ov.goal.remaining} XP 达成每日目标`
          }</div>
        </div>
        <div class="col" style="align-items:flex-end">
          <span class="badge badge-gold">${rank.icon} ${escapeHtml(rank.name)}</span>
          <span class="nowrap small" title="红心">${hearts}</span>
        </div>
      </div>
      <div class="progress mt"><div class="progress-fill" style="width:${ov.goal.percent}%"></div></div>
      <div class="row-between tiny muted mt">
        <span>今日 ${ov.daily.xp} / ${ov.goal.goal} XP</span>
        <span>🔥 连续打卡 ${ov.streak.streak} 天${ov.streak.best ? `（最长 ${ov.streak.best} 天）` : ""}</span>
      </div>
      ${
        ov.hearts.hearts < ov.hearts.max
          ? `<div id="heart-timer" class="tiny muted mt" data-sec="${ov.recoverSeconds}">下一颗红心 ${Math.floor(
              ov.recoverSeconds / 60
            )}:${String(ov.recoverSeconds % 60).padStart(2, "0")}</div>`
          : ""
      }
      <div class="row-wrap mt">
        ${
          nextMap
            ? `<button class="btn grow" type="button" data-continue="${escapeHtml(nextMap.subject)}">▶️ 继续学习：${escapeHtml(
                truncate(nextMap.nextNode.title, 12)
              )}</button>`
            : '<button class="btn grow" type="button" data-go="/learn">🗺️ 去关卡地图</button>'
        }
        <button class="btn ${reviewDue ? "btn-blue" : "btn-ghost"}" type="button" data-go="/review">🔁 今日复习${
          reviewDue ? `（${reviewDue}）` : ""
        }</button>
      </div>
      <p class="field-hint mt">${escapeHtml(quizHint)} · 今日答题 ${ov.daily.correct}/${ov.daily.total} · 今日复习 ${
        ov.daily.reviews || 0
      } 项 · 到期 ${queue.dueCount} / 新内容 ${queue.newCount}${queue.weakCount ? ` / 薄弱 ${queue.weakCount}` : ""}</p>
    </div>
  </section>

  <section class="section">
    <div class="stats">
      <div class="stat"><div class="stat-value">${state.summary.items}</div><div class="stat-label">知识点</div></div>
      <div class="stat"><div class="stat-value">${questionsTotal}</div><div class="stat-label">题目</div></div>
      <div class="stat"><div class="stat-value">${clearedNodes}/${totalNodes}</div><div class="stat-label">通过关卡</div></div>
      <div class="stat"><div class="stat-value">${state.summary.stars || 0}</div><div class="stat-label">获得星数</div></div>
      <div class="stat"><div class="stat-value">${ov.xp}</div><div class="stat-label">累计 XP</div></div>
      <div class="stat"><div class="stat-value">${ov.badges.length}/${BADGES.length}</div><div class="stat-label">徽章</div></div>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">科目</h2><span class="section-sub">共 ${state.summary.subjects.length} 个</span></div>
    <div class="list">${subjectRows}</div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">快捷入口</h2></div>
    <div class="list">
      <button class="list-item" type="button" data-go="/learn"><span class="list-item-icon">🗺️</span><div class="list-item-body"><div class="list-item-title">关卡地图</div><div class="list-item-sub">点 ${maps.reduce(
        (n, m) => n + m.points,
        0
      )} · 线 ${maps.reduce((n, m) => n + m.lines, 0)} · 面 ${maps.reduce((n, m) => n + m.faces, 0)} · 已通过 ${clearedNodes}</div></div><span class="list-item-chev">›</span></button>
      <button class="list-item" type="button" data-go="/badges"><span class="list-item-icon">🏅</span><div class="list-item-body"><div class="list-item-title">徽章墙</div><div class="list-item-sub">已获得 ${ov.badges.length} / ${BADGES.length} 枚</div></div><span class="list-item-chev">›</span></button>
      <button class="list-item" type="button" data-go="/review"><span class="list-item-icon">🔁</span><div class="list-item-body"><div class="list-item-title">复习队列</div><div class="list-item-sub">今日到期 ${queue.dueCount} · 新内容 ${queue.newCount} · 薄弱 ${queue.weakCount}（艾宾浩斯调度）</div></div><span class="list-item-chev">›</span></button>
      <button class="list-item" type="button" data-go="/wrong"><span class="list-item-icon">❌</span><div class="list-item-body"><div class="list-item-title">错题本</div><div class="list-item-sub">Phase 4 开放 · 一键生成精华卡片</div></div><span class="list-item-chev">›</span></button>
      <button class="list-item" type="button" data-go="/cards"><span class="list-item-icon">📖</span><div class="list-item-body"><div class="list-item-title">精华卡片</div><div class="list-item-sub">Phase 4 开放 · 电子书式翻阅</div></div><span class="list-item-chev">›</span></button>
      <button class="list-item" type="button" data-go="/stats"><span class="list-item-icon">📊</span><div class="list-item-body"><div class="list-item-title">学习统计</div><div class="list-item-sub">XP 热力图 · 掌握曲线</div></div><span class="list-item-chev">›</span></button>
      <button class="list-item" type="button" data-go="/settings"><span class="list-item-icon">⚙️</span><div class="list-item-body"><div class="list-item-title">设置 / 备份 / 环境检测</div><div class="list-item-sub">导出备份、每日目标、主题、动效开关</div></div><span class="list-item-chev">›</span></button>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="section-title">最近导入</h2></div>
    <div class="card">${importRows || '<p class="muted small">暂无导入记录</p>'}</div>
  </section>

  <p class="small muted center">数据保存在本机浏览器（IndexedDB）· 最近更新 ${fmtTime(Date.now())}</p>`;
}

/**
 * 我的 / 内容规范说明（复习、卡片、错题、统计均已拆分为独立视图）
 * 绝不显示虚构数据（验收 9）
 * @module views/placeholders
 */

import { escapeHtml } from "../core/util.js";
import { APP } from "../config.js";
import { loadGame, rankOf, collectStats, BADGES, badgeInfo } from "../core/game.js";
import { listImports } from "../core/db.js";
import { state } from "../core/state.js";

function phaseCard(icon, title, phase, points, actions = "") {
  return `
  <section class="section">
    <div class="empty">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      <p class="empty-text">${points}</p>
      <div class="row-wrap" style="justify-content:center">
        <span class="phase-tag">${phase}</span>
        ${actions}
      </div>
    </div>
  </section>`;
}

export const reviewView = {
  title: "复习",
  tab: "review",
  async render() {
    const game = await loadGame();
    return `
    <section class="section">
      <div class="stats">
        <div class="stat"><div class="stat-value">${game.streak.streak}</div><div class="stat-label">连续打卡</div></div>
        <div class="stat"><div class="stat-value">${game.totals.reviews || 0}</div><div class="stat-label">累计复习题</div></div>
        <div class="stat"><div class="stat-value">${game.hearts.hearts}/${game.hearts.max}</div><div class="stat-label">红心</div></div>
        <div class="stat"><div class="stat-value">${game.totals.lessons || 0}</div><div class="stat-label">累计关卡</div></div>
      </div>
    </section>
    ${phaseCard(
      "🔁",
      "复习队列（艾宾浩斯遗忘曲线）",
      "Phase 3 开放",
      "将按第 1、2、4、7、15、30、60 天安排复习；支持闪卡自评与测验复习、复习日历热力图、到期提醒通知。现在可以直接去关卡反复练习已学知识点。",
      '<button class="btn btn-sm btn-ghost" type="button" data-go="/learn">去关卡练习</button>'
    )}`;
  },
};

export const profileView = {
  title: "我的",
  tab: "profile",
  async render() {
    const game = await loadGame();
    const rank = rankOf(game.xp);
    const stats = await collectStats(game);
    const imports = await listImports();
    const recentBadges = game.badges.slice(-3).map(badgeInfo);
    return `
    <section class="section">
      <div class="card">
        <div class="row">
          <div style="font-size:2.4rem">🙋</div>
          <div class="grow">
            <div class="strong" style="font-size:1.1rem">本地学习者</div>
            <div class="small muted">数据只保存在这台设备上 · 无需登录</div>
          </div>
          <span class="badge badge-purple">${rank.icon} ${escapeHtml(rank.name)}</span>
        </div>
        <div class="progress mt"><div class="progress-fill" style="width:${rank.progress}%"></div></div>
        <div class="tiny muted mt">${rank.next ? `距 ${escapeHtml(rank.next.name)} 还需 ${rank.toNext} XP` : "已达最高段位"}</div>
        <div class="stats mt">
          <div class="stat"><div class="stat-value">${stats.xp}</div><div class="stat-label">累计 XP</div></div>
          <div class="stat"><div class="stat-value">${stats.streak}</div><div class="stat-label">连续打卡</div></div>
          <div class="stat"><div class="stat-value">${game.badges.length}</div><div class="stat-label">徽章</div></div>
        </div>
      </div>
    </section>

    ${
      recentBadges.length
        ? `<section class="section"><div class="card">
            <div class="row-between"><span class="strong">最近获得的徽章</span><button class="btn-quiet" type="button" data-go="/badges">全部 ›</button></div>
            <div class="row-wrap mt">${recentBadges
              .map((b) => `<span class="badge badge-gold">${b.icon} ${escapeHtml(b.name)}</span>`)
              .join("")}</div>
          </div></section>`
        : ""
    }

    <section class="section">
      <div class="list">
        <button class="list-item" type="button" data-go="/learn"><span class="list-item-icon">🗺️</span><div class="list-item-body"><div class="list-item-title">关卡地图</div><div class="list-item-sub">点线面闯关 · 星级与解锁进度</div></div><span class="list-item-chev">›</span></button>
        <button class="list-item" type="button" data-go="/badges"><span class="list-item-icon">🏅</span><div class="list-item-body"><div class="list-item-title">徽章墙与段位</div><div class="list-item-sub">已获得 ${game.badges.length} / ${BADGES.length} 枚</div></div><span class="list-item-chev">›</span></button>
        <button class="list-item" type="button" data-go="/import"><span class="list-item-icon">📥</span><div class="list-item-body"><div class="list-item-title">导入 / 管理内容</div><div class="list-item-sub">当前 ${state.summary.items} 知识点 · ${state.summary.questions} 题 · 导入 ${imports.length} 次</div></div><span class="list-item-chev">›</span></button>
        <button class="list-item" type="button" data-go="/wrong"><span class="list-item-icon">❌</span><div class="list-item-body"><div class="list-item-title">错题本</div><div class="list-item-sub">Phase 4 开放</div></div><span class="list-item-chev">›</span></button>
        <button class="list-item" type="button" data-go="/stats"><span class="list-item-icon">📊</span><div class="list-item-body"><div class="list-item-title">学习统计</div><div class="list-item-sub">XP 热力图 · 科目掌握度</div></div><span class="list-item-chev">›</span></button>
        <button class="list-item" type="button" data-go="/guide"><span class="list-item-icon">📘</span><div class="list-item-body"><div class="list-item-title">内容编写规范</div><div class="list-item-sub"># 科目 / ## 章节 / ### 知识点 + 区块规范</div></div><span class="list-item-chev">›</span></button>
        <button class="list-item" type="button" data-go="/settings"><span class="list-item-icon">⚙️</span><div class="list-item-body"><div class="list-item-title">设置</div><div class="list-item-sub">每日目标、复习参数、主题、备份、环境检测</div></div><span class="list-item-chev">›</span></button>
      </div>
    </section>

    <section class="section">
      <div class="card">
        <div class="kv"><div class="kv-key">应用版本</div><div class="kv-val">${escapeHtml(APP.version)} · ${escapeHtml(APP.phase)}</div></div>
        <div class="kv"><div class="kv-key">存储方式</div><div class="kv-val">IndexedDB + localStorage（纯本地）</div></div>
      </div>
    </section>`;
  },
};

/** 内容编写规范说明页（离线可看） */
export const guideView = {
  title: "内容编写规范",
  back: true,
  render() {
    return `
    <section class="section">
      <div class="note note-ok"><span>📘</span><div>
        <strong>一句话规则：</strong><code>#</code> = 科目，<code>##</code> = 章节，<code>###</code> = 知识点；
        知识点下用「要点 / 易错点 / 题目」区块。题目一律来自你自己编写的内容，应用不生成任何医学知识。
      </div></div>
    </section>

    <section class="section">
      <div class="card">
        <h2 class="card-title">1. 层级与元信息</h2>
        <pre class="mono" style="white-space:pre-wrap"># 生理学

## 第一章 细胞的基本功能

### 静息电位的产生机制
难度：2
标签：离子通道,生物电
关联：动作电位

这里是知识点正文，支持**加粗**、列表、引用。</pre>
        <p class="small muted">难度取 1–3（也可写 ★ 数量）；标签、关联均为可选，用逗号分隔。关联会自动匹配同名的其他知识点。</p>
      </div>

      <div class="card">
        <h2 class="card-title">2. 要点 / 易错点区块</h2>
        <pre class="mono" style="white-space:pre-wrap">**要点：**
- 静息电位约 -70 mV
- 主要由 K⁺ 外流形成

**易错点：**
- 勿与动作电位去极化的离子机制混淆</pre>
        <p class="small muted">要点会成为精华卡片的正面，也是线关卡「连线匹配」的素材；易错点成为背面（Phase 4）。每行一条，以「- 」开头。</p>
      </div>

      <div class="card">
        <h2 class="card-title">3. 题目区块（四种题型）</h2>
        <pre class="mono" style="white-space:pre-wrap">**题目：**
1. 题干（默认单选）
   A. 选项一
   B. 选项二
   C. 选项三
   D. 选项四
   答案：B
   解析：解析文字（可省略）
2. （多选）题干 → 答案：A,B
3. （判断）题干 → 答案：对 / 错
4. （配伍）题干 → 答案：A-1,B-2</pre>
        <p class="small muted">题型由题干中的「（多选）」「（判断）」「（配伍）」标记判定；缺「答案：」或答案格式非法会报错并跳过该题，行号会写进导入报告。<strong>点关卡每关抽 1–3 题、面关卡从本章/全科题库抽题</strong>，所以想让关卡有题做，就在笔记里写「题目：」区块。</p>
      </div>

      <div class="card">
        <h2 class="card-title">4. 笔记没有三级标题怎么办？</h2>
        <p class="card-text">
          若你的笔记是 PDF / 导图转录稿（用加粗标题或列表分条，没有 <code>###</code>），导入时可切换
          <strong>宽松模式</strong>：应用会把「加粗标题行」「顶层列表项」识别为知识点，并在报告中说明识别依据。
          宽松模式只是调整归属规则，不会新增或改写任何内容。
        </p>
        <p class="small muted">仍建议逐步整理成标准层级，关卡、复习与卡片效果更好。</p>
      </div>

      <div class="card">
        <h2 class="card-title">5. 兼容格式</h2>
        <p class="card-text">除 Markdown 外，也可导入 CSV / Excel / JSON。列名可用别名（科目/学科、知识点/考点/名称、要点/重点、题目/题干、答案、解析、题型），导入时会自动猜测并允许手动调整字段映射。</p>
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/import">去导入</button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="note"><span>🔒</span><div>再次说明：应用<strong>不内置任何题库、不调用 AI 生成医学内容</strong>。模板里的示例行都标注了「仅格式示例」，请全部替换为你自己的内容。</div></div>
    </section>`;
  },
};

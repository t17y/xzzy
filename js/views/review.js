/**
 * 复习队列页（提示词 六.8）
 * 今日到期清单（按到期时间升序）+ 复习日历（未来 30 天负荷热力图）+ 薄弱知识点队列
 * @module views/review
 */

import { escapeHtml, groupBy, pct, truncate } from "../core/util.js";
import { toast, modal } from "../core/dom.js";
import { navigate } from "../core/router.js";
import { readSettings, listSubjects, getAll, STORES } from "../core/db.js";
import {
  buildQueue,
  forecastLoad,
  listRecords,
  ensureRecordsForItems,
  reviewStats,
  explainSchedule,
  getRecord,
  isWeak,
  overdueDays,
  REVIEW_STATUS,
} from "../core/scheduler.js";
import { reminderStatus, requestPermission, scheduleReminder, showNotification, currentReminder } from "../core/notify.js";
import { refreshSummary } from "../core/state.js";
import { on, EV } from "../core/events.js";

const S = { range: 30, filter: "" };

export const reviewView = {
  title: "复习",
  tab: "review",
  async render() {
    // 首次进入时补齐复习档案（已有知识点但还没有档案）
    const items = await getAll(STORES.learn_items);
    await ensureRecordsForItems(items);
    const settings = readSettings();
    const records = await listRecords();
    const queue = buildQueue(records, { dailyNewLimit: settings.dailyNewLimit ?? 20 });
    const stats = reviewStats(records);
    const forecast = forecastLoad(records, S.range);
    const reminder = await reminderStatus();
    const subjects = await listSubjects();

    if (!items.length) return emptyHtml();

    const filtered = S.filter ? queue.queue.filter((r) => r.subject === S.filter) : queue.queue;
    const rows = filtered.slice(0, 100).map((r) => queueRowHtml(r)).join("");
    const weakRows = (S.filter ? queue.weak.filter((r) => r.subject === S.filter) : queue.weak)
      .slice(0, 10)
      .map(
        (r) => `<button class="list-item" type="button" data-detail="${escapeHtml(r.id)}">
          <span class="list-item-icon">⚠️</span>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(truncate(r.title, 22))}</div>
            <div class="list-item-sub">${escapeHtml(r.subject)} · 答错 ${r.lapses} 次 · 逾期 ${Math.max(
              0,
              overdueDays(r)
            )} 天 · 间隔 ${r.interval} 天</div>
          </div>
          <span class="list-item-chev">›</span></button>`
      )
      .join("");

    const maxLoad = Math.max(1, ...forecast.map((f) => f.count));
    const heat = forecast
      .map((f) => {
        const h = Math.round((f.count / maxLoad) * 100);
        const level = f.count === 0 ? 0 : f.count <= 2 ? 1 : f.count <= 5 ? 2 : f.count <= 10 ? 3 : 4;
        return `<div class="cal-cell" title="${f.date_key}：${f.count} 项${f.overdue ? `（含逾期 ${f.overdue}）` : ""}" data-load="${level}">
          <div class="cal-bar" style="height:${Math.max(3, h)}%"></div>
          <div class="cal-day">${f.date_key.slice(8)}</div>
        </div>`;
      })
      .join("");

    const subjectChips = subjects
      .map(
        (s) =>
          `<button class="chip ${S.filter === s ? "chip-on" : ""}" type="button" data-filter="${escapeHtml(s)}">${escapeHtml(s)}</button>`
      )
      .join("");

    return `
    <section class="section">
      <div class="card">
        <div class="row-between">
          <div>
            <div class="tiny muted">今日到期</div>
            <div class="strong" style="font-size:1.6rem;line-height:1.2">${queue.dueCount + queue.newCount}</div>
          </div>
          <div class="col" style="align-items:flex-end;gap:4px">
            <span class="badge badge-green">到期 ${queue.dueCount}</span>
            <span class="badge badge-blue">新内容 ${queue.newCount}</span>
            <span class="badge badge-red">薄弱 ${queue.weakCount}</span>
          </div>
        </div>
        <div class="progress mt"><div class="progress-fill" style="width:${pct(queue.dueCount, Math.max(1, queue.dueCount + queue.newCount))}%"></div></div>
        <div class="row-wrap mt">
          <button class="btn grow" type="button" data-start="flash" ${queue.total ? "" : "disabled"}>🃏 闪卡自评（${
            queue.total
          }）</button>
          <button class="btn btn-blue" type="button" data-start="quiz" ${queue.total ? "" : "disabled"}>📝 测验复习</button>
        </div>
        <p class="field-hint mt">闪卡自评：看知识点 → 自评「记得 / 模糊 / 忘记」；测验复习：从该知识点的题目抽题作答，两者都会驱动同一个调度器。</p>
      </div>
    </section>

    <section class="section">
      <div class="stats">
        <div class="stat"><div class="stat-value">${stats.due}</div><div class="stat-label">已到期</div></div>
        <div class="stat"><div class="stat-value">${stats.learned}</div><div class="stat-label">已学</div></div>
        <div class="stat"><div class="stat-value">${stats.mastered}</div><div class="stat-label">已掌握</div></div>
        <div class="stat"><div class="stat-value">${stats.weak}</div><div class="stat-label">薄弱</div></div>
        <div class="stat"><div class="stat-value">${stats.totalReviews}</div><div class="stat-label">累计复习</div></div>
        <div class="stat"><div class="stat-value">${stats.totalLapses}</div><div class="stat-label">累计答错</div></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">复习日历</h2><span class="section-sub">未来 ${S.range} 天负荷</span></div>
      <div class="card">
        <div class="calendar">${heat}</div>
        <div class="row-between tiny muted mt"><span>今天</span><span>第 ${S.range} 天</span></div>
        <div class="row-wrap mt">
          ${[7, 14, 30, 60]
            .map((d) => `<button class="chip ${S.range === d ? "chip-on" : ""}" type="button" data-range="${d}">${d} 天</button>`)
            .join("")}
        </div>
        <p class="field-hint">柱子越高表示当天到期越多；颜色越深表示负荷越大。逾期的条目统一计入「今天」。</p>
      </div>
    </section>

    ${
      reminder.enabled
        ? `<section class="section"><div class="note note-ok"><span>🔔</span><div>
            每日提醒已开启：${escapeHtml(reminder.time)}（权限：${escapeHtml(reminder.permission)}）
            ${reminder.sentToday ? "· 今天已提醒" : "· 今天尚未提醒"}<br />
            <span class="small">提醒文案预览：${escapeHtml(reminder.preview.body)}</span>
          </div></div></section>`
        : `<section class="section"><div class="note"><span>🔔</span><div>
            还没有开启每日提醒。可在「设置 → 提醒」中开启（默认 20:00，文案包含今日到期数量）。
            <button class="btn-quiet" type="button" data-enable-notify>立即开启</button>
          </div></div></section>`
    }

    <section class="section">
      <div class="section-head"><h2 class="section-title">今日清单</h2><span class="section-sub">共 ${filtered.length} 项${
        filtered.length > 100 ? "（仅显示前 100）" : ""
      }</span></div>
      <div class="row-wrap mb">${subjectChips}${S.filter ? '<button class="chip" type="button" data-filter="">全部</button>' : ""}</div>
      ${rows || '<div class="note note-ok"><span>✅</span><div>今天没有到期内容。可以去关卡继续闯关，或新增内容。</div></div>'}
    </section>

    ${
      weakRows
        ? `<section class="section">
            <div class="section-head"><h2 class="section-title">薄弱知识点</h2><span class="section-sub">答错过的优先复习</span></div>
            <div class="list">${weakRows}</div>
          </section>`
        : ""
    }

    <section class="section">
      <div class="section-head"><h2 class="section-title">复习档案（算法透明）</h2></div>
      <div class="card">
        <div class="kv"><div class="kv-key">间隔阶梯</div><div class="kv-val">${(readSettings().reviewIntervals || []).join(" → ")} 天</div></div>
        <div class="kv"><div class="kv-key">已掌握规则</div><div class="kv-val">连续正确 ${readSettings().masteredStreak} 次</div></div>
        <div class="kv"><div class="kv-key">答错处理</div><div class="kv-val">间隔重置为 1 天，进入薄弱队列</div></div>
        <div class="kv"><div class="kv-key">每日新内容上限</div><div class="kv-val">${readSettings().dailyNewLimit ?? 20} 项（可在设置中调整）</div></div>
        <p class="field-hint mt">点击清单中的任一项，可查看它的完整复习档案（间隔变化历史、错误次数）。</p>
      </div>
    </section>

    <section class="section">
      <button class="btn btn-lg btn-block" type="button" data-go="/learn">去关卡继续闯关</button>
    </section>`;
  },

  mount(ctx, root) {
    root.addEventListener("click", async (ev) => {
      const el = ev.target.closest("[data-start],[data-filter],[data-range],[data-detail],[data-enable-notify],[data-go]");
      if (!el) return;
      if (el.dataset.go) return navigate(el.dataset.go);
      if (el.dataset.range) {
        S.range = Number(el.dataset.range);
        return ctx.reload?.();
      }
      if (el.hasAttribute("data-filter")) {
        S.filter = el.dataset.filter;
        return ctx.reload?.();
      }
      if (el.dataset.start) {
        navigate("/review-session", { mode: el.dataset.start, subject: S.filter || "" });
        return;
      }
      if (el.dataset.detail) {
        return showRecordDetail(el.dataset.detail);
      }
      if (el.hasAttribute("data-enable-notify")) {
        const p = await requestPermission();
        if (p === "granted") {
          const msg = await currentReminder();
          await showNotification("西综多邻国 · 通知已开启", { body: msg.body, tag: "xzzy-test" });
          const { updateSettings } = await import("../core/state.js");
          updateSettings({ notifyEnabled: true });
          await scheduleReminder();
          toast("已开启每日复习提醒", { type: "ok" });
        } else {
          toast("未获得通知权限，可在浏览器设置中开启", { type: "warn" });
        }
        return ctx.reload?.();
      }
    });
    const off = on(EV.DATA_CHANGED, (p) => {
      if (p?.reason === "review") ctx.reload?.();
    });
    return () => off();
  },
};

function emptyHtml() {
  return `<section class="section"><div class="empty">
    <div class="empty-icon">🔁</div>
    <div class="empty-title">还没有可复习的内容</div>
    <p class="empty-text">复习队列由你导入的知识点自动生成：导入内容后，每个知识点都会建立复习档案，并按第 1、2、4、7、15、30、60 天安排复习。</p>
    <button class="btn btn-lg btn-block" type="button" data-go="/import">📥 导入内容</button>
  </div></section>`;
}

function queueRowHtml(r) {
  const overdue = overdueDays(r);
  const badge =
    r.status === REVIEW_STATUS.NEW
      ? '<span class="badge badge-blue">新内容</span>'
      : overdue > 0
        ? `<span class="badge badge-red">逾期 ${overdue} 天</span>`
        : '<span class="badge badge-green">今日到期</span>';
  const status =
    r.status === REVIEW_STATUS.MASTERED ? "已掌握（低频巡访）" : r.status === REVIEW_STATUS.LEARNING ? `学习中 · 间隔 ${r.interval} 天` : "尚未复习";
  return `<button class="list-item" type="button" data-detail="${escapeHtml(r.id)}">
    <span class="list-item-icon">${r.status === REVIEW_STATUS.NEW ? "🆕" : r.lapses ? "⚠️" : "📌"}</span>
    <div class="list-item-body">
      <div class="list-item-title">${escapeHtml(truncate(r.title, 24))}</div>
      <div class="list-item-sub">${escapeHtml(r.subject)}${r.chapter ? ` · ${escapeHtml(truncate(r.chapter, 10))}` : ""} · ${escapeHtml(status)}</div>
    </div>
    ${badge}
  </button>`;
}

/** 复习档案详情（算法透明度） */
async function showRecordDetail(id) {
  const [targetType, ...rest] = String(id).split(":");
  const targetId = rest.join(":");
  const record = await getRecord(targetType, targetId);
  if (!record) return toast("找不到该复习档案", { type: "warn" });
  const lines = explainSchedule(record, readSettings());
  await modal({
    title: record.title || "复习档案",
    body: `<div class="kv"><div class="kv-key">所属</div><div class="kv-val">${escapeHtml(record.subject)} · ${escapeHtml(record.chapter || "—")}</div></div>
      <div class="kv"><div class="kv-key">状态</div><div class="kv-val">${
        { new: "新卡", learning: "学习中", mastered: "已掌握" }[record.status] || record.status
      }</div></div>
      <div class="kv"><div class="kv-key">当前间隔</div><div class="kv-val">${record.interval || 0} 天</div></div>
      <div class="kv"><div class="kv-key">下次复习</div><div class="kv-val">${escapeHtml(record.next_review_date || "—")}</div></div>
      <div class="kv"><div class="kv-key">复习次数 / 答错</div><div class="kv-val">${record.review_count || 0} / ${record.lapses || 0}</div></div>
      <h3 class="card-title mt">调度解释</h3>
      <ul class="tight small">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    actions: [{ label: "知道了", value: "ok", kind: "btn" }],
  });
}

export { groupBy, isWeak };

/**
 * 复习提醒（提示词 5.3：PWA Notification，默认 20:00，文案含今日到期数量）
 *
 * 说明与限制（诚实告知用户）：
 * - 纯前端没有服务器推送（无 Push 订阅），因此**应用运行或在后台标签页时**提醒可靠；
 * - 应用被彻底关闭后，浏览器不会唤醒页面去提醒——打开应用时若已过提醒时间且今天未提醒，会补发一次；
 * - 若希望更可靠的提醒，可把应用安装到主屏幕并保持后台标签页。
 *
 * @module core/notify
 */

import { readGameState, writeGameState, readSettings, STORES, getAll } from "./db.js";
import { todayKey } from "./util.js";
import { buildQueue, listRecords } from "./scheduler.js";

const LAST_SENT_KEY = "notify:last-sent";

/** 当前通知权限 */
export function permission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** 请求通知权限（用户点击开关时调用） */
export async function requestPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** 通过 Service Worker 显示通知（移动端更可靠），失败时回落到 Notification 构造器 */
export async function showNotification(title, options = {}) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const opts = {
    body: options.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: options.tag || "xzzy-review",
    data: options.data || { url: "./#/review" },
    requireInteraction: false,
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && reg.showNotification) {
      await reg.showNotification(title, opts);
      return true;
    }
  } catch {
    /* 落到构造器 */
  }
  try {
    // eslint-disable-next-line no-new
    new Notification(title, opts);
    return true;
  } catch {
    return false;
  }
}

/** 计算距离下一次提醒时间的毫秒数 */
export function msUntil(timeStr, now = new Date()) {
  const [h, m] = String(timeStr || "20:00")
    .split(":")
    .map((x) => Number(x) || 0);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** 组装提醒文案（含今日到期数量，提示词 5.3） */
export function buildReminderMessage(queue) {
  const due = queue.dueCount || 0;
  const fresh = queue.newCount || 0;
  const weak = queue.weakCount || 0;
  const parts = [];
  if (due) parts.push(`今日到期 ${due} 项`);
  if (fresh) parts.push(`新内容 ${fresh} 项`);
  if (weak) parts.push(`薄弱 ${weak} 项`);
  const body = parts.length ? `${parts.join(" · ")}，点开开始复习 →` : "今天没有到期内容，可以自由练习或新增内容。";
  return { title: "西综多邻国 · 今日复习", body, empty: parts.length === 0 };
}

/** 计算当前应提醒的内容（只读） */
export async function currentReminder() {
  const records = await listRecords();
  const settings = readSettings();
  const queue = buildQueue(records, { dailyNewLimit: settings.dailyNewLimit ?? 20 });
  return buildReminderMessage(queue);
}

/** 是否今天已提醒过 */
async function sentToday() {
  const v = await readGameState(LAST_SENT_KEY, "");
  return v === todayKey();
}

async function markSent() {
  await writeGameState(LAST_SENT_KEY, todayKey());
}

let timer = null;

/**
 * 启动每日提醒调度（应用运行期间生效）
 * @param {{onFire?: (msg:{title:string, body:string, empty:boolean}) => void}} [opts]
 */
export async function scheduleReminder(opts = {}) {
  clearTimeout(timer);
  const settings = readSettings();
  if (!settings.notifyEnabled) return null;
  if (permission() !== "granted") return null;

  const now = new Date();
  const [h, m] = String(settings.notifyTime || "20:00")
    .split(":")
    .map((x) => Number(x) || 0);
  const todayAt = new Date(now);
  todayAt.setHours(h, m, 0, 0);

  // 已过提醒时间且今天还没提醒 → 立即补发一次
  if (todayAt.getTime() <= now.getTime() && !(await sentToday())) {
    const msg = await currentReminder();
    if (!msg.empty) {
      await showNotification(msg.title, { body: msg.body, tag: "xzzy-review" });
      await markSent();
      opts.onFire?.(msg);
    }
  }

  const delay = msUntil(settings.notifyTime, new Date());
  timer = setTimeout(async () => {
    const msg = await currentReminder();
    if (!msg.empty) {
      await showNotification(msg.title, { body: msg.body, tag: "xzzy-review" });
      await markSent();
      opts.onFire?.(msg);
    }
    scheduleReminder(opts); // 递归安排第二天
  }, delay);
  // 页面隐藏/关闭时定时器随页面销毁（已在文档中说明）
  return { nextIn: delay };
}

export function stopReminder() {
  clearTimeout(timer);
  timer = null;
}

/** 提醒状态（设置页展示） */
export async function reminderStatus() {
  const settings = readSettings();
  const msg = await currentReminder();
  return {
    enabled: !!settings.notifyEnabled,
    time: settings.notifyTime || "20:00",
    permission: permission(),
    sentToday: await sentToday(),
    nextInMs: msUntil(settings.notifyTime),
    preview: msg,
  };
}

export { STORES, getAll };

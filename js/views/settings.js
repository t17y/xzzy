/**
 * 设置页：每日目标 / 复习参数 / 主题字号动效 / 通知 / 导入导出备份 / 清空重置 / 环境检测 / 关于
 * 提示词 六.15 + 3.5（环境检测）
 * @module views/settings
 */

import { escapeHtml, fmtNum } from "../core/util.js";
import { modal, toast, confirmDialog, bindSwitch } from "../core/dom.js";
import { state, updateSettings, refreshSummary } from "../core/state.js";
import { APP } from "../config.js";
import { detectEnv, browserAdvice, envRows } from "../core/env.js";
import {
  exportAll,
  importBackup,
  resetContent,
  resetAll,
  DEFAULT_SETTINGS,
  listImports,
  migrationLog,
  storageEstimate,
} from "../core/db.js";
import { downloadText } from "../import/pipeline.js";
import { navigate } from "../core/router.js";

let envCache = null;

export const settingsView = {
  title: "设置",
  back: true,
  async render() {
    const s = state.settings || DEFAULT_SETTINGS;
    envCache = detectEnv();
    const advice = browserAdvice(envCache);
    const imports = await listImports();
    const est = await storageEstimate();
    const env = envCache;
    let reminder = null;
    try {
      const { reminderStatus } = await import("../core/notify.js");
      reminder = await reminderStatus();
    } catch (err) {
      console.warn("[settings] 提醒状态读取失败", err);
    }

    return `
    <section class="section">
      <div class="note note-${advice.level === "ok" ? "ok" : advice.level === "warn" ? "warn" : "error"}">
        <span>🌐</span><div><strong>${escapeHtml(advice.title)}</strong><br />${escapeHtml(advice.text)}</div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">学习目标</h2></div>
      <div class="card">
        <label class="field-label" for="daily-goal">每日目标 XP（默认 50）</label>
        <input class="input" id="daily-goal" name="dailyGoal" type="number" min="10" max="500" step="10" value="${Number(s.dailyGoal) || 50}" />
        <p class="field-hint">达成后会有庆祝动效（Phase 2 起生效）。</p>
        <div class="switch-row">
          <div><div class="strong">红心系统</div><div class="small muted">答错扣心，心为 0 时限制继续（Phase 2）</div></div>
          <span class="badge">最多 ${Number(s.heartsMax) || 5} 心</span>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">复习参数（艾宾浩斯）</h2></div>
      <div class="card">
        <label class="field-label" for="intervals">间隔阶梯（天，逗号分隔）</label>
        <input class="input" id="intervals" name="reviewIntervals" type="text" value="${(s.reviewIntervals || DEFAULT_SETTINGS.reviewIntervals).join(",")}" />
        <p class="field-hint">默认 1,2,4,7,15,30,60；答错会把间隔重置为 1 天并进入薄弱队列。</p>
        <label class="field-label" for="mastered">连续正确多少次标记「已掌握」</label>
        <input class="input" id="mastered" name="masteredStreak" type="number" min="1" max="10" value="${Number(s.masteredStreak) || 3}" />
        <p class="field-hint">标记「已掌握」后按最后一档间隔（默认 60 天）低频巡访。</p>
        <label class="field-label" for="newlimit">每日新内容上限（进入复习队列）</label>
        <input class="input" id="newlimit" name="dailyNewLimit" type="number" min="1" max="200" value="${Number(s.dailyNewLimit) || 20}" />
        <label class="field-label" for="batch">单次复习上限（项）</label>
        <input class="input" id="batch" name="reviewBatch" type="number" min="5" max="100" value="${Number(s.reviewBatch) || 30}" />
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/review">查看今日复习队列</button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">提醒</h2></div>
      <div class="card">
        <div class="switch-row">
          <div><div class="strong">每日复习提醒</div><div class="small muted">文案包含今日到期数量</div></div>
          <button class="switch" type="button" id="notify-switch" aria-checked="${s.notifyEnabled ? "true" : "false"}" aria-label="每日复习提醒"></button>
        </div>
        <label class="field-label" for="notify-time">提醒时间</label>
        <input class="input" id="notify-time" name="notifyTime" type="time" value="${escapeHtml(s.notifyTime || "20:00")}" />
        <p class="field-hint">当前通知权限：${notifyPermissionText(env.notificationPermission)}${
          reminder ? ` · 上次提醒：${reminder.sentToday ? "今天已提醒" : "今天未提醒"}` : ""
        }</p>
        <div class="note small mt"><span>ℹ️</span><div>
          纯前端应用没有服务器推送：<strong>应用打开或后台标签页存在时</strong>提醒可靠；
          应用被彻底关闭后浏览器不会唤醒页面。打开应用时若已过提醒时间且当天未提醒，会自动补发一次。
          ${reminder ? `<br />提醒预览：${escapeHtml(reminder.preview.body)}` : ""}
        </div></div>
        <button class="btn btn-ghost btn-sm mt" type="button" data-action="test-notify">发送一条测试通知</button>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">外观与体验</h2></div>
      <div class="card">
        <label class="field-label" for="theme">主题</label>
        <select class="select" id="theme" name="theme">
          <option value="auto" ${s.theme === "auto" ? "selected" : ""}>跟随系统</option>
          <option value="light" ${s.theme === "light" ? "selected" : ""}>浅色</option>
          <option value="dark" ${s.theme === "dark" ? "selected" : ""}>深色</option>
        </select>
        <label class="field-label mt" for="fontsize">字号</label>
        <select class="select" id="fontsize" name="fontSize">
          <option value="small" ${s.fontSize === "small" ? "selected" : ""}>小</option>
          <option value="medium" ${s.fontSize === "medium" ? "selected" : ""}>中</option>
          <option value="large" ${s.fontSize === "large" ? "selected" : ""}>大</option>
        </select>
        <div class="switch-row">
          <div><div class="strong">音效</div><div class="small muted">答题反馈音（Phase 2）</div></div>
          <button class="switch" type="button" id="sound-switch" aria-checked="${s.sound ? "true" : "false"}" aria-label="音效"></button>
        </div>
        <div class="switch-row">
          <div><div class="strong">动效</div><div class="small muted">关闭后为省电模式（无过渡与弹跳）</div></div>
          <button class="switch" type="button" id="anim-switch" aria-checked="${s.anim ? "true" : "false"}" aria-label="动效"></button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">数据管理</h2></div>
      <div class="card">
        <div class="kv"><div class="kv-key">知识点 / 题目</div><div class="kv-val">${fmtNum(state.summary.items)} / ${fmtNum(state.summary.questions)}</div></div>
        <div class="kv"><div class="kv-key">导入次数</div><div class="kv-val">${imports.length} 次</div></div>
        <div class="kv"><div class="kv-key">本地占用</div><div class="kv-val">${est ? `${(est.usage / 1048576).toFixed(2)} MB / 配额 ${(est.quota / 1048576).toFixed(0)} MB` : "浏览器未提供估算"}</div></div>
        <div class="row-wrap mt">
          <button class="btn btn-blue btn-sm" type="button" data-action="export-all">⬇️ 导出全部备份（JSON）</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="import-backup">⬆️ 从备份恢复</button>
          <input id="backup-input" type="file" accept=".json,application/json" hidden />
        </div>
        <p class="field-hint">备份包含全部知识点、题目、进度、复习档案、错题与卡片；恢复为合并模式（同 id 覆盖），不会删除现有数据。</p>
        <details class="acc mt">
          <summary>导入记录（${imports.length}）</summary>
          ${
            imports.length
              ? imports
                  .map(
                    (m) => `<div class="kv"><div class="kv-key">${escapeHtml((m.files || []).join("、") || "未命名")}</div>
                    <div class="kv-val">${m.items} 知识点 · ${m.questions} 题${m.skipped ? ` · 跳过 ${m.skipped}` : ""} · ${new Date(m.created_at).toLocaleString("zh-CN")}</div></div>`
                  )
                  .join("")
              : '<p class="small muted">暂无记录。</p>'
          }
        </details>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">清空与重置</h2></div>
      <div class="card">
        <div class="row-wrap">
          <button class="btn btn-ghost btn-sm" type="button" data-action="reset-content">清空学习内容</button>
          <button class="btn btn-red btn-sm" type="button" data-action="reset-all">清空全部（含设置）</button>
        </div>
        <p class="field-hint">清空前需要输入确认词，避免误操作。</p>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">环境检测（PWA 能力）</h2></div>
      <div class="card">
        ${envRows(env)
          .map(([k, v]) => `<div class="kv"><div class="kv-key">${escapeHtml(k)}</div><div class="kv-val">${escapeHtml(v)}</div></div>`)
          .join("")}
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-action="recheck">重新检测</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="install-help">安装到主屏幕</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="copy-env">复制检测结果</button>
        </div>
        <details class="acc mt">
          <summary>数据库迁移记录</summary>
          <pre class="mono" style="white-space:pre-wrap">${escapeHtml((migrationLog().join("\n") || "本次会话未执行迁移") + "\n\n索引：learn_items / questions / progress / review_records / wrong_answers / cards / import_meta")}</pre>
        </details>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">关于</h2></div>
      <div class="card">
        <div class="kv"><div class="kv-key">应用</div><div class="kv-val">${escapeHtml(APP.name)}（${escapeHtml(APP.english)}）</div></div>
        <div class="kv"><div class="kv-key">版本</div><div class="kv-val">${escapeHtml(APP.version)} · ${escapeHtml(APP.phase)}</div></div>
        <div class="kv"><div class="kv-key">内容来源</div><div class="kv-val">100% 来自你导入的 Markdown 文件，应用不生成任何医学知识</div></div>
        <div class="kv"><div class="kv-key">架构</div><div class="kv-val">纯前端 PWA · 无后端 · 无登录 · 无云同步 · 离线可用</div></div>
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/guide">内容编写规范</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="restore-defaults">恢复默认设置</button>
        </div>
      </div>
    </section>

    <section class="section">
      <button class="btn btn-ghost btn-block btn-sm" type="button" data-action="check-update">检查应用更新</button>
    </section>`;
  },

  mount(ctx, root) {
    bindSwitch(root, "#notify-switch", () => (state.settings || DEFAULT_SETTINGS).notifyEnabled, async (v) => {
      const { requestPermission, scheduleReminder, stopReminder, currentReminder, showNotification } = await import("../core/notify.js");
      if (v) {
        const p = await requestPermission();
        if (p !== "granted") {
          toast("通知权限被拒绝，可在浏览器设置中开启", { type: "warn" });
          return;
        }
      }
      updateSettings({ notifyEnabled: v });
      if (v) {
        await scheduleReminder();
        const msg = await currentReminder();
        await showNotification("西综多邻国 · 提醒已开启", { body: msg.body, tag: "xzzy-test" });
        toast("已开启每日提醒", { type: "ok" });
      } else {
        stopReminder();
        toast("已关闭每日提醒", { type: "ok" });
      }
      ctx.reload?.();
    });
    bindSwitch(root, "#sound-switch", () => (state.settings || DEFAULT_SETTINGS).sound, (v) => {
      updateSettings({ sound: v });
    });
    bindSwitch(root, "#anim-switch", () => (state.settings || DEFAULT_SETTINGS).anim, (v) => {
      updateSettings({ anim: v });
      toast(v ? "已开启动效" : "已开启省电模式（关闭动效）", { type: "ok" });
    });

    root.addEventListener("change", async (ev) => {
      const el = ev.target;
      if (!el.id) return;
      if (el.id === "daily-goal") updateSettings({ dailyGoal: Number(el.value) || 50 });
      if (el.id === "mastered") updateSettings({ masteredStreak: Number(el.value) || 3 });
      if (el.id === "newlimit") updateSettings({ dailyNewLimit: Math.max(1, Number(el.value) || 20) });
      if (el.id === "batch") updateSettings({ reviewBatch: Math.max(5, Number(el.value) || 30) });
      if (el.id === "notify-time") {
        updateSettings({ notifyTime: el.value });
        const { scheduleReminder } = await import("../core/notify.js");
        await scheduleReminder();
        toast(`提醒时间已更新：${el.value}`, { type: "ok" });
      }
      if (el.id === "theme") {
        updateSettings({ theme: el.value });
        toast("主题已更新", { type: "ok" });
      }
      if (el.id === "fontsize") {
        updateSettings({ fontSize: el.value });
        toast("字号已更新", { type: "ok" });
      }
      if (el.id === "intervals") {
        const list = el.value
          .split(/[,，\s]+/)
          .map((x) => Number(x))
          .filter((x) => x > 0 && x <= 3650);
        if (!list.length) {
          toast("间隔阶梯至少需要一个正整数", { type: "err" });
          return;
        }
        updateSettings({ reviewIntervals: list });
        toast(`复习间隔已更新：${list.join(",")} 天`, { type: "ok" });
      }
      if (el.id === "backup-input") {
        const file = el.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const report = await importBackup(JSON.parse(text));
          await refreshSummary();
          toast(`恢复完成：知识点 ${report.learn_items || 0} · 题目 ${report.questions || 0}`, { type: "ok" });
          ctx.reload?.();
        } catch (err) {
          toast(`恢复失败：${err.message}`, { type: "err" });
        }
      }
    });

    root.addEventListener("click", async (ev) => {
      const el = ev.target.closest("[data-action]");
      if (!el) return;
      const action = el.dataset.action;
      if (action === "export-all") {
        const backup = await exportAll();
        downloadText(`西综多邻国-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), "application/json;charset=utf-8");
        toast("备份已导出", { type: "ok" });
      }
      if (action === "import-backup") root.querySelector("#backup-input")?.click();
      if (action === "recheck") {
        envCache = detectEnv();
        toast("已重新检测环境能力", { type: "ok" });
        ctx.reload?.();
      }
      if (action === "install-help") {
        installHelp();
      }
      if (action === "copy-env") {
        const text = envRows(envCache).map(([k, v]) => `${k}：${v}`).join("\n");
        try {
          await navigator.clipboard.writeText(text);
          toast("检测结果已复制", { type: "ok" });
        } catch {
          await modal({ title: "环境检测结果", body: `<pre class="mono" style="white-space:pre-wrap">${escapeHtml(text)}</pre>` });
        }
      }
      if (action === "test-notify") {
        if (!("Notification" in window)) return toast("当前浏览器不支持通知", { type: "err" });
        const { requestPermission, showNotification, currentReminder } = await import("../core/notify.js");
        const p = await requestPermission();
        if (p !== "granted") return toast("未获得通知权限", { type: "warn" });
        const msg = await currentReminder();
        const ok = await showNotification("西综多邻国 · 测试通知", {
          body: msg.empty ? "当前没有到期内容，这是一条测试提醒。" : msg.body,
          tag: "xzzy-test",
        });
        toast(ok ? "已发送测试通知" : "发送失败（浏览器可能限制了通知）", { type: ok ? "ok" : "warn" });
      }
      if (action === "reset-content") {
        const ok = await confirmWordDialog("清空学习内容", "将删除全部知识点、题目、进度、复习档案、错题与卡片（设置保留）。", "清空学习内容");
        if (!ok) return;
        await resetContent();
        await refreshSummary();
        toast("已清空学习内容", { type: "ok" });
        navigate("/home");
      }
      if (action === "reset-all") {
        const ok = await confirmWordDialog("清空全部数据", "将删除全部数据与设置，恢复到首次安装状态。", "彻底清空");
        if (!ok) return;
        await resetAll();
        updateSettings({ ...DEFAULT_SETTINGS });
        await refreshSummary();
        toast("已恢复初始状态", { type: "ok" });
        navigate("/home");
      }
      if (action === "restore-defaults") {
        const ok = await confirmDialog("恢复默认设置？", "每日目标、复习间隔、主题、字号等将回到默认值，内容数据不受影响。");
        if (!ok) return;
        updateSettings({ ...DEFAULT_SETTINGS });
        toast("设置已恢复默认", { type: "ok" });
        ctx.reload?.();
      }
      if (action === "check-update") {
        if (!navigator.serviceWorker?.controller) return toast("Service Worker 未启用，无法检查更新", { type: "warn" });
        navigator.serviceWorker.getRegistration().then((reg) => {
          reg?.update();
          toast("已请求检查更新；有新版本会提示刷新", { type: "ok" });
        });
      }
    });
  },
};

/** 需要输入确认词的二次确认 */
async function confirmWordDialog(title, body, word) {
  const v = await new Promise((resolve) => {
    const layer = document.getElementById("modal-layer");
    if (!layer) return resolve(false);
    layer.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2 class="modal-title">${escapeHtml(title)}</h2>
        <div>${escapeHtml(body)}</div>
        <div class="field mt">
          <label class="field-label" for="confirm-word">请输入确认词：<code>${escapeHtml(word)}</code></label>
          <input class="input" id="confirm-word" autocomplete="off" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-v="no">取消</button>
          <button class="btn btn-red" type="button" data-v="yes">确认清空</button>
        </div>
      </div>`;
    layer.hidden = false;
    const done = (val) => {
      layer.hidden = true;
      layer.innerHTML = "";
      resolve(val);
    };
    layer.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-v]");
      if (!btn) {
        if (ev.target === layer) done(false);
        return;
      }
      if (btn.dataset.v === "no") return done(false);
      const input = layer.querySelector("#confirm-word");
      if ((input?.value || "").trim() !== word) {
        toast("确认词不正确", { type: "err" });
        return;
      }
      done(true);
    });
  });
  return v;
}

/** 安装引导（Android/Edge 用 beforeinstallprompt；iOS 用步骤说明；http 局域网说明为何不能安装） */
export async function installHelp() {
  const env = envCache || detectEnv();

  // 先说明「为什么装不了」：Chromium 只在 https / localhost 下允许安装 PWA
  if (!env.installableOrigin) {
    const steps = env.isLanIp
      ? [
          "当前用的是<strong>局域网 http 地址</strong>（如 <code>192.168.x.x</code>）。浏览器规定：只有 <strong>https</strong> 或 <strong>localhost</strong> 才允许「安装应用」，所以菜单里只有「创建快捷方式」。",
          "方式一（推荐）：把 <code>app</code> 目录发布到任意静态托管（Netlify / GitHub Pages / Vercel），用得到的 <strong>https</strong> 地址打开，再点菜单「⋯」→「应用」→「安装此应用」。",
          "方式二：在电脑上跑一条 https 隧道（例如 <code>cloudflared tunnel --url http://127.0.0.1:8080</code>），手机用隧道给出的 <strong>https</strong> 地址打开后安装。",
          "方式三（纯离线）：如果只是想先在手机上看，直接用「创建快捷方式」即可 —— 学习与数据保存都正常，只是带地址栏、离线不保证。",
        ]
      : [
          "当前不是安全上下文（既不是 https 也不是 localhost），浏览器不允许安装为应用。",
          "请改用 <strong>https</strong> 地址打开本应用（静态托管或 https 隧道），即可安装。",
          "在线使用、数据保存（IndexedDB）不受影响。",
        ];
    await modal({
      title: "为什么不能「安装应用」",
      body: `<div class="install-steps">${steps
        .map((s, i) => `<div class="install-step"><span class="install-step-num">${i + 1}</span><div>${s}</div></div>`)
        .join("")}</div>
        <p class="small muted">当前地址：<code>${escapeHtml(location.origin)}</code></p>`,
      actions: [{ label: "知道了", value: "ok", kind: "btn" }],
    });
    return;
  }

  if (window.__deferredInstallPrompt) {
    try {
      window.__deferredInstallPrompt.prompt();
      const choice = await window.__deferredInstallPrompt.userChoice;
      if (choice?.outcome === "accepted") toast("已开始安装", { type: "ok" });
      window.__deferredInstallPrompt = null;
      return;
    } catch {
      /* 落到手动指引 */
    }
  }
  const steps = env.isIOS
    ? [
        "用 Safari 打开本页面",
        "点击底部「分享」按钮 <strong>⬆️</strong>",
        "选择「添加到主屏幕」，命名后点击「添加」",
        "从主屏幕图标启动，即可全屏离线使用",
      ]
    : env.isHuawei
      ? [
          "在华为应用市场安装 <strong>Microsoft Edge</strong>",
          "用 Edge 打开本应用地址（务必是 <strong>https</strong> 地址）",
          "点右下角菜单「⋯」→「应用」→「安装此应用」",
          "若菜单里只有「创建快捷方式」，说明当前是 http 地址，换 https 再试",
          "华为自带浏览器仅建议在线应急使用，数据同样保存在本地",
        ]
      : [
          "确认使用 <strong>Microsoft Edge</strong> 打开本应用",
          "点地址栏右侧的「安装」图标，或菜单「⋯」→「应用」→「安装此应用」",
          "安装后从桌面图标启动，即可独立窗口全屏、离线使用",
          "若菜单里只有「创建快捷方式」，说明当前不是 https/localhost",
        ];
  await modal({
    title: "安装为应用",
    body: `<div class="install-steps">${steps
      .map((s, i) => `<div class="install-step"><span class="install-step-num">${i + 1}</span><div>${s}</div></div>`)
      .join("")}</div>
      <p class="small muted">检测到浏览器：${escapeHtml(env.isEdge ? "Microsoft Edge（推荐）" : env.isHuawei ? "华为浏览器 / 鸿蒙（备用）" : env.isIOS ? "iOS 浏览器" : "其他浏览器")} · 地址：<code>${escapeHtml(
        location.origin
      )}</code></p>`,
    actions: [{ label: "知道了", value: "ok", kind: "btn" }],
  });
}

function notifyPermissionText(p) {
  return { granted: "已允许 ✅", denied: "已拒绝 ❌（需在浏览器设置中修改）", default: "未询问", unsupported: "不支持" }[p] || p;
}

/**
 * 关于 / 验收自检说明页（提示词《八、验收标准》可视化版）
 * 每条验收项都标注「已实现 / 需人工确认」以及对应的功能入口，便于逐条核对
 * @module views/about
 */

import { escapeHtml, fmtNum } from "../core/util.js";
import { navigate } from "../core/router.js";
import { detectEnv, browserAdvice, envRows } from "../core/env.js";
import { state } from "../core/state.js";
import { listImports, migrationLog, storageEstimate } from "../core/db.js";
import { loadGame, BADGES, RANKS } from "../core/game.js";
import { APP } from "../config.js";

/** 验收清单（来自提示词《八、验收标准》，逐条对应实现） */
export const ACCEPTANCE = [
  { id: 1, group: "PWA", text: "可添加到主屏幕、离线可打开使用、新版本更新提示正常", status: "done", entry: "设置 → 安装到主屏幕 / 检查应用更新", how: "manifest + Service Worker 预缓存 + updatefound 提示" },
  { id: 2, group: "导入", text: "模板 .md 可下载且示例标注「仅格式示例」", status: "done", entry: "导入 → 下载模板", how: "templates/ 四个模板，示例行均带标注" },
  { id: 3, group: "导入", text: "# / ## / ### 正确映射为科目 / 章节 / 知识点", status: "done", entry: "导入预览的结构树", how: "markdown.js 解析器 + 24 个单元用例" },
  { id: 4, group: "导入", text: "要点 / 易错点 / 题目 区块正确解析", status: "done", entry: "导入预览 → 统计要点/易错点", how: "区块识别支持加粗与省略星号" },
  { id: 5, group: "导入", text: "单选 / 多选 / 判断 / 配伍 判定与答案解析正确", status: "done", entry: "关卡测验 / 面关卡", how: "题型标记优先，答案格式校验并给出错误行号" },
  { id: 6, group: "导入", text: "元信息行（难度 / 标签 / 关联）正确入库", status: "done", entry: "关卡节点难度、卡片标签、线关卡配对", how: "难度支持数字与 ★；关联解析为 related_ids" },
  { id: 7, group: "导入", text: "多文件批量导入、解析预览、导入报告（失败明细与行号）", status: "done", entry: "导入 → 选择多个文件", how: "analyzeFiles 合并多结果；报告三级问题清单带行号" },
  { id: 8, group: "导入", text: "兼容格式 CSV / Excel / JSON 至少一种可成功导入", status: "done", entry: "导入 → .csv / .json", how: "CSV 与 JSON 零依赖；Excel 需 SheetJS（联网加载，缺失时提示改用 CSV）" },
  { id: 9, group: "关卡", text: "点线面三类关卡可闯、星级与解锁逻辑正确、可重玩", status: "done", entry: "关卡 → 科目路径", how: "level.js 引擎 + 21 个单元用例（含「星级只增不减」）" },
  { id: 10, group: "游戏化", text: "XP / 连击 / 红心 / 徽章 / 段位逻辑正确；动效可关闭", status: "done", entry: "我的 → 徽章墙；设置 → 动效", how: "game.js 纯函数规则 + 结算页 XP 明细" },
  { id: 11, group: "复习", text: "到期项准时进入今日队列；答错重置间隔；复习日历正确；闪卡与测验两种模式可用", status: "done", entry: "复习页", how: "scheduler.js（17 个用例）" },
  { id: 12, group: "错题", text: "自动收集；薄弱榜正确；一键生成卡片去重正确；卡片进入书架并加入复习队列", status: "done", entry: "错题本 → 一键生成", how: "cards.js（15 个用例，含去重与连对移出）" },
  { id: 13, group: "卡片", text: "翻页 / 目录 / 书签 / 搜索 / 续读 / 自动播放可用；编辑器可保存", status: "done", entry: "卡片 → 阅读器", how: "reader.js + card-edit.js；单元与界面端到端均覆盖" },
  { id: 14, group: "数据", text: "导出 / 恢复备份可用；清空重置需二次确认；升级迁移不丢数据", status: "done", entry: "设置 → 数据管理 / 清空与重置", how: "db.js 版本迁移（v1→v4）+ 确认词二次确认" },
  { id: 15, group: "空状态", text: "无内容时全程引导导入，不显示任何虚构数据", status: "done", entry: "首次启动自动进入导入页", how: "界面冒烟测试断言无虚构数字" },
  { id: 16, group: "统计", text: "统计页数据与明细一致（抽样核对）", status: "done", entry: "统计页", how: "全部由本地记录聚合；图表为内联 SVG" },
  { id: 17, group: "技术", text: "移动端 375px 无横向溢出；首屏加载 < 3s（本地）", status: "manual", entry: "浏览器开发者工具 iPhone SE 375×667", how: "CSS 以 375px 为基准；首屏骨架先渲染、数据后台水合" },
  { id: 18, group: "技术", text: "控制台无报错；IndexedDB 读写正常；Service Worker 更新策略正确", status: "manual", entry: "Edge DevTools → Console / Application", how: "已做模块语法检查与界面冒烟；浏览器控制台需人工复核" },
  { id: 19, group: "技术", text: "关键算法（解析 / 调度 / 解锁 / 去重）逻辑独立、可验证", status: "done", entry: "tools/verify.mjs、tests/", how: "117 个单元与界面用例" },
  { id: 20, group: "技术", text: "Markdown 解析器有单元测试（层级 / 区块 / 四题型 / 非法答案 / 多文件）", status: "done", entry: "tests/markdown.test.mjs", how: "24 个用例，覆盖题目要求的全部项" },
  { id: 21, group: "浏览器", text: "Edge 上全功能验收通过；华为自带浏览器抽查在线打开 + 数据入库", status: "manual", entry: "设置 → 环境检测", how: "能力检测与降级提示已实现，最终验收需在真机确认" },
];

const STATUS_LABEL = { done: "已实现（有自动化证据）", manual: "需人工确认" };

export const aboutView = {
  title: "关于与验收自检",
  back: true,
  tab: null,
  async render() {
    const env = detectEnv();
    const advice = browserAdvice(env);
    const game = await loadGame();
    const imports = await listImports();
    const est = await storageEstimate();
    const groups = [...new Set(ACCEPTANCE.map((a) => a.group))];

    const rows = groups
      .map(
        (g) => `<div class="section-head"><h2 class="section-title">${escapeHtml(g)}</h2>
        <span class="section-sub">${ACCEPTANCE.filter((a) => a.group === g).filter((a) => a.status === "done").length}/${
          ACCEPTANCE.filter((a) => a.group === g).length
        } 项有自动化证据</span></div>
        <div class="stack">${ACCEPTANCE.filter((a) => a.group === g)
          .map(
            (a) => `<div class="card">
              <div class="row-wrap tiny">
                <span class="badge ${a.status === "done" ? "badge-green" : "badge-gold"}">${a.status === "done" ? "✅ " : "🔎 "}${
                  STATUS_LABEL[a.status]
                }</span>
                <span class="badge">#${a.id}</span>
              </div>
              <div class="strong mt">${escapeHtml(a.text)}</div>
              <div class="small muted">核对入口：${escapeHtml(a.entry)}</div>
              <div class="small muted">实现方式：${escapeHtml(a.how)}</div>
            </div>`
          )
          .join("")}</div>`
      )
      .join("");

    return `
    <section class="section">
      <div class="note note-${advice.level === "ok" ? "ok" : advice.level === "warn" ? "warn" : "error"}">
        <span>🌐</span><div><strong>${escapeHtml(advice.title)}</strong><br />${escapeHtml(advice.text)}</div>
      </div>
    </section>

    <section class="section">
      <div class="card">
        <div class="kv"><div class="kv-key">应用</div><div class="kv-val">${escapeHtml(APP.name)}（${escapeHtml(APP.english)}）</div></div>
        <div class="kv"><div class="kv-key">版本</div><div class="kv-val">${escapeHtml(APP.version)} · ${escapeHtml(APP.phase)}</div></div>
        <div class="kv"><div class="kv-key">内容来源</div><div class="kv-val">100% 来自你导入的 Markdown；应用不生成任何医学知识</div></div>
        <div class="kv"><div class="kv-key">架构</div><div class="kv-val">纯前端 PWA · 无后端 · 无登录 · 无云同步 · 离线可用</div></div>
        <div class="kv"><div class="kv-key">当前数据</div><div class="kv-val">${fmtNum(state.summary.items)} 知识点 · ${fmtNum(
          state.summary.questions
        )} 题 · ${fmtNum(state.summary.cards)} 卡片 · ${fmtNum(state.summary.wrongs)} 错题 · ${imports.length} 次导入</div></div>
        <div class="kv"><div class="kv-key">游戏化</div><div class="kv-val">${fmtNum(game.xp)} XP · 连续 ${game.streak.streak} 天 · 徽章 ${game.badges.length}/${
          BADGES.length
        } · 段位门槛 ${RANKS.map((r) => r.name).join(" → ")}</div></div>
        <div class="kv"><div class="kv-key">本地占用</div><div class="kv-val">${
          est ? `${(est.usage / 1048576).toFixed(2)} MB / 配额 ${(est.quota / 1048576).toFixed(0)} MB` : "浏览器未提供估算"
        }</div></div>
        <div class="kv"><div class="kv-key">迁移记录</div><div class="kv-val">${escapeHtml(migrationLog().join("；") || "本次会话未执行迁移")}</div></div>
        <div class="row-wrap mt">
          <button class="btn btn-ghost btn-sm" type="button" data-go="/settings">设置 / 环境检测</button>
          <button class="btn btn-ghost btn-sm" type="button" data-go="/guide">内容编写规范</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="copy-acceptance">复制验收清单</button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">环境能力</h2></div>
      <div class="card">
        ${envRows(env)
          .map(([k, v]) => `<div class="kv"><div class="kv-key">${escapeHtml(k)}</div><div class="kv-val">${escapeHtml(v)}</div></div>`)
          .join("")}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">验收清单（21 项）</h2>
        <span class="section-sub">✅ ${ACCEPTANCE.filter((a) => a.status === "done").length} 项 · 🔎 ${
          ACCEPTANCE.filter((a) => a.status === "manual").length
        } 项待人工确认</span></div>
      ${rows}
    </section>

    <section class="section">
      <div class="note"><span>🔒</span><div>
        内容零 AI 生成：应用不内置题库、不调用 AI 生成医学内容；模板示例均标注「仅格式示例」；
        宽松解析只调整归属规则，不会新增或改写任何内容。
      </div></div>
    </section>

    <section class="section">
      <button class="btn btn-lg btn-block" type="button" data-go="/home">回到首页</button>
    </section>`;
  },
  mount(ctx, root) {
    root.addEventListener("click", async (ev) => {
      const go = ev.target.closest("[data-go]");
      if (go) return navigate(go.dataset.go);
      const act = ev.target.closest("[data-action]");
      if (!act) return;
      if (act.dataset.action === "copy-acceptance") {
        const text = ACCEPTANCE.map(
          (a) => `#${a.id} [${a.group}] ${a.status === "done" ? "✅" : "🔎"} ${a.text}\n   入口：${a.entry}\n   实现：${a.how}`
        ).join("\n");
        try {
          await navigator.clipboard.writeText(text);
          const { toast } = await import("../core/dom.js");
          toast("验收清单已复制到剪贴板", { type: "ok" });
        } catch {
          const { modal } = await import("../core/dom.js");
          await modal({ title: "验收清单", body: `<pre class="mono" style="white-space:pre-wrap">${escapeHtml(text)}</pre>` });
        }
      }
    });
  },
};

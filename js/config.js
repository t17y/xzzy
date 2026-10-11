/**
 * 应用常量与元信息
 * @module config
 */

export const APP = {
  name: "知彩",
  shortName: "知彩",
  english: "Western Comprehensive Duolingo",
  version: "1.0.0",
  phase: "Phase 5 完成 · 全量功能（骨架 / 导入 / 学习 / 复习 / 沉淀 / 统计与打磨）",
  subjectsDefault: ["生理学", "生物化学", "病理学", "内科学", "外科学", "诊断学"],
};

/** 底部 Tab（提示词六：固定五个） */
export const TABS = [
  { key: "home", label: "首页", icon: "🏠", href: "#/home" },
  { key: "learn", label: "关卡", icon: "🗺️", href: "#/learn" },
  { key: "review", label: "复习", icon: "🔁", href: "#/review" },
  { key: "cards", label: "卡片", icon: "📖", href: "#/cards" },
  { key: "profile", label: "我的", icon: "🙋", href: "#/profile" },
];

/** 每种关卡类型的展示信息（Phase 2 使用） */
export const NODE_TYPES = {
  point: { key: "point", label: "点", name: "点关卡", icon: "🔵", color: "var(--blue)" },
  line: { key: "line", label: "线", name: "线关卡", icon: "➰", color: "var(--purple)" },
  face: { key: "face", label: "面", name: "面关卡", icon: "🧩", color: "var(--orange)" },
};

/** 星级文本 */
export function starsText(n) {
  const v = Math.max(0, Math.min(3, Number(n) || 0));
  return "★".repeat(v) + "☆".repeat(3 - v);
}

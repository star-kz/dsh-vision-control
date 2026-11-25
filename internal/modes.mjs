import { RT_TOOL_NAMES } from '../realtime/contracts.mjs';

export const MODES = Object.freeze(['disabled', 'watch', 'control']);

export const MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'disabled', icon: 'forbidden', label: '禁用功能' }),
  Object.freeze({ id: 'watch', icon: 'eye', label: '仅观看' }),
  Object.freeze({ id: 'control', icon: 'monitor', label: '观看+操作' }),
]);

const LEGACY_TOOL_NAMES = Object.freeze([
  'computer_screenshot', 'computer_actions', 'computer_click', 'computer_drag',
  'computer_scroll', 'computer_type', 'computer_key', 'computer_windows', 'computer_ui',
  'computer_ui_action', 'computer_clipboard', 'computer_paste', 'computer_launch',
  'computer_stop', 'computer_watch', 'browser_state', 'browser_actions',
]);

export const WATCH_TOOL_NAMES = Object.freeze([
  'browser_state', 'computer_screenshot', 'computer_windows', 'computer_digest', 'computer_ui',
  'computer_clipboard', 'computer_watch', 'computer_stop', 'app_env_audit', ...RT_TOOL_NAMES,
]);

export const CONTROL_ONLY_TOOL_NAMES = Object.freeze([
  'computer_actions', 'browser_actions', 'computer_click', 'computer_drag', 'computer_scroll',
  'computer_type', 'computer_key', 'computer_ui_action', 'computer_paste', 'computer_launch',
  'app_launch',
]);

export const ALL_MANAGED_TOOL_NAMES = Object.freeze([
  ...LEGACY_TOOL_NAMES, 'computer_digest', 'app_launch', 'app_env_audit', ...RT_TOOL_NAMES,
]);

export function normalizeMode(value, fallback = 'disabled') {
  if (MODES.includes(value)) return value;
  return MODES.includes(fallback) ? fallback : 'disabled';
}

export function deniedToolsForMode(mode) {
  switch (normalizeMode(mode)) {
    case 'control': return [];
    case 'watch': return [...CONTROL_ONLY_TOOL_NAMES];
    default: return [...ALL_MANAGED_TOOL_NAMES];
  }
}

export function buildModePrompt(mode) {
  switch (normalizeMode(mode)) {
    case 'watch':
      return '当前为仅观看模式。工作流：先截图或读取窗口/UIA，必要时使用 digest/watch 跟踪变化，再向用户报告观察结果； realtime 仅可运行 shadow/replay。只能使用只读观察、状态查询和停止/清理能力，不得点击、拖动、滚动、输入、粘贴、聚焦窗口、启动应用、修改剪贴板或注入真实输入；需要写操作时请用户切换模式。';
    case 'control':
      return '当前为观看+操作模式。遵循“看→定位→小步操作→重新观察确认”：先截图并优先用 UIA/DOM 定位，核对目标与坐标后执行最小动作，再读取新状态验证结果，不把动作回执当作业务成功。高风险或不可逆操作先征求用户确认；realtime 默认 shadow，active 仍须满足独立授权与专用 HIL 目标校验。';
    default:
      return '';
  }
}

import { movesDesktop } from './lease.mjs';

/**
 * Execution-time companion to schema visibility. Visibility is a token-saving UX
 * layer; this module is the authoritative gate for direct or stale tool calls.
 */
export function createModeAccess({
  getMode,
  isSubagent = () => false,
  supported = true,
  unsupportedReason = '电脑操作目前只支持 Windows。',
  onDenied = () => {},
}) {
  function requireObservation(exec) {
    if (!supported) throw new Error(`[UNSUPPORTED_PLATFORM] ${unsupportedReason}`);
    if (isSubagent(exec)) {
      throw new Error('[SUBAGENT_COMPUTER_USE_UNAVAILABLE] 子代理不能读取或操控桌面，请由主会话执行。');
    }
    const mode = getMode(exec?.agent?.session?.id);
    if (mode !== 'watch' && mode !== 'control') {
      onDenied(exec);
      throw new Error('[NOT_AUTHORIZED] 电脑功能当前为禁用模式。请让用户在输入框的电脑图标菜单中选择「仅观看」或「观看+操作」，然后重试。');
    }
    return mode;
  }

  function requireControl(exec) {
    const mode = requireObservation(exec);
    if (mode !== 'control') {
      onDenied(exec);
      throw new Error('[CONTROL_REQUIRED] 当前为「仅观看」模式，读取和回放可用，但不能修改剪贴板、聚焦窗口、启动应用、发送键鼠或运行 active 实时控制。请让用户切换到「观看+操作」后重试。');
    }
  }

  function requireCommand(exec, command, args) {
    if (movesDesktop(command, args)) requireControl(exec);
    else requireObservation(exec);
  }

  function requireRealtime(exec, name, args) {
    if (name === 'realtime_run' && String(args?.mode ?? 'shadow').toLowerCase() === 'active') {
      requireControl(exec);
    } else {
      requireObservation(exec);
    }
  }

  return { requireObservation, requireControl, requireCommand, requireRealtime };
}

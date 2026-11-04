/**
 * `computer_key` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
export function registerComputerKey(env) {
  const { safeRegister, defineTracedTool, call, actionTimeoutMs } = env;
  safeRegister(defineTracedTool({
    name: 'computer_key',
    description:
      "Press a key or key chord on the keyboard focus, e.g. 'enter', 'esc', 'tab', 'ctrl+c', 'ctrl+shift+t', 'alt+f4', 'win'. Requires 电脑操作.",
    parameters: {
      keys: { type: 'string', required: true, description: "Chord with '+' between keys, e.g. 'ctrl+s'. Modifiers come first." },
      into_hwnd: { type: 'integer', description: 'Only send if this window (an hwnd from computer_windows) is the one that would receive it; a mismatch is refused before anything is sent. Same guard as computer_type.' },
      repeat: { type: 'integer', description: 'How many times to press the chord, 1 to 100 (default 1). Ignored when hold_seconds is set.' },
      hold_seconds: {
        type: 'number',
        description: 'Press the chord down, hold it (maximum 10 s), then release — for applications that must see one continuous press.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keys: { type: 'string', required: true },
          repeat: { type: 'integer', required: true },
          heldMs: { type: 'integer', required: true },
          foreground: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.heldMs > 0
          ? `Held ${value.keys} for ${(value.heldMs / 1000).toFixed(1)}s in ${value.foreground}.`
          : `Pressed ${value.keys}${value.repeat > 1 ? ` x${value.repeat}` : ''} into ${value.foreground}.`,
      }],
    },
    async execute(args, exec) {
      const holdMs = args.hold_seconds === undefined ? 0 : Math.min(10, Math.max(0, args.hold_seconds)) * 1000;
      const result = await call(exec, 'key', {
        intoHwnd: args.into_hwnd,
        keys: args.keys,
        repeat: args.repeat ?? 1,
        holdMs,
      }, { interactive: true, timeoutMs: Math.max(actionTimeoutMs, holdMs + 10_000) });
      const fg = result.foreground ?? {};
      return {
        keys: result.keys,
        repeat: result.repeat,
        heldMs: result.heldMs ?? 0,
        foreground: `${fg.title ? `"${fg.title}"` : '(untitled window)'}${fg.process ? ` [${fg.process}]` : ''}`,
      };
    },
  }));
}

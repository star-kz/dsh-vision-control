/**
 * `computer_windows` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
export function registerComputerWindows(env) {
  const { safeRegister, defineTracedTool, call } = env;
  safeRegister(defineTracedTool({
    name: 'computer_windows',
    description:
      'List the visible top-level windows with their titles, owning process, and screen rectangles, or bring one to the foreground. Prefer this over guessing from a screenshot when you need to switch applications. Requires 电脑操作.',
    parameters: {
      filter: { type: 'string', description: 'Case-insensitive substring matched against the window title or process name.' },
      focus_hwnd: { type: 'integer', description: 'Window handle from a previous listing to activate and bring to the foreground.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hwnd: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                process: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                foreground: { type: 'boolean', required: true },
              },
            },
          },
          focused: { type: 'string' },
          focusSucceeded: { type: 'boolean' },
          focusedWindowVisible: { type: 'boolean' },
          focusNote: { type: 'string' },
          foreground: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.windows.length === 0) {
          const lines = [];
          if (value.focused !== undefined) {
            lines.push(value.focusSucceeded === true
              ? `Focused ${value.focused}`
              : `Could NOT bring ${value.focused} to the foreground${value.foreground === undefined ? '' : `: ${value.foreground} owns it`}. Keys and clicks sent now would go to that window instead, so bring the target up first — click inside it, or check for a message box or a modal in another window.`);
          } else {
            lines.push('No matching visible windows.');
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = value.windows.map(
          (w) => `${w.foreground ? '*' : ' '} hwnd=${w.hwnd} [${w.process}] "${w.title}" ${w.width}x${w.height} at (${w.x},${w.y})`,
        );
        const head = `${value.windows.length} visible window(s) (* = foreground):`;
        const tail = value.focused === undefined ? '' : `\n${value.focusSucceeded === true ? `Focused ${value.focused}` : `Could NOT foreground ${value.focused}${value.foreground === undefined ? '' : `: ${value.foreground} owns it`}`}`;
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}${tail}` }];
      },
    },
    async execute(args, exec) {
      if (args.focus_hwnd !== undefined) {
        const result = await call(exec, 'focus', { hwnd: args.focus_hwnd });
        const value = {
          windows: [],
          focused: `${result.title || 'window'} (hwnd=${result.hwnd}, focused=${result.focused})`,
          focusSucceeded: result.focused === true,
        };
        // Whether the window is still on screen after the raise. Focusing must not change
        // that, and a caller about to click coordinates needs to know if it did.
        if (typeof result.visible === 'boolean') value.focusedWindowVisible = result.visible;
        if (typeof result.note === 'string' && result.note !== '') value.focusNote = result.note;
        // Only meaningful when the raise failed: who holds the foreground explains
        // why, and what the caller would be typing into if it went ahead anyway.
        const owner = result.foreground ?? {};
        if (result.focused !== true && Number(owner.hwnd ?? 0) !== 0) {
          value.foreground = `${owner.title ? `"${owner.title}"` : '(untitled)'} [${owner.process || 'unknown'}]`;
        }
        return value;
      }
      const result = await call(exec, 'windows', { filter: args.filter });
      return {
        windows: (result.windows ?? []).map((w) => ({
          hwnd: w.hwnd,
          title: w.title,
          process: w.process,
          pid: w.pid,
          x: w.x,
          y: w.y,
          width: w.width,
          height: w.height,
          foreground: w.foreground,
        })),
      };
    },
  }));
}

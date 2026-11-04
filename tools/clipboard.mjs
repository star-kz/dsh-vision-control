/**
 * `computer_clipboard` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
export function registerComputerClipboard(env) {
  const { safeRegister, defineTracedTool, requireGrant, call } = env;
  safeRegister(defineTracedTool({
    name: 'computer_clipboard',
    description:
      'Read the system clipboard, write text to it, or clear it. This is the reliable way to get text *out* of an application: select it, copy it with computer_key, then read it here — far better than trying to read rendered pixels. Requires 电脑操作.',
    parameters: {
      op: { type: 'string', required: true, enum: ['get', 'set', 'clear'], description: "The operation: 'get' returns the current text, 'set' replaces it with `text`, 'clear' empties it." },
      text: { type: 'string', description: "For 'set': the text to put on the clipboard." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', required: true },
          text: { type: 'string' },
          length: { type: 'integer', required: true },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.op === 'set') return [{ type: 'text', text: `The clipboard now holds ${value.length} character(s).` }];
        if (value.op === 'clear') return [{ type: 'text', text: 'The clipboard was cleared.' }];
        if (value.length === 0) return [{ type: 'text', text: 'The clipboard holds no text.' }];
        const note = value.truncated === true ? ` (truncated — the clipboard holds more than ${value.length} characters)` : '';
        return [{ type: 'text', text: `clipboard${note}:\n${value.text ?? ''}` }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      const op = String(args.op ?? '').toLowerCase();
      if (!['get', 'set', 'clear'].includes(op)) throw new Error(`[BAD_REQUEST] computer_clipboard needs op 'get', 'set' or 'clear'; got '${args.op ?? ''}'`);
      if (op === 'set' && typeof args.text !== 'string') throw new Error("[BAD_REQUEST] computer_clipboard with op 'set' needs text.");
      const result = await call(exec, 'clipboard', { op, text: args.text });
      const value = { op: String(result.op ?? op), length: Number(result.length ?? 0) };
      if (op === 'get') {
        value.text = String(result.text ?? '');
        value.truncated = result.truncated === true;
      }
      return value;
    },
  }));
}

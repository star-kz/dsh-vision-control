/**
 * `computer_type` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
export function registerComputerType(env) {
  const { safeRegister, defineTracedTool, call } = env;
  safeRegister(defineTracedTool({
    name: 'computer_type',
    description:
      'Type text into whatever currently has keyboard focus, using Unicode input so any language works. Click the target field first. Requires 电脑操作.',
    parameters: {
      text: { type: 'string', required: true, description: 'The exact text to type. Newlines press Enter.' },
      into_hwnd: { type: 'integer', description: 'Only send if this window (an hwnd from computer_windows) would receive it. A dialog that appeared since the last click is how text ends up in the wrong place; with this set a mismatch is refused before anything is sent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          typed: { type: 'integer', required: true },
          foreground: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Typed ${value.typed} characters into ${value.foreground}.` }],
    },
    async execute(args, exec) {
      const result = await call(exec, 'type', { text: args.text, intoHwnd: args.into_hwnd }, { interactive: true });
      const fg = result.foreground ?? {};
      return { typed: result.typed, foreground: `${fg.title ? `"${fg.title}"` : '(untitled window)'}${fg.process ? ` [${fg.process}]` : ''}` };
    },
  }));
}

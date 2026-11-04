/**
 * `computer_scroll` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
export function registerComputerScroll(env) {
  const { safeRegister, defineTracedTool, refs, metrics, call, FRAME_RECEIPT_SCHEMA } = env;
  safeRegister(defineTracedTool({
    name: 'computer_scroll',
    description:
      'Scroll the mouse wheel, optionally after moving the pointer over the surface to scroll. Requires 电脑操作.',
    parameters: {
      direction: { type: 'string', required: true, description: "Scroll direction: 'up', 'down', 'left', or 'right'." },
      clicks: { type: 'integer', description: 'Number of wheel notches, 1 to 20 (default 3).' },
      x: { type: 'integer', description: 'Optional absolute x to move the pointer to first (or an image pixel when `from_frame` is set).' },
      y: { type: 'integer', description: 'Optional absolute y to move the pointer to first (or an image pixel when `from_frame` is set).' },
      from_frame: { type: 'string', description: 'A frame id from computer_screenshot — see computer_click.from_frame. The wheel goes to whatever is under the pointer, so this is how a scroll is aimed at a panel measured on a capture.' },
      allow_activate: { type: 'boolean', description: 'With `from_frame`: allow one attempt at bringing the target window forward when the guard finds another process under the point (default false).' },
      verify_content: { type: 'boolean', description: 'With `from_frame`: set false to skip the content check on an old frame (an animated surface always reads as changed). Default true.' },
      allow_windows: { type: 'array', items: { type: 'integer' }, description: "With `from_frame`: window handles this scroll may aim at besides the frame's own — see computer_click for the occlusion rule." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          direction: { type: 'string', required: true },
          clicks: { type: 'integer', required: true },
          horizontal: { type: 'boolean', required: true },
          frame: FRAME_RECEIPT_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Scrolled ${value.direction} by ${value.clicks} notches.` }],
    },
    async execute(args, exec) {
      refs.assertFrameOwnership(exec?.agent?.session?.id, args.from_frame);
      const direction = String(args.direction ?? 'down').toLowerCase();
      const horizontal = direction === 'left' || direction === 'right';
      const clicks = Math.min(20, Math.max(1, args.clicks ?? 3));
      const result = await call(exec, 'scroll', { direction, clicks, horizontal, x: args.x, y: args.y, fromFrame: args.from_frame, allowActivate: args.allow_activate === true ? true : undefined, verifyContent: args.verify_content === false ? false : undefined, allowWindows: Array.isArray(args.allow_windows) && args.allow_windows.length > 0 ? args.allow_windows.map((one) => Number(one)) : undefined }, { interactive: true });
      const value = { direction: result.direction, clicks: result.clicks, horizontal: result.horizontal };
      if (result.frame !== null && result.frame !== undefined) {
        value.frame = {
          id: String(result.frame.id ?? ''),
          fromImage: { x: Number(result.frame.fromImage?.x ?? 0), y: Number(result.frame.fromImage?.y ?? 0) },
          projected: { x: Number(result.frame.projected?.x ?? 0), y: Number(result.frame.projected?.y ?? 0) },
          scale: Number(result.frame.scale ?? 1),
          source: String(result.frame.source ?? ''),
        };
        if (Number.isFinite(result.frame.drift) && Number(result.frame.drift) > 0) value.frame.drift = Number(result.frame.drift);
        if (typeof result.frame.note === 'string' && result.frame.note !== '') value.frame.note = String(result.frame.note);
        if (typeof result.frame.mapping === 'string' && result.frame.mapping !== '') value.frame.mapping = String(result.frame.mapping);
        if (typeof result.frame.guard === 'string' && result.frame.guard !== '') {
          value.frame.guard = String(result.frame.guard);
          // 优-P1-09：fail-open 放行入帐（unavailable = 落点下读不到任何东西，未经验证就放行了）。
          if (result.frame.guard === 'unavailable') metrics.guardUnavailable += 1;
        }
        if (result.frame.recovered === true) value.frame.recovered = true;
      }
      return value;
    },
  }));
}

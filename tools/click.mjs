/**
 * `computer_click` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
export function registerComputerClick(env) {
  const { safeRegister, defineTracedTool, refs, metrics, call, FRAME_RECEIPT_SCHEMA } = env;
  safeRegister(defineTracedTool({
    name: 'computer_click',
    description:
      'Click at an absolute screen coordinate. By default this tries accessibility first: if a pressable control is under the point, it is invoked through UI Automation instead of clicked, which is more reliable, does not move the mouse, and works even on a window the desktop will not raise. Pass `prefer_a11y: false` to force a real synthesized click. Coordinates are virtual-desktop pixels, the same ones the computer_screenshot envelope and cursor report use. Requires 电脑操作.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Absolute screen x in virtual-desktop pixels.' },
      y: { type: 'integer', required: true, description: 'Absolute screen y in virtual-desktop pixels.' },
      button: { type: 'string', description: "Mouse button: 'left' (default), 'right', or 'middle'." },
      clicks: { type: 'integer', description: 'Click count: 1 (default), 2 for a double click, 3 for a triple click.' },
      modifiers: { type: 'string', description: "A '+' separated chord held down for the duration of the click, e.g. 'ctrl' to add to a selection or 'shift' to extend one. Released afterwards even if the click fails.", },
      prefer_a11y: { type: 'boolean', description: 'Try the accessibility press first when a pressable control is under the point (default true). A chorded or multi-click is always a real click — there is no accessibility equivalent.' },
      allow_activate: { type: 'boolean', description: "With `from_frame`: when the landing guard finds another process under the point (the target is covered), bring the target window forward once and check again before refusing (default false). One attempt only; `frame.recovered` in the reply says whether it was needed." },
      verify_content: { type: 'boolean', description: 'With `from_frame`: set false to skip the content check against what the surface looks like now — an animated surface always reads as changed. Default true.' },
      allow_windows: { type: 'array', items: { type: 'integer' }, description: "With `from_frame`: additional window handles this click may land on — a dialog or second window of the same application that is the transition you expect. Anything else under the point, including another window of the same process, is refused as `[TARGET_OCCLUDED]`; `frame.guard` names the rule that allowed it." },
      from_frame: { type: 'string', description: 'A frame id from computer_screenshot: x and y are pixels *in that image*, projected for you. The frame is checked first — gone, re-owned or moved so far that the point falls outside it is refused rather than clicked.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          clicks: { type: 'integer', required: true },
          button: { type: 'string', required: true },
          via: { type: 'string', required: true },
          modifiers: { type: 'string' },
          frame: FRAME_RECEIPT_SCHEMA,
          element: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              controlType: { type: 'string', required: true },
              automationId: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const chord = value.modifiers === undefined ? '' : `${value.modifiers}+`;
        if (value.via === 'a11y') {
          const element = value.element ?? { name: '', controlType: 'ControlType.Unknown', automationId: '' };
          const type = element.controlType.replace('ControlType.', '');
          const label = element.name ? `"${element.name}"` : `(unnamed ${type})`;
          return [{ type: 'text', text: `Pressed the ${type} ${label} at (${value.x}, ${value.y}) through UI Automation — the pointer was not moved.` }];
        }
        return [{ type: 'text', text: `${value.button} ${chord}click x${value.clicks} at (${value.x}, ${value.y}).` }];
      },
    },
    async execute(args, exec) {
      // A frame id that is present but empty is not "no frame given": the caller meant to
      // cite one and the value did not survive. Falling back to absolute coordinates
      // instead is a substitution nobody notices until the wrong thing has been clicked.
      if (typeof args.from_frame === 'string' && args.from_frame.trim() === '') {
        throw new Error('[BAD_REQUEST] from_frame was given but is empty; pass the frame id from computer_screenshot, or omit it entirely to use absolute coordinates.');
      }
      refs.assertFrameOwnership(exec?.agent?.session?.id, args.from_frame);
      const result = await call(exec, 'click', {
        x: args.x,
        y: args.y,
        fromFrame: args.from_frame,
        button: args.button ?? 'left',
        clicks: args.clicks ?? 1,
        modifiers: args.modifiers,
        preferA11y: args.prefer_a11y,
        allowActivate: args.allow_activate === true ? true : undefined,
        verifyContent: args.verify_content === false ? false : undefined,
        allowWindows: Array.isArray(args.allow_windows) && args.allow_windows.length > 0 ? args.allow_windows.map((one) => Number(one)) : undefined,
      }, { interactive: true });
      // Map explicitly: the backend also reports an event count, and the declared
      // output schema rejects any property it does not name.
      const value = {
        x: Number(result.x),
        y: Number(result.y),
        clicks: Number(result.clicks),
        button: String(result.button ?? 'left'),
        via: String(result.via ?? 'mouse'),
      };
      if (typeof result.modifiers === 'string' && result.modifiers !== '') value.modifiers = result.modifiers;
      // Which frame the coordinates came from, and where they landed: the caller handed
      // over image pixels, so it should get back the screen pixels it actually clicked.
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
      if (value.via === 'a11y' && result.element !== null && result.element !== undefined) {
        value.element = {
          name: String(result.element.name ?? ''),
          controlType: String(result.element.controlType ?? 'ControlType.Unknown'),
          automationId: String(result.element.automationId ?? ''),
        };
      }
      return value;
    },
  }));
}

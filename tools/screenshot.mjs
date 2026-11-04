/**
 * `computer_screenshot` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 2）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
import { normalizeCaptureSpec, resolveFormat, screenshotEnvelope } from '../internal/capture.mjs';
import { SCREENSHOT_VALUE_SCHEMA, captureTiming, shotValue } from '../internal/tool-contracts.mjs';
export function registerComputerScreenshot(env) {
  const { safeRegister, defineTracedTool, captureService, refs, requireGrant, call, capture, reportAttachment, actionTimeoutMs, ctx } = env;
  safeRegister(defineTracedTool({
    name: 'computer_screenshot',
    description:
      'Capture the screen so you can see the desktop before deciding what to click. Returns the image plus capture geometry, cursor position and the active window. Use it first, and again after any action whose effect you cannot predict. Requires 电脑操作.',
    parameters: {
      window: {
        type: 'integer',
        description: 'Capture one window instead of the screen: it renders itself, so whatever covers it is irrelevant, and no foreground is needed. The result says how the pixels were obtained in `source` ("window", or "screen" after a fallback).',
      },
      require: { type: 'string', enum: ['window'], description: "Only with `window`: refuse rather than fall back to the screen if that window cannot render its own pixels — a fallback silently downgrades the very guarantee a window capture gives." },
      display: {
        type: 'integer',
        description: 'Which display to capture, by index as reported in the envelope (0 is the primary display). Omit to capture the primary display.',
      },
      all_displays: {
        type: 'boolean',
        description: 'Capture the whole virtual desktop, spanning every monitor, instead of a single display.',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        description: 'Capture only this rectangle instead of a whole display — the cheap way to re-read one panel at full resolution. Absolute virtual-desktop pixels (the same meaning click coordinates have), trimmed at the desktop edge; with `window` it is cut out of that window, so it stays readable while covered.',
        properties: {
          x: { type: 'integer', required: true, description: 'Left edge.' },
          y: { type: 'integer', required: true, description: 'Top edge.' },
          width: { type: 'integer', required: true, description: 'Width in pixels.' },
          height: { type: 'integer', required: true, description: 'Height in pixels.' },
        },
      },
      region_space: {
        type: 'string',
        enum: ['screen', 'window'],
        description: "Which space `region` is in: 'screen' (the default) is absolute virtual-desktop pixels, the same meaning the click coordinates have; 'window' is pixels of the window named by `window`, which then has to be given. The two are never told apart by the size of the numbers.",
      },
      surface: {
        type: 'string',
        enum: ['window', 'client'],
        description: "With `window`: which part of it to deliver. 'window' (the default) is the whole window; 'client' is the client area only — the title bar, borders and resize grips are cropped away. Use it when the coordinates you measure belong to the application's own space rather than to the frame the shell draws around it. `windowRect` still describes the whole window and `crop` says which part you were given.",
      },
      clip: {
        type: 'boolean',
        description: "With `window` and a region: take the part of the rectangle that exists inside the window instead of refusing when it runs past its edge (default false). The reply says what was actually captured.",
      },
      save_path: {
        type: 'string',
        description: 'Optional absolute path to also write the image to, e.g. inside the workspace when the user asked for a saved screenshot. The extension picks the format unless `format` is given.',
      },
      scale: {
        type: 'number',
        description: 'Downscale the capture before encoding: 1 (default) keeps screen pixels, 0.5 halves both edges and roughly quarters the bytes and the vision tokens. The envelope reports the mapping, so an image coordinate converts back to a click target.',
      },
      format: {
        type: 'string',
        enum: ['jpeg', 'png'],
        description: "Image format. 'jpeg' (default) is a quarter of the bytes at a quality that keeps screen text readable; 'png' is lossless when you need to read very fine detail or exact colors.",
      },
      captures: {
        type: 'string',
        enum: ['self', 'related'],
        description: "What to capture: 'self' (the default) is that window; 'related' also captures the windows that belong to it — a dialog, a popup menu, a tool window — one frame each, because a popup is its own window and a frame of what is behind it cannot show that it is there. Needs `window`; popups come first, two frames by default and three at most, and every frame gets its own frame id you can click through with from_frame.",
      },
      max_captures: { type: 'integer', description: "With captures: 'related', how many frames to take (default 2, maximum 3). Popups are captured before the window itself, so a budget of 1 gives you the thing in front." },
      delay_seconds: {
        type: 'number',
        description: 'Wait this many seconds before capturing, to let an application finish opening or rendering after your previous action (maximum 30).',
      },
      settle_ms: {
        type: 'integer',
        description: 'With a write just before this capture, the floor on how old that write must be (default 300, maximum 5000). Not an extra sleep: time already spent by the action, the transport or your own turn counts towards it. Set 0 to take the frame immediately.',
      },
      stability_ms: {
        type: 'number',
        description: 'After a write, how long to keep re-checking that the picture stopped changing before encoding (default 0 — off; maximum 30000). Worth it only when you know what you are waiting for. Reported as `stability.state`: `stable`, `timeout` (budget gone, the frame may be mid-update), `disabled`, `none`.',
      },
      stable: {
        type: 'boolean',
        description: 'A plain switch for the same wait: false skips the stability check whatever `stability_ms` says, true asks for the backend\'s default budget instead of `stability_ms`. An explicit `stability_ms` wins over it, and the reply names which argument decided (`stability.resolvedBy`).',
      },
    },
    output: {
      schema: SCREENSHOT_VALUE_SCHEMA,
      render: (_args, value) => {
        if (Array.isArray(value.frames)) {
          const blocks = [{ type: 'text', text: `${value.frames.length} related frame(s) of hwnd ${value.frames[0].windowHwnd}. Each one is its own frame id: pass it as from_frame to click inside that window.` }];
          for (const frame of value.frames) {
            const rank = frame.zRankKnown === true ? `z=${frame.zRank}` : 'z=unknown';
            blocks.push({
              type: 'text',
              text: `[${frame.frame}] ${frame.relation ?? 'self'} ${rank} hwnd=${frame.windowHwnd}${frame.windowTitle === undefined ? '' : ` "${frame.windowTitle}"`} at (${frame.x},${frame.y}) ${frame.width}x${frame.height}${frame.imageWidth === undefined ? '' : ` -> ${frame.imageWidth}x${frame.imageHeight}`}`,
            });
            if (frame.image === undefined) blocks.push({ type: 'text', text: `  (no image for this frame: ${frame.note ?? `it is at ${frame.path}`})` });
            else blocks.push({ type: 'image', attachment: frame.image });
          }
          if (Array.isArray(value.omitted) && value.omitted.length > 0) {
            blocks.push({ type: 'text', text: `not captured: ${value.omitted.map((one) => `hwnd ${one.hwnd} (${one.relation ?? 'unknown'}) — ${one.reason}`).join('; ')}` });
          }
          return blocks;
        }
        const envelope = { type: 'text', text: screenshotEnvelope(value) };
        // The image itself rides the adjacent block, exactly as read_image does;
        // a capture that could not be admitted degrades to a path the model can
        // hand to read_image instead of silently dropping the observation.
        if (value.image === undefined) {
          return [envelope, { type: 'text', text: value.note ?? `The image is at ${value.path}.` }];
        }
        return [envelope, { type: 'image', attachment: value.image }];
      },
    },
    async execute(args, exec) {
      // Checked before the delay below, so a disabled capability never makes the
      // caller sit through a wait it was never going to be allowed to use.
      requireGrant(exec);
      const delay = Math.min(30, Math.max(0, args.delay_seconds ?? 0));
      if (delay > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay * 1000);
          exec.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('the call was cancelled'));
          }, { once: true });
        });
      }
      // One normalisation for both capture tools, so the same arguments mean the same thing
      // whether they are asked for here or inside computer_actions (A01).
      const spec = normalizeCaptureSpec({
        window: args.window,
        region: args.region,
        regionSpace: args.region_space,
        surface: args.surface,
        display: args.all_displays === true ? 'all' : args.display,
        clip: args.clip,
      });
      // A related capture is one worker call that returns one frame per related window
      // (8.txt §7). Each of them goes through the whole attachment pipeline — admitted,
      // reported back, `noteFrame`d — exactly like a single capture does, because a frame
      // that skipped any of that would be a frame the model cannot click through.
      if (args.captures === 'related') {
        if (!Number.isFinite(Number(args.window)) || Number(args.window) <= 0) {
          throw new Error("[BAD_REQUEST] captures: 'related' needs `window`: it captures that window and the windows that belong to it (a dialog, a popup menu, a tool window).");
        }
        const related = await call(exec, 'screenshot', {
          window: Number(args.window),
          captures: 'related',
          maxCaptures: args.max_captures,
          path: args.save_path,
          scale: args.scale,
          format: resolveFormat(args.format, args.save_path),
          clip: args.clip === true,
          surface: args.surface,
          settleMs: args.settle_ms,
          stabilityMs: args.stability_ms,
        }, { timeoutMs: Math.max(actionTimeoutMs, 45_000) });
        const listed = Array.isArray(related?.captures) ? related.captures : [];
        if (listed.length === 0) {
          const why = (Array.isArray(related?.omitted) ? related.omitted : [])
            .map((one) => `hwnd ${one.hwnd}: ${one.reason}`).join('; ');
          throw new Error(`[CAPTURE_SURFACE_UNAVAILABLE] hwnd ${Number(args.window)} and the windows that belong to it could not be captured${why === '' ? '' : ` — ${why}`}. A window that is minimized renders the shell's placeholder rather than its content; restore it first (computer_ui_action with control_type Window and action restore).`);
        }
        const frames = [];
        for (const one of listed) {
          const frameType = one.format === 'jpeg' ? 'image/jpeg' : 'image/png';
          const frameAdmitted = await captureService.admit(ctx, one.path, frameType, one.format === 'jpeg' ? 'screen.jpg' : 'screen.png', exec?.agent?.session?.id);
          await reportAttachment(exec, one, frameAdmitted);
          const entry = shotValue(one, frameAdmitted);
          const frameHwnd = Number(one.windowHwnd ?? one.window ?? args.window);
          if (Number.isFinite(frameHwnd) && frameHwnd > 0) entry.windowHwnd = frameHwnd;
          if (typeof one.relation === 'string' && one.relation !== '') entry.relation = one.relation;
          if (Number.isFinite(Number(one.ownerHwnd))) entry.ownerHwnd = Number(one.ownerHwnd);
          if (Number.isFinite(Number(one.zRank))) entry.zRank = Number(one.zRank);
          entry.zRankKnown = one.zRankKnown === true;
          if (typeof one.windowTitle === 'string' && one.windowTitle !== '') entry.windowTitle = one.windowTitle;
          refs.noteFrame(exec?.agent?.session?.id, entry.frame);
          frames.push(entry);
        }
        // The value is the first frame's own envelope (the popup, when there is one) plus the
        // whole array: an existing reader still sees an envelope, and the new one sees every
        // frame with its own id.
        const value = { ...frames[0], frames };
        if (Array.isArray(related.related)) value.related = related.related.map((row) => ({ ...row }));
        if (Array.isArray(related.omitted) && related.omitted.length > 0) value.omitted = related.omitted.map((row) => ({ ...row }));
        return value;
      }
      const { shot, path, captureMs, queueMs } = await capture(exec, {
        window: spec.window,
        requireWindow: args.require === 'window',
        display: spec.display,
        region: spec.region,
        regionSpace: spec.regionSpace,
        surface: spec.surface,
        clip: spec.clip,
        path: args.save_path,
        scale: args.scale,
        format: args.format,
        settleMs: args.settle_ms,
        stabilityMs: args.stability_ms,
        stable: args.stable,
      });
      const mediaType = shot.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const admitStarted = Date.now();
      const admitted = await captureService.admit(ctx, path, mediaType, shot.format === 'jpeg' ? 'screen.jpg' : 'screen.png', exec?.agent?.session?.id);
      // Say back what was delivered, so citing a coordinate from this image is arithmetic
      // rather than an assumption (A04).
      await reportAttachment(exec, shot, admitted);
      const value = shotValue(shot, admitted);
      refs.noteFrame(exec?.agent?.session?.id, value.frame);
      value.timing = captureTiming({ captureMs, admitMs: Date.now() - admitStarted, queueMs, startMs: Number(shot?.__bridgeTiming?.startMs ?? 0), shot });
      return value;
    },
  }));
}

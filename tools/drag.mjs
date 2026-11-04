/**
 * `computer_drag` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
export function registerComputerDrag(env) {
  const { safeRegister, defineTracedTool, refs, requireGrant, metrics, call, FRAME_RECEIPT_SCHEMA } = env;
  safeRegister(defineTracedTool({
    name: 'computer_drag',
    description:
      'Press the left mouse button at one coordinate, move to another, and release — for selecting text, moving windows, or dragging sliders. Give `path` instead of the four coordinates to drag through a shape (a drawing stroke, a selection that has to go round something, a drop that must pass over a target). Coordinates are virtual-desktop pixels. Requires 电脑操作.',
    parameters: {
      from_x: { type: 'integer', description: 'Absolute start x (or an image pixel when `from_frame` is set). Required unless `path` is given.' },
      from_y: { type: 'integer', description: 'Absolute start y (or an image pixel when `from_frame` is set). Required unless `path` is given.' },
      to_x: { type: 'integer', description: 'Absolute end x (or an image pixel when `from_frame` is set). Required unless `path` is given.' },
      to_y: { type: 'integer', description: 'Absolute end y (or an image pixel when `from_frame` is set). Required unless `path` is given.' },
      from_last: { type: 'boolean', description: 'Start where the last drag in this session ended, instead of naming from_x/from_y — for drawing a second stroke without re-locating the first one. Only the end coordinates are then required. The handle expires (短时有效), and if it has, the call is refused rather than continued from a guessed point.' },
      continue_from: { type: 'string', description: 'The `handle` from an earlier drag receipt: same as `from_last` but for that specific drag. A handle that is not the most recent one, or is past its lifetime, is refused (`DRAG_HANDLE_MISSING` / `DRAG_HANDLE_STALE`).' },
      path: {
        type: 'array',
        description: 'The waypoints to drag through, as `{x, y}` in the same space the four coordinates use (screen pixels, or image pixels with `from_frame`). Two to 64 points; duplicates are dropped and the gesture is sampled smoothly along the whole path, so a point every few pixels is not needed. Excludes from_x/from_y/to_x/to_y.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'integer', required: true },
            y: { type: 'integer', required: true },
          },
        },
      },
      duration_ms: { type: 'integer', description: 'How long the whole gesture takes, 100–5000 (default 400). The motion is spread over the path by arc length, so a long and a short segment each get the time they need. Ignored by the two-point form, which uses its own pacing.' },
      modifiers: { type: 'string', description: "A '+' separated chord held across the whole gesture, e.g. 'shift' to extend a selection or 'ctrl' to copy rather than move. A drag has no accessibility equivalent, so this is the only way to express it." },
      allow_activate: { type: 'boolean', description: 'With `from_frame`: allow one attempt at bringing the target window forward when the guard finds another process under the start point (default false).' },
      verify_content: { type: 'boolean', description: 'With `from_frame`: set false to skip the content check on an old frame (an animated surface always reads as changed). Default true.' },
      allow_windows: { type: 'array', items: { type: 'integer' }, description: "With `from_frame`: window handles this drag may land on besides the frame's own — see computer_click for the occlusion rule. Both ends are checked." },
      from_frame: { type: 'string', description: 'A frame id from computer_screenshot — see computer_click.from_frame. Both ends are projected before anything moves, so a stale frame refuses the whole gesture instead of half-executing it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'object', additionalProperties: false, required: true, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
          to: { type: 'object', additionalProperties: false, required: true, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
          handle: { type: 'string', description: 'The handle for this drag (8.txt §8)：把它交给下一次 computer_drag 的 `continue_from` 就能接着画，省掉重新定位起点。短时有效，过期或不是最近一个都会被拒绝。' },
          path: {
            type: 'object',
            additionalProperties: false,
            description: 'Present when the gesture followed a path rather than a straight line.',
            properties: {
              points: { type: 'integer', required: true, description: 'Waypoints after duplicates were dropped.' },
              samples: { type: 'integer', required: true, description: 'Mouse moves the gesture actually walked the path in.' },
              durationMs: { type: 'integer', required: true },
              paceMs: { type: 'integer', required: true, description: 'Delay between two samples, derived from duration_ms.' },
            },
          },
          modifiers: { type: 'string' },
          frame: FRAME_RECEIPT_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.path === undefined
          ? `Dragged ${value.modifiers === undefined ? '' : `${value.modifiers}+`}from (${value.from.x}, ${value.from.y}) to (${value.to.x}, ${value.to.y}).`
          : `Dragged ${value.modifiers === undefined ? '' : `${value.modifiers}+`}through ${value.path.points} waypoint(s) (${value.path.samples} mouse moves, ${value.path.durationMs} ms) from (${value.from.x}, ${value.from.y}) to (${value.to.x}, ${value.to.y}).`}${value.frame === undefined ? '' : ` (from frame ${value.frame.id}: image (${value.frame.fromImage.x},${value.frame.fromImage.y}) -> screen (${value.frame.projected.x},${value.frame.projected.y})${value.frame.note === undefined ? '' : `; ${value.frame.note}`})`}${value.handle === undefined ? '' : `\n这段的落点已记为句柄 ${value.handle}：接着画就用 continue_from: "${value.handle}"（或 from_last: true），句柄过期会被拒而不是猜一个点。`}`,
      }],
    },
    async execute(args, exec) {
      // The grant comes before everything else: a session that never turned 电脑操作 on should
      // hear that, not a complaint about the shape of arguments it was never allowed to use.
      requireGrant(exec);
      refs.assertFrameOwnership(exec?.agent?.session?.id, args.from_frame);
      const hasPath = Array.isArray(args.path) && args.path.length > 0;
      // §8 后半：起点可以来自上一次拖拽的落点，这时四个角点里只有终点是必需的。
      const continueFromLast = args.from_last === true || (typeof args.continue_from === 'string' && args.continue_from !== '');
      const corners = ['from_x', 'from_y', 'to_x', 'to_y'];
      if (hasPath) {
        const alsoCorners = corners.filter((name) => args[name] !== undefined);
        if (alsoCorners.length > 0) {
          throw new Error(`[BAD_REQUEST] computer_drag takes either \`path\` or ${corners.join('/')}, not both: a path already names where the gesture starts and ends (got ${alsoCorners.join(', ')} as well).`);
        }
        if (args.path.length < 2) throw new Error('[BAD_REQUEST] a drag path needs at least two points.');
        if (args.path.length > 64) throw new Error(`[BAD_REQUEST] a drag path takes at most 64 points (got ${args.path.length}); simplify it — the gesture is sampled smoothly, so vertices every few pixels are not needed.`);
        for (const [index, point] of args.path.entries()) {
          if (point === null || typeof point !== 'object' || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
            throw new Error(`[BAD_REQUEST] drag path point ${index} needs numeric x and y.`);
          }
        }
      } else {
        const required = continueFromLast ? ['to_x', 'to_y'] : corners;
        const missing = required.filter((name) => !Number.isFinite(Number(args[name])));
        if (missing.length > 0) {
          throw new Error(`[BAD_REQUEST] computer_drag needs ${missing.join(', ')} — or a \`path\` of waypoints instead.`);
        }
      }
      const result = await call(exec, 'drag', {
        fromX: hasPath || continueFromLast ? undefined : args.from_x,
        fromY: hasPath || continueFromLast ? undefined : args.from_y,
        toX: hasPath ? undefined : args.to_x,
        toY: hasPath ? undefined : args.to_y,
        fromLast: continueFromLast ? true : undefined,
        continueFrom: typeof args.continue_from === 'string' && args.continue_from !== '' ? args.continue_from : undefined,
        path: hasPath ? args.path.map((point) => ({ x: Number(point.x), y: Number(point.y) })) : undefined,
        durationMs: args.duration_ms,
        fromFrame: args.from_frame,
        modifiers: args.modifiers,
        allowActivate: args.allow_activate === true ? true : undefined,
        verifyContent: args.verify_content === false ? false : undefined,
        allowWindows: Array.isArray(args.allow_windows) && args.allow_windows.length > 0 ? args.allow_windows.map((one) => Number(one)) : undefined,
      }, { interactive: true });
      // `steps` from the backend is not declared, so it is dropped here.
      const value = { from: { x: Number(result.from.x), y: Number(result.from.y) }, to: { x: Number(result.to.x), y: Number(result.to.y) } };
      if (result.path !== null && result.path !== undefined) {
        value.path = {
          points: Number(result.path.points ?? 0),
          samples: Number(result.path.samples ?? 0),
          durationMs: Number(result.path.durationMs ?? 0),
          paceMs: Number(result.path.paceMs ?? 0),
        };
      }
      if (typeof result.modifiers === 'string' && result.modifiers !== '') value.modifiers = result.modifiers;
      // §8 后半：回执把句柄交回调用方，下一次就能用它（或 from_last）接着画。
      if (typeof result.handle === 'string' && result.handle !== '') value.handle = result.handle;
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

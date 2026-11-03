/**
 * apply.mjs — vision-control 的实时感知层（移植自 dsh-see-now 0.0.3，砍掉旁白/悬浮窗/后台唤醒）。
 *
 * 注册一个工具 `computer_watch`：ddagrab 实时采集 → HSV 变化分留帧 → 单箱 DP 装箱拼图，
 * 一张图恒定 ~218-872 token（quality 档位），静止屏幕近零开销。
 * 与 computer_screenshot 的分工：这个管"持续的余光"（变化驱动、便宜），
 * screenshot 管"精读"（全分辨率、可开窗、可区域）。
 *
 * 附件上交走宿主的 attachments 服务（与 capture.mjs 同一条通路）。
 */
import { existsSync } from 'node:fs';
import { createRunner, PACES, SIZES, DEFAULT_PACE, SCENE_OPTS } from './runner.js';

const TOOL_TIMEOUT_MS = 900_000;
/** 必须比宿主的 timeoutMs 早收工（see-now 原教训：挂得比死线久，整条调用被 abort） */
const MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40);
const DEFAULT_BLOCK_SEC = 300;

/** ffmpeg 解析链：环境变量 DSH_FFMPEG_PATH > 常见安装位置 > PATH。 */
function resolveFfmpeg() {
  const candidates = [
    process.env.DSH_FFMPEG_PATH,
    process.env.FFMPEG_PATH,
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* 下一个 */ }
  }
  return 'ffmpeg'; // 交给 PATH
}

/** 宿主校验返回值必须是无损 JSON：undefined 一律清掉。 */
function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

/**
 * @param ctx cordis 上下文
 * @param deps.registerTool  index.js 的 safeRegister（单工具失败不拖垮整插件）
 * @param deps.defineTool    index.js 的 defineTracedTool
 * @param deps.requireGrant  电脑操作的会话闸门（电脑操作 chip）
 */
export function applySeeNow(ctx, { registerTool, defineTool, requireGrant }) {
  const log = (m) => { try { ctx?.logger?.info?.(`[vision-control/see] ${m}`); } catch { /* ignore */ } };
  const runner = createRunner({ ffmpegPath: resolveFfmpeg(), log });
  ctx.on('dispose', () => { try { runner.stop(); } catch { /* ignore */ } });

  /** 把一张拼图 PNG 交进附件库，返回可渲染的 image 值。 */
  async function admitSheet(sheet, sessionId) {
    const attachments = (() => { try { return ctx.get?.('attachments') ?? ctx.attachments; } catch { return ctx.attachments; } })();
    if (!attachments || typeof attachments.saveImages !== 'function') {
      return { note: 'attachments 服务未挂载，图无法上交。', sheet: sheetMeta(sheet) };
    }
    const [ref] = await attachments.saveImages([
      { data: new Uint8Array(sheet.png), mediaType: 'image/png', name: 'watch-sheet.png' },
    ]);
    if (!ref) return { note: '附件存储未接收这张图。', sheet: sheetMeta(sheet) };
    // 关键：image 值必须是 saveImages 返回的**完整 ref 对象**。
    // 宿主会逐字节复核元数据（尺寸/格式/hash），手搓残缺对象会判
    // "Stored attachment metadata does not match its reference"。
    return {
      image: ref,
      sheet: sheetMeta(sheet),
    };
  }

  function sheetMeta(sheet) {
    return {
      from: sheet.from, to: sheet.to, why: sheet.why,
      w: sheet.w, h: sheet.h, frames: sheet.frames, cells: sheet.cells,
    };
  }

  /**
   * 拼图的文字说明。坐标映射写死在这里：图是整屏缩放到 w×h，
   * 模型拿去点屏幕时必须乘回去（屏幕尺寸用 computer_screenshot 的 envelope 拿）。
   */
  function sheetText(sheet, extra = {}) {
    const parts = [];
    if (extra.first) parts.push('冷启动首帧：这是"此刻"的屏幕。');
    const span = (sheet.to - sheet.from).toFixed(1);
    parts.push(`一张 ${sheet.w}×${sheet.h} 拼图，覆盖 ${span}s 内的 ${sheet.frames.length} 个画面（编号 1..${sheet.frames.length}，按时间序）。`);
    for (let i = 0; i < sheet.frames.length; i += 1) {
      const f = sheet.frames[i];
      const cell = sheet.cells[i];
      parts.push(`帧${i + 1}: t=${f.t}s via=${f.via} 档位=${f.tier} 位置=(${cell.px},${cell.py}) 大小=${cell.pw}×${cell.ph}`);
    }
    parts.push(`坐标映射：图是整屏缩放到 ${sheet.w}×${sheet.h} 的产物。图内坐标 (x,y) 换算成屏幕绝对坐标 = x×(屏幕宽/${sheet.w}), y×(屏幕高/${sheet.h})（屏幕尺寸见 computer_screenshot 的 envelope.displays）。`);
    parts.push('注意：本工具的图不能用 computer_click 的 from_frame 引用——用换算后的绝对坐标。要读小字别靠它：换 quality:"high"，或用 computer_screenshot 区域精读。');
    return parts.join('\n');
  }

  registerTool(defineTool({
    name: 'computer_watch',
    description:
      '实时感知屏幕：按画面变化量自动留帧、多帧拼成一张图返回（变化越多帧越多，静止时几乎不花 token）。'
      + '这是"余光"——和 computer_screenshot（全分辨率精读单帧）分工使用。\n\n'
      + '用法：\n'
      + '- `computer_watch({action:"watch"})` —— **阻塞**到有图或超时（默认上限 300s，画面变化时通常 15-40s 出一张）。'
      + '冷启动第一帧 ~1 秒内先给你"此刻"。操作电脑时保持这个调用挂着，屏幕一有变化你就能看到。\n'
      + '- `computer_watch({action:"peek"})` —— 立刻取走已攒下的图，不等。\n'
      + '- `computer_watch({action:"status"})` / `{action:"stop"}` —— 看状态 / 收工。\n\n'
      + '读不了小字就 `quality:"high"`（会重开采集 ~0.6s 并立刻给一帧此刻），别猜糊图。'
      + '帧按时间编号；图内坐标换算屏幕坐标 = ×(屏幕宽/图宽)。时序敏感的动作确认请用 '
      + 'computer_actions 的 wait_for（零 token），本工具帧有 ~0.5s 判定延迟，别拿它当确认信号。'
      + 'Requires 电脑操作.',
    parameters: {
      action: {
        type: 'string',
        description: 'watch（默认）| peek | stop | status',
      },
      quality: {
        type: 'string',
        description: '"low"（默认，800×450，≈218 token/张）| "standard"（1066×600，≈388）| "high"（1280×720，≈559，文件名能认）| "ultra"（1600×900，≈872，接近原屏）。换档会重开采集并立刻给一帧此刻。',
      },
      pace: {
        type: 'string',
        description: '"calm"（20 分算换画面，最多 30s 一张）| "normal"（默认 12 分/15s）| "dense"（7 分/8s，操作电脑时推荐）。粘性，改它重开采集约 0.5s。',
      },
      seconds: {
        type: 'integer',
        description: 'watch 的阻塞上限秒数（默认 300，封顶 860）。攒够图会提前返回。',
      },
      minFrames: {
        type: 'integer',
        description: 'watch 返回的图至少含几帧（默认 1）。静止屏幕上调可省 token。',
      },
      scene: {
        type: 'boolean',
        description: '逐场景模式：每留下一个画面单独一张满幅图（一格=一整帧），换画面即出图。默认关。',
      },
      source: {
        type: 'string',
        description: '采集源："screen"（默认整屏）| "obs" | "camera" | "file"（配合 path 回放本地视频，调试用）。只在首次调用生效。',
      },
      path: { type: 'string', description: 'source:"file" 时的视频绝对路径。' },
      realtime: { type: 'boolean', description: 'source:"file" 时按 1x 速度回放。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          image: { type: 'json' },
          meta: { type: 'json' },
        },
      },
      render(_args, value) {
        const blocks = [];
        if (value.image) blocks.push({ type: 'image', attachment: value.image });
        blocks.push({ type: 'text', text: value.text });
        return blocks;
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe() { return false; },   // 只有一个采集进程
    async execute(args, exec) {
      requireGrant(exec);
      const action = String(args.action ?? 'watch').toLowerCase();
      const sessionId = exec?.agent?.session?.id;

      if (action === 'status') {
        return toLosslessJson({ text: JSON.stringify(runner.status(), null, 2), image: null, meta: { action } });
      }
      if (action === 'stop') {
        const r = runner.stop();
        return toLosslessJson({ text: `采集已停止。${JSON.stringify(r)}`, image: null, meta: { action } });
      }

      if (action === 'peek') {
        const sheet = runner.peek();
        if (!sheet) return toLosslessJson({ text: '队列里还没有图（采集可能刚开或屏幕一直静止）。用 watch 等一张。', image: null, meta: { action } });
        const admitted = await admitSheet(sheet, sessionId);
        return toLosslessJson({
          text: sheetText(sheet) + (admitted.note ? `\n${admitted.note}` : ''),
          image: admitted.image ?? null,
          meta: { action, ...sheetMeta(sheet) },
        });
      }

      // watch
      const pace = args.pace && PACES[args.pace] ? args.pace : undefined;
      const opts = {};
      if (pace) { opts.cutAbs = PACES[pace].cutAbs; opts.wakeGapSec = PACES[pace].wakeGapSec; }
      if (args.scene === true) Object.assign(opts, SCENE_OPTS);
      const src = args.source
        ? { kind: args.source, path: args.path, realtime: args.realtime === true }
        : null;
      const seconds = Math.min(MAX_BLOCK_SEC, Math.max(2, Number(args.seconds ?? DEFAULT_BLOCK_SEC)));
      const r = await runner.watch({
        seconds,
        minFrames: Math.max(1, Number(args.minFrames ?? 1)),
        src,
        quality: args.quality && SIZES[args.quality] ? args.quality : null,
        opts,
        signal: exec?.signal ?? null,
      });
      if (!r.ok) {
        return toLosslessJson({
          text: `没拿到图：${r.reason}（等了 ${r.waited.toFixed(1)}s）${r.error ? `；${r.error}` : ''}。屏幕静止时长不出新帧是正常的——用 status 看采集活着没。`,
          image: null,
          meta: { action, reason: r.reason, waited: r.waited },
        });
      }
      const admitted = await admitSheet(r.sheet, sessionId);
      return toLosslessJson({
        text: sheetText(r.sheet, { first: r.first === true }) + (admitted.note ? `\n${admitted.note}` : ''),
        image: admitted.image ?? null,
        meta: { action, waited: r.waited, ...sheetMeta(r.sheet) },
      });
    },
  }));

  log('computer_watch 已注册（实时感知层）');
}

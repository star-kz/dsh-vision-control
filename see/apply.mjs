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
 * 区域订阅（新-P1-01）的**逐图安全文本**：sheet 带 origin 时返回声明行，否则 []。
 *
 * 硬条件②：这几行属逐图安全文本，**每张区域图都带**，永久豁免优-P0-08 的减税
 * （sheetExplained 闸管不到这里）——区域图不声明原点，模型就会拿图内坐标当全屏坐标点，
 * 这不是税，是安全声明。硬条件①（sheetText 声明区域原点）也由它兑现。
 *
 * 纯函数、模块级导出：冒烟测试直接断言文案，不必拉起整个工具。
 */
export function sheetRegionLines(sheet) {
  const o = sheet?.origin;
  if (!o) return [];
  return [
    `区域订阅：本图只覆盖屏幕矩形 原点=(${o.x},${o.y})、大小=${o.w}×${o.h}（屏幕绝对坐标系）——区域外发生什么本工具完全看不见。`,
    `区域坐标换算：逐格公式里的"屏幕宽/高"用区域宽 ${o.w}、高 ${o.h} 代入，算出的 (sx,sy) 再加 (${o.x},${o.y}) 才是屏幕绝对坐标。`,
  ];
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
  // 引擎探测预热：ddagrab/gdigrab 的试跑（~400ms）摊到注册期，首个 watch 的首帧不再付冷启动尖峰
  try { runner.preheat()?.catch?.(() => { /* 探测失败留给首个 watch 按原惰性路径兜底 */ }); } catch { /* 同上 */ }
  /** 固定说明（坐标换算 + 注意事项）给过没有：首图必出、换档图必出，其余图免念（ux P1-4）。 */
  let sheetExplained = false;
  /** 上次回执报告过的丢图数：只在**新增**丢弃时提醒一次，不每轮都念。 */
  let lastDroppedReported = 0;

  /**
   * 丢图回执：queueDepth=1 时取图比出图慢会顶掉最旧的图，
   * 不说的话模型以为"没送到 = 屏幕没动"。meta.dropped 是机器口径，
   * 这里只在计数**增加**时给一句人话。
   */
  function droppedNote() {
    const d = runner.dropped();
    if (d <= lastDroppedReported) return '';
    lastDroppedReported = d;
    return `\n（提示：出图队列已顶掉 ${d} 张旧图——取图比出图慢时最旧的会被丢弃；想看全就调快取图节奏）`;
  }

  /** 把一张拼图 PNG 交进附件库，返回可渲染的 image 值。 */
  async function admitSheet(sheet, sessionId) {
    const attachments = (() => { try { return ctx.get?.('attachments') ?? ctx.attachments; } catch { return ctx.attachments; } })();
    if (!attachments || typeof attachments.saveImages !== 'function') {
      return { note: 'attachments 服务未挂载，图无法上交。', sheet: sheetMeta(sheet) };
    }
    // sheet.png 是 Promise<Buffer>（异步 deflate，见 pipeline.js flush），先等落锤再上交
    let pngData;
    try { pngData = await sheet.png; } catch (e) {
      return { note: `PNG 编码失败：${e?.message ?? e}`, sheet: sheetMeta(sheet) };
    }
    const [ref] = await attachments.saveImages([
      { data: new Uint8Array(pngData), mediaType: 'image/png', name: 'watch-sheet.png' },
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
      // 新-P1-01 硬条件③：帧注册原点透传给 meta（整屏为 null，由 toLosslessJson 保留）
      origin: sheet.origin ?? null,
    };
  }

  /**
   * 拼图的文字说明。
   *
   * 坐标映射必须**逐格换算**：每格是整屏按 cover 方式（保持比例、居中裁掉放不下的边）
   * 缩放进该格的产物 —— 把多格拼图当"整屏一次性缩放"来换算，格内偏移错乘整图比例，
   * 点击坐标必错。屏幕尺寸用 computer_screenshot 的 envelope.displays 拿。
   */
  function sheetText(sheet, extra = {}) {
    const parts = [];
    if (extra.first) parts.push('冷启动首帧：这是"此刻"的屏幕。');
    if (extra.switched) parts.push('刚换了清晰度档：这是换档后此刻的屏幕。');
    const span = (sheet.to - sheet.from).toFixed(1);
    parts.push(`一张 ${sheet.w}×${sheet.h} 拼图，覆盖 ${span}s 内的 ${sheet.frames.length} 个画面（编号 1..${sheet.frames.length}，按时间序）。`);
    // 新-P1-01 硬条件①+②：区域图**每张**都声明原点与换算口径（逐图安全文本，
    // 永久豁免下方 explain 闸的减税）——不声明的话模型会拿图内坐标当全屏坐标点。
    parts.push(...sheetRegionLines(sheet));
    for (let i = 0; i < sheet.frames.length; i += 1) {
      const f = sheet.frames[i];
      const cell = sheet.cells[i];
      parts.push(`帧${i + 1}: t=${f.t}s via=${f.via} 档位=${f.tier} 位置=(${cell.px},${cell.py}) 大小=${cell.pw}×${cell.ph}`);
    }
    // 固定说明只在首图/换档图输出 —— 每张都念一遍是纯税（ux P1-4）。
    // 兜底：本会话一次都还没给过时必给（比如模型拿到的第一张贴图是 peek 来的）。
    const explain = extra.first === true || extra.switched === true || !sheetExplained;
    if (explain) {
      sheetExplained = true;
      const o = sheet.origin;
      if (o) {
        // 区域版换算（新-P1-01，依赖优-P0-08 Step A 的逐格公式）：采集帧 = 区域画面
        // stretch 到图宽×图高，所以公式里"屏幕宽/高"换成区域 w/h，最后加原点落回屏幕坐标。
        parts.push(`坐标映射（逐格换算，格内偏移不乘整图比例）：每格是**区域画面** cover 缩放进该格的产物（保持比例、居中裁掉放不下的边）。格 k 位置=(px,py) 大小=pw×ph 时，缩放比 s=max(pw/${sheet.w}, ph/${sheet.h})；格内点 (x,y)（px≤x<px+pw, py≤y<py+ph）换算成屏幕绝对坐标：sx=((x−px)/s + (${sheet.w}−pw/s)/2)×(${o.w}/${sheet.w})+${o.x}，sy=((y−py)/s + (${sheet.h}−ph/s)/2)×(${o.h}/${sheet.h})+${o.y}。单格铺满整图时 s=1，退化为 x×(${o.w}/${sheet.w})+${o.x}。`);
      } else {
        parts.push(`坐标映射（逐格换算，格内偏移不乘整图比例）：每格是整屏 cover 缩放进该格的产物（保持比例、居中裁掉放不下的边）。格 k 位置=(px,py) 大小=pw×ph 时，缩放比 s=max(pw/${sheet.w}, ph/${sheet.h})；格内点 (x,y)（px≤x<px+pw, py≤y<py+ph）换算成屏幕绝对坐标：sx=((x−px)/s + (${sheet.w}−pw/s)/2)×(屏幕宽/${sheet.w})，sy=((y−py)/s + (${sheet.h}−ph/s)/2)×(屏幕高/${sheet.h})（屏幕尺寸见 computer_screenshot 的 envelope.displays）。单格铺满整图时 s=1，退化为 x×(屏幕宽/${sheet.w})。`);
      }
      parts.push('注意：本工具的图不能用 computer_click 的 from_frame 引用——用换算后的绝对坐标。要读小字别靠它：换 quality:"high"，或用 computer_screenshot 区域精读。');
    }
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
      + '- 盯弹窗角/进度条/小部件用 `region` 只看那块区域：区域内等效分辨率上升、比整屏灵敏。\n\n'
      + '读不了小字就 `quality:"high"`（会重开采集 ~0.6s 并立刻给一帧此刻），别猜糊图。'
      + '帧按时间编号；多格拼图的坐标要逐格换算（公式随首图/换档图给出），单格满幅时 = ×(屏幕宽/图宽)。时序敏感的动作确认请用 '
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
        description: '"calm"（20 分算换画面）| "normal"（默认 12 分）| "dense"（7 分，操作电脑时推荐）。有持续变化时约 30/15/8 秒一张（calm/normal/dense）；静止时约 20s 兜底。粘性，改它重开采集约 0.5s。',
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
        description: '采集源："screen"（默认整屏）| "obs" | "camera" | "file"（配合 path 回放本地视频，调试用）。切换源或区域会重开采集。',
      },
      // 新-P1-01 HOST-SPEC-1：区域订阅参数。see/ 内部形态 = { kind:'screen', region:{x,y,w,h} }；
      // 非法值由 runner.start 拒收（{started:false, error}），宿主不重复校验。
      region: {
        type: 'json',
        description: '区域订阅：{x,y,w,h} 屏幕绝对坐标矩形（与 computer_screenshot 的 envelope.displays 同套坐标），只看这块区域。区域内等效分辨率上升、更灵敏。换区域会重开采集（~0.6s）并立刻给一帧此刻；不传=整屏。只在屏幕源有意义。',
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
          text: sheetText(sheet) + (admitted.note ? `\n${admitted.note}` : '') + droppedNote(),
          image: admitted.image ?? null,
          meta: { action, dropped: runner.dropped(), ...sheetMeta(sheet) },
        });
      }

      // watch
      const pace = args.pace && PACES[args.pace] ? args.pace : undefined;
      const opts = {};
      // pace 的节奏承诺落在 pipeline 的时间闸（maxWaitSec）上：wakeGapSec 声明了却从不接线的话，
      // 「传 calm 省一半」就只是口头承诺（pipeline.js 的 frames>=3 && t-sheetStart>=maxWaitSec 才是真闸）。
      if (pace) { opts.cutAbs = PACES[pace].cutAbs; opts.maxWaitSec = PACES[pace].wakeGapSec; }
      if (args.scene === true) Object.assign(opts, SCENE_OPTS);
      // 新-P1-01 HOST-SPEC-1：region 优先——它自带 screen 语义；换源/换区域由 runner 的
      // srcChanged 支路重开采集（相同源不重开，区域订阅稳态就是每条 watch 带同一个 region）。
      const src = args.region != null
        ? { kind: 'screen', region: args.region }
        : args.source
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
        text: sheetText(r.sheet, { first: r.first === true, switched: r.sheet.why === 'oneshot' }) + (admitted.note ? `\n${admitted.note}` : '') + droppedNote(),
        image: admitted.image ?? null,
        meta: { action, waited: r.waited, dropped: runner.dropped(), ...sheetMeta(r.sheet) },
      });
    },
  }));

  log('computer_watch 已注册（实时感知层）');
}

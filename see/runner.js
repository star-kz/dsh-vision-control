/**
 * runner.js — 常驻采集会话：start / watch / peek / stop。
 *
 * 和 pipeline.js 的分工：pipeline 只管「帧进、图出」，不碰进程；这里管**进程生命周期**
 * 和**取图语义**（阻塞到有图 / 立刻要 / 保持温热）。
 *
 * ## 三条刻意的设计
 *
 * ① **出图由采集侧自己攒、自己截**（pipeline 里做），`watch` 只是"取队列里那一张"。
 *    所以模型思考三秒不是延迟，只是让队列多一张。
 *
 * ② **停采集要留宽限期**。冷启动一次 400ms（屏幕）/ 1.7s（摄像头硬件唤醒），
 *    每次 watch 都停掉的话，连续看就是每次重付这笔钱。所以看完留 `graceSec` 秒，
 *    期间再来 watch 立刻就有帧；超时没人来才自己收工。
 *
 * ③ **取图永远走队列，不新建**。两张图同时在飞的时候，`take()` 给的是最早那张
 *    （时间顺序不能乱），新图挤掉旧图由 pipeline 的 queueDepth 负责。
 */

import { spawnFrames, pickScreenEngine, normalizeRegion } from './capture.js';
import { createPipeline } from './pipeline.js';
// vision-control 裁剪说明：原 see-now 的悬浮窗（window.js）、聊天轮询（chat.js）、
// 插话回执（interject.js）、旁白 TTS（speech/voice）已按需求整体移除。
// 本文件不再 import 它们；所有"用户从悬浮窗插话"的路径已删除。

/** 三档清晰度。数字是画布像素，token 约等于 像素÷1650（见调参报告）。 */
export const SIZES = Object.freeze({
  low: [800, 450],        // 218 token/张 · 4 帧时每格 400×225 —— 看视频/场景够
  standard: [1066, 600],  // 388 token/张 · 每格 533×300 —— 屏幕上的中号字能认
  high: [1280, 720],      // 559 token/张 · 每格 640×360 —— 文件名/小字能认
  ultra: [1600, 900],     // 872 token/张 · 单帧时几乎等于原屏 —— 真要读字才用（仍低于 1024 封顶）
});
export const DEFAULT_QUALITY = 'low';

/**
 * 「逐帧 / 逐场景」模式的管线参数。
 *
 * - `maxFrames: 1` —— 留下 1 帧就立刻封箱（`checkFlush` 的 `frames.length >= maxFrames`），
 *   所以一张图永远只有一个画面。
 * - `strategy: 'single'` —— 档位固定压到 1，让这一帧**铺满整张画布**。
 *   不压的话，场景密集时密度档位会升到 2/3，一格只占 1/4、1/9，中间全是灰条。
 *
 * 这两个必须成对出现：只改 maxFrames 会得到"小格子 + 大片留白"，只改 strategy
 * 会得到"一张图里好几幅满幅图，装不下就被切开"。
 */
export const SCENE_OPTS = Object.freeze({ maxFrames: 1, strategy: 'single' });

/**
 * 三档节奏。**只影响"多久算一次画面变了"和"多久叫醒一次"**，不改出图口径。
 *
 * 为什么要有它：`cutAbs` 是全局常量，模型听见"省点钱"也只能嘴上答应 ——
 * 频率完全由插件定。用户实报"回复太密集"，说明缺一个能让这句话生效的旋钮。
 *
 * | 档 | cutAbs | 唤醒间隔 | 适合 |
 * |---|---|---|---|
 * | calm | 20 | 30s | 日常挂着看，只想知道"大场面变了没" |
 * | normal | 12 | 15s | 默认。滚网页/切窗口不会每下都留帧 |
 * | dense | 7 | 8s | 幻灯片、逐帧播报这种"每一刀都要"的 |
 *
 * 7 是能给的最低值（再低只有"只改亮度"那种肉眼都看不出的变化），
 * 但它对日常屏幕太敏感 —— 光标一停、窗口一换都能过线，所以不做默认。
 */
export const PACES = Object.freeze({
  calm: { cutAbs: 20, wakeGapSec: 30 },
  normal: { cutAbs: 12, wakeGapSec: 15 },
  dense: { cutAbs: 7, wakeGapSec: 8 },
});
export const DEFAULT_PACE = 'normal';

/** 参数签名：key 排序后拼串，`{a:1,b:2}` 与 `{b:2,a:1}` 视为同一个。 */
function optsSig(o) {
  return Object.keys(o ?? {}).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join('|');
}

/**
 * 采集源签名（新-P1-01）：两条 watch 的 src 指不指向同一个东西。
 *
 * 只拼"影响采集内容"的字段（kind/path/device/realtime/region），不拼 engine ——
 * engine 是 start 解析出来的实现细节，auto→ddagrab 不该触发重开。
 * 区域坐标经 normalizeRegion 归一后比较，`{x:100.0}` 与 `{x:100}` 是同一个区域。
 *
 * 为什么需要它：区域订阅的常态操作是"换个区域接着看"，而旧行为是 src 只在
 * 冷启动生效、运行中传新 src 被静默忽略（模型以为换了区域，其实还在看旧的）。
 */
export function srcSig(s) {
  if (!s || !s.kind) return 'null';
  let r = '';
  try {
    const n = normalizeRegion(s.region);
    if (n) r = `${n.x},${n.y},${n.w},${n.h}`;
  } catch { r = 'invalid'; }
  return [s.kind, s.path ?? '', s.device ?? '', s.realtime === true ? 1 : 0, r].join('|');
}

/**
 * 「这一条 watch 该不该被硬闸拦下」的**纯函数**（好测，也好读）。
 *
 * 三条规矩：
 * - 用户关过窗（`hungUp`）→ 除非他显式说了要看什么，否则不重开。
 * - 文件放完了（`fileEnded`）→ 同上，文件回放是一次性的，不能自动重播。
 * - 显式传了来源 = 用户明确要求 → 一律放行。
 */
export function guardReason({ hungUp = false, fileEnded = false, explicitSrc = false } = {}) {
  if (explicitSrc) return null;
  if (hungUp) return 'hung-up';
  if (fileEnded) return 'file-ended';
  return null;
}

export function createRunner({ ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60 } = {}) {
  let pipeline = null;   // 当前（或刚停的）引擎 —— 停采集后仍留着，好把队列里剩的图发完
  let running = false;
  let run = null;
  let source = null;
  let startedAt = 0;
  let frames = 0;
  let lastError = null;
  let stoppedAt = 0;
  let graceTimer = null;
  let busy = false;
  let quality = DEFAULT_QUALITY;
  /**
   * 建当前管线时用的**调用方参数**（不含 oneShot）。
   *
   * 为什么需要：分辨率换了可以看 `quality`，但"逐帧模式"换的是管线参数
   * （`maxFrames` / `strategy`）—— 那些是建管线时定死的，运行中改不了。
   * 于是 watch 每次比一下签名，变了就重开：`{}` 和 `{maxFrames:1,strategy:'single'}`
   * 是两套完全不同的出图口径，不能在同一根管线上混着跑。
   */
  let runOpts = {};

  /**
   * 待领的说明（挂断那一条）。
   *
   * **为什么不写进 chat.jsonl**：窗被关掉之后，写进那条流的字没有任何人会看到；
   * 模型也拿不到，于是它继续调 `watch` —— 实测会连写两条挂断说明（相隔 96ms），
   * 模型却在说"我还在看"。
   *
   * 正确的路子和陪看一样：落在这里，下一次工具结果把它带走。
   */
  let pendingNote = null;
  /**
   * 用户"关窗挂断"过没有。
   *
   * 关窗之后再被叫醒一次，`watch` 会**重新把窗开起来**、把采集重启 ——
   * 用户看到的是"关不掉，只能卸载插件"（社区实报）。所以这里是个硬闸：
   * 挂断之后只有**显式指定来源**（用户说了要看什么）才允许重新开始。
   */
  let hungUp = false;
  /** 最近一次的采集源（teardown 会把 `source` 清空，但事后判断还需要它） */
  let lastSource = null;
  /**
   * 已经放完的文件源。**文件回放是一次性的**：放完就结束，不能自动重播。
   *
   * 以前 `watch` 会在 `stopped` 时用 `prevSrc` 自动重启，而文件源重启就是
   * "从头再放一遍"，于是 24 秒解 1955 帧、出一堆图、把模型反复叫醒，
   * 关窗也停不下来（社区实报的那条）。
   */
  let endedSource = null;

  function teardown(why) {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    run?.stop();
    run = null;
    running = false;
    source = null;
    stoppedAt = Date.now();
    if (why) log(`收工：${why}`);
  }

  /** 停采集，但留一个宽限期 —— 这期间再来 watch 不用重新热启动 */
  function armGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    if (graceSec <= 0) { teardown('grace=0'); return; }
    graceTimer = setTimeout(() => teardown(`${graceSec}s 没人来`), graceSec * 1000);
    graceTimer.unref?.();
  }

  /**
   * 续命（常驻循环每拍调一次）。
   *
   * **不加这个，循环会被宽限期饿死**：一次 `watch` 结束后留 60 秒宽限，时间一到采集收工，
   * 而静止屏幕上 60 秒内又不会出新图 —— 循环下一拍看到 `!running && !pending`，
   * 就判定"采集自己停了"并自杀。用户安安静静看文档时，这个"常驻循环"最多活 60 秒。
   *
   * 只续"还在跑"的采集：ffmpeg 真死了不能靠它诈尸。
   */
  function touch() {
    if (!running) return false;
    armGrace();
    return true;
  }

  async function start({ src = { kind: 'screen' }, opts = {}, quality: q = null } = {}) {
    if (running) return { already: true, source };
    // 走到这里就是"明确要开始看"（watch 的自动重启已经在前面被硬闸挡住了）。
    hungUp = false;
    endedSource = null;
    /**
     * 区域订阅（新-P1-01）：region 在这里归一化+校验（非法直接拒收，不带着坏参数 spawn）。
     * 归一化后的 {x,y,w,h} 同时进两处：采集命令（gdigrab 设备侧偏移 / ddagrab -vf crop，
     * 见 capture.js）和管线 origin（帧注册带原点，见 pipeline.js flush）。
     */
    let region = null;
    try { region = normalizeRegion(src?.region); } catch (e) {
      lastError = `region: ${e?.message ?? e}`;
      log(`拒收：${lastError}`);
      return { started: false, error: lastError };
    }
    let engine = src.engine ?? 'auto';
    if (src.kind === 'screen' && engine === 'auto') engine = await pickScreenEngine({ ffmpegPath });
    const size = SIZES[q] ?? SIZES[DEFAULT_QUALITY];
    // oneShot 由调用方（watch）决定：**只有换清晰度**时置 true（缓冲区刚扔，等攒满等于白等一个窗口）
    const p = createPipeline({ ...opts, width: size[0], height: size[1], origin: region });
    // 记下"这次建管线用的调用方参数"（不含 oneShot）——watch 靠它发现"模式变了"。
    runOpts = { ...opts };
    delete runOpts.oneShot;
    const s = { ...src, engine };
    if (region) s.region = region;   // 归一化结果回写：source/status/签名全用同一套整数
    quality = q ?? DEFAULT_QUALITY;
    frames = 0;
    lastError = null;
    pipeline = p;
    running = true;
    source = s;
    lastSource = s;
    startedAt = Date.now();
    run = spawnFrames({
      source: s,
      width: p.constants.width,
      height: p.constants.height,
      fps: p.constants.fps,
      ffmpegPath,
      engine,
      onFrame: (f) => {
        frames += 1;
        // 一帧解码就抛 = 整条管线停摆，这里必须兜住：宁可少一帧，不能让采集线程炸掉
        try { p.push(f); } catch (e) { lastError = `push: ${e?.message ?? e}`; }
      },
      onStderr: (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); },
    });
    run.done.then((r) => {
      if (pipeline === p) {
        lastError ??= `ffmpeg 退出（${r.frames} 帧 / ${Math.round(r.ms / 1000)}s）`;
        // 文件源放完 = 这一次看完了。记下来，别让下一条 watch 又从头放一遍。
        if (s.kind === 'file') endedSource = s;
        teardown('ffmpeg-exit');
      }
    }).catch((e) => {
      lastError = `ffmpeg: ${e?.message ?? e}`;
      if (pipeline === p) teardown('ffmpeg-error');
    });
    log(`开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''}${region ? ` 区域(${region.x},${region.y} ${region.w}×${region.h})` : ''} @${size[0]}×${size[1]}`);
    return { started: true, source: s, engine, quality, params: p.constants };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 预热屏幕引擎探测（授权/启动时调一次）。
   *
   * `pickScreenEngine` 原本惰性发生在**首个 watch 的首帧路径上**（start 里 await），
   * 白付一次 ffmpeg 试跑（~400ms）的冷启动尖峰。预热把它摊到插件注册期；
   * 结果由 capture.js 进程级缓存，之后每次 start 都是 0 成本。
   * 探测自己兜底成 gdigrab、从不 reject，但调用方仍按 fire-and-forget 接 catch。
   */
  function preheat() {
    return pickScreenEngine({ ffmpegPath });
  }

  return {
    start,
    preheat,
    stop() { teardown('手动'); return { stopped: true }; },
    /**
     * 用户关掉了悬浮窗 = 明确表示"不看了"。
     *
     * 只 `stop()` 不够：下一条 `watch` 看到 `stopped` 会立刻重启采集并把窗**重新开起来**，
     * 用户体感就是"关掉又弹出来，除非卸载插件"（社区实报）。这里立一个硬闸，
     * 直到有人显式指定来源为止。
     */
    hangUp() { hungUp = true; teardown('用户关窗'); return { hungUp: true }; },
    /** 挂断状态（测试和状态页用） */
    isHungUp() { return hungUp; },
    /** 有没有一个"已经放完、不能自动重播"的文件源 */
    endedFile() { return endedSource ? { ...endedSource } : null; },

    /**
     * 阻塞等一张图。
     *
     * `quality` 换了就**重启采集**（分辨率是采集侧定死的，改不了）：
     * 分辨率在采集那一层就定死了，所以换清晰度 = 换一根管道。重启一次 ~400ms，
     * 但换完只发一帧就把"现在是什么"给出去，不用再等攒满一张。
     *
     * @param {{seconds?:number, minFrames?:number, src?:object, quality?:string, opts?:object,
     *          signal?:AbortSignal|null, eagerMs?:number}} o
     * @returns {Promise<{ok:boolean, reason?:string, sheet?:object, waited:number}>}
     */
    async watch({
      seconds = 300, minFrames = 1, src = null, quality: q = null, opts = {},
      // 宿主给的取消信号。**必须在这里看**：不看的话用户按了停止，这个调用还要挂到封顶
      // （陪看那边专门写过这条：`signal` 是"这一轮被取消了"的唯一通知）。
      signal = null,
      // 冷启动时"先给此刻"的宽限：等第一帧最多这么久，等到就立刻出图。
      eagerMs = 3000,
    } = {}) {
      /**
       * 三个"不许自动重开"的硬闸。都来自社区实报：
       * 「回放会解 1955 帧、攒一堆唤醒、一直弹有新画面，关窗也停不干净，得卸载才行」。
       *
       * 共同原因是 `watch` 在 `stopped` 时会**自动重启采集**，而重启对文件源意味着
       * 从头再放一遍，对关过窗的用户意味着"我刚关掉它又弹出来了"。
       * 所以：只有**显式传了来源**（用户明确说要看什么）才允许清闸重开。
       */
      const explicitSrc = Boolean(src && src.kind);
      const blocked = guardReason({ hungUp, fileEnded: Boolean(endedSource), explicitSrc });
      if (blocked === 'hung-up') return { ok: false, reason: 'hung-up', waited: 0 };
      if (blocked === 'file-ended') {
        return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
      }
      if (explicitSrc) { hungUp = false; endedSource = null; }

      if (busy) return { ok: false, reason: 'busy', waited: 0 };
      busy = true;
      const t0 = Date.now();
      try {
        const prevSrc = source ?? lastSource;
        const switching = Boolean(pipeline) && q && SIZES[q] && q !== quality;
        // 管线参数变了（常规 ↔ 逐帧）：这两套口径建管线时就定死了，只能重开。
        const modeChanged = Boolean(pipeline) && optsSig(runOpts) !== optsSig(opts);
        /**
         * 新-P1-01：显式传了**不同的**源（含换区域）也重开。旧行为里 src 只在冷启动生效，
         * 运行中传新 src 被静默忽略 —— 模型以为换了区域，其实还在看旧的。
         * 签名相同不重开：区域订阅的稳态就是每条 watch 都带着同一个 region。
         */
        const srcChanged = Boolean(pipeline) && explicitSrc && srcSig(src) !== srcSig(source);
        /**
         * **要不要重开采集**：`pipeline` 不为空**不等于**采集还在跑。
         *
         * `teardown()` 故意留着 `pipeline`（好把队列里剩下的图发完），于是宽限期到点、
         * 或者模型 `stop` 之后，`pipeline` 还在但 `running` 已经是 false ——
         * 只看 `!pipeline` 就会"跳过启动、直接等一张永远不会来的图"，等到封顶才回一句
         * "没看成"。用户看到的是"第一次能看，第二次就不行了"。
         */
        const stopped = Boolean(pipeline) && !running;
        // **冷启动**（手上没有管线，或采集已经停了）才 eager。换清晰度不算 —— 那条路已经用 oneShot 了。
        const cold = !pipeline || stopped;
        if (!pipeline || stopped || switching || modeChanged || srcChanged) {
          if (pipeline) {
            teardown(stopped ? '采集已停，重开'
              : switching ? `换清晰度 ${quality} → ${q}`
              : srcChanged ? `换采集源（${srcSig(src)}）`
              : '换模式（逐帧 / 常规）');
          }
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          const st = await start({
            src: src ?? prevSrc ?? { kind: 'screen' },
            // 只有**换清晰度**才 oneShot：那一下缓冲区刚被扔掉，等攒满一张就等于白等一整个窗口。
            // 普通的第一次 watch 不 oneShot —— 模型要的是"这 20 秒"，不是"此刻"。
            opts: { ...opts, oneShot: switching },
            quality: q,
          });
          /**
           * start 拒收（典型：region 非法被 normalizeRegion 拦下）必须透传成回执 error。
           * 不看返回值继续走的话：热态下旧采集已被 teardown 拆掉，等待循环立刻 break，
           * flushNow 拿旧管线出一张**旧区域**的图还回 ok:true —— 模型以为换区域成功了。
           * （review-see P1-1：HOST-SPEC-1 第 2 条口径 = 非法 region 在回执 error 带原因。）
           */
          if (st && st.started === false) {
            return { ok: false, reason: 'start-failed', waited: (Date.now() - t0) / 1000, error: st.error ?? lastError };
          }
        } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

        const deadline = t0 + Math.max(2, seconds) * 1000;
        {
          /**
           * **冷启动先给此刻**。
           *
           * 静止屏幕上第一条要等 30~60 秒（兜底帧 20 秒一个，攒 3 帧才封箱）——
           * 用户说"看看我屏幕"，等一分钟才回话，体感就是"它没反应"。
           * 所以冷启动时第一帧到手就发，多花一张图（216 token），换"1 秒内给反应"。
           *
           * 只在冷启动生效：管温着的时候再 eager，就退化成"每帧一张图"了。
           * **插话优先**：这 3 秒里用户说话了，就按插话走（体感上他是在追问）。
           */
          if (cold && minFrames <= 1 && eagerMs > 0) {
            const eagerUntil = Date.now() + eagerMs;
            while (Date.now() < eagerUntil && !signal?.aborted) {
              if (pipeline?.hasFrame) {
                const first = pipeline.flushNow(null, 'first');
                if (first) {
                  return {
                    ok: true, sheet: first, waited: (Date.now() - t0) / 1000,
                    quality, first: true,
                  };
                }
              }
              await sleep(60);
            }
          }

          while (Date.now() < deadline) {
            // 宿主取消了这一轮（用户按停止 / 超时策略）就立刻收工，别继续挂着
            if (signal?.aborted) {
              return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
            }
            const s = pipeline?.take();
            if (s) return { ok: true, sheet: s, waited: (Date.now() - t0) / 1000, quality };
            if (!running && !pipeline?.pending) break;   // 采集停了，队列也空了
            await sleep(120);
          }
        }
        // 到点了：手上攒的半张也算数（用户已经在等），但不够 minFrames 就不给
        const last = pipeline?.flushNow(null, 'timeout');
        if (last && last.frames.length >= minFrames) {
          return { ok: true, sheet: last, waited: (Date.now() - t0) / 1000, partial: true, quality };
        }
        return {
          ok: false,
          reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
          waited: (Date.now() - t0) / 1000,
          error: lastError,
        };
      } finally {
        busy = false;
        if (pipeline) armGrace();
      }
    },

    /**
     * 立刻截断出图（用户插话走这条）：不等判据、不排队。
     *
     * 顺便支窗（**不等它**）：走 peek 路线的会话没有 watch 的阻塞点，
     * 不在这里开窗的话，用户永远没有可以打字的入口，也就没有"关窗 = 不看了"。
     */
    peek() {
      const s = pipeline?.flushNow();
      if (running) armGrace();
      return s ?? null;
    },

    /** 常驻循环每拍续命（见 touch 的注释） */
    touch,

    /** 出图队列溢出丢掉的图数（queueDepth=1：取图比出图慢时顶掉最旧的）——回执要把它带给模型 */
    dropped() { return pipeline?.dropped ?? 0; },

    /** 落一条说明，等下一次工具结果带走（挂断那一条走这里） */
    note(text) {
      const t = String(text ?? '').trim();
      if (t) pendingNote = t;
      return pendingNote;
    },

    /** 取走说明（取完就没了：同一句话不该每一轮都念一遍） */
    takeNote() {
      const n = pendingNote;
      pendingNote = null;
      return n;
    },

    status() {
      return {
        running,
        source,
        lastSource,
        hungUp,
        endedFile: endedSource?.path ?? null,
        quality,
        size: SIZES[quality],
        frames,
        since: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        lastError,
        idleSec: stoppedAt ? Math.round((Date.now() - stoppedAt) / 1000) : 0,
        stats: pipeline?.stats ?? null,
        pending: pipeline?.pending ?? 0,
        // 出图序号（单调递增）：常驻循环靠它保证"同一张图只叫醒一次"。
        // `pending` 只说明"队列里有"，不说明"是不是新的一张"—— 模型不取的话它一直是 1。
        sheets: pipeline?.stats?.sheets ?? 0,
        // 本批第一帧到现在多久：唤醒文案里要说"攒了多久"，不然模型不知道这段时间有多长
        secondsSinceWake: pipeline?.secondsSinceWake ?? null,
        // 有没有待领的说明（挂断那条）—— status 里看得见，才不会"明明写了没人读"
        notePending: Boolean(pendingNote),
      };
    },
  };
}

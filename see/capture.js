/**
 * capture.js — 唯一 spawn ffmpeg 的地方。**一根 rawvideo 管道**，不再切分片。
 *
 * 为什么不是「2 秒一片 + `-ss` 回抓」：分片必须关闭才能 seek，光这一条就是 2 秒固定延迟；
 * 每抓一帧还要 spawn 一次 ffmpeg（实测 135ms）。实时场景要的是「帧到手就判、判完就留」，
 * 所以直接 `-f rawvideo` 吐 rgb24，帧在内存里，留帧零成本。
 *
 * ## 三种源的实测（本机 2560×1600 屏 / i9-12900HX，12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `ddagrab`（桌面复制 API） | 370 ms | **0.28 核** | 走 GPU，屏幕的原生路子 |
 * | `gdigrab`（GDI 抓屏） | 310 ms | 0.45 核 | 每帧先从 GDI 拷 2560×1600 BGRA = **16 MB** 再缩 |
 * | `obs`（OBS 虚拟摄像头） | 575 ms | 0.13 核 | 设备侧已经缩好了，最省 |
 * | `camera`（USB 摄像头） | **1450 ms** | 0.14 核 | 首帧慢是**硬件唤醒**，参数救不了 |
 * | Nikon Webcam Utility（客户端没开） | — | 0.80 核 | 只有 3.4 fps，等于卡死 |
 *
 * 结论：屏幕源**默认用 ddagrab**，跑不起来退回 gdigrab；设备源别停进程 —— 首帧延迟只能靠常驻摊掉。
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const ENGINES = Object.freeze(['auto', 'ddagrab', 'gdigrab']);

/**
 * 区域订阅（新-P1-01）的区域归一化。纯函数，可单测。
 *
 * 内部形态定死为 `source = { kind:'screen', region:{x,y,w,h} }`（屏幕绝对坐标系，
 * 与 computer_screenshot 的 envelope.displays 同一套）。`{type:"region", base:"screen"}`
 * 那种工具面形态由宿主侧翻译成本形态，see/ 里只有这一种。
 *
 * - 缺 region → null（整屏）。
 * - x/y 允许负值：多显示器的虚拟桌面坐标系里副屏可以在原点左/上（gdigrab 支持负偏移；
 *   ddagrab 的 crop 对负值会报错，由 ffmpeg 错误链兜底）。多屏参数化是新-P2-06 的事。
 * - w/h 至少 2×2（再小没有观察意义，也能拦住把 x/y 误传成 w/h 的调用）。
 * - 字段非法 → RangeError。越界（区域超出屏幕）不在此处拦：see/ 不知道屏幕多大，
 *   由 ffmpeg 报错或宿主侧按 displays 预检（见 HOST-SPEC）。
 */
export function normalizeRegion(region) {
  if (region == null) return null;
  const x = Math.trunc(Number(region.x));
  const y = Math.trunc(Number(region.y));
  const w = Math.trunc(Number(region.w ?? region.width));
  const h = Math.trunc(Number(region.h ?? region.height));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`region 原点非法：x=${region.x}, y=${region.y}`);
  }
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) {
    throw new RangeError(`region 尺寸非法：w=${region.w ?? region.width}, h=${region.h ?? region.height}（至少 2×2）`);
  }
  return { x, y, w, h };
}

/** 源描述 → 输入参数。纯函数，可单测。 */
export function sourceArgs(source = { kind: 'screen' }, { engine = 'auto', fps = 12 } = {}) {
  const s = source ?? {};
  switch (s.kind) {
    case 'obs':
      return ['-rtbufsize', '256M', '-thread_queue_size', '512',
        '-f', 'dshow', '-i', `video=${s.device ?? 'OBS Virtual Camera'}`];
    case 'camera':
      return ['-rtbufsize', '256M', '-thread_queue_size', '512',
        '-f', 'dshow', '-i', `video=${s.device ?? 'HD Webcam'}`];
    case 'screen': {
      const useDda = s.engine === 'ddagrab' || (s.engine !== 'gdigrab' && engine !== 'gdigrab');
      if (!useDda) {
        // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
        // 区域偏移在**设备侧**完成（-offset_x/-offset_y/-video_size）：GDI 只拷区域那块，
        // 16MB 全屏拷贝直接省掉，这是区域订阅在 gdigrab 上几乎零代价的原因。
        const r = normalizeRegion(s.region);
        const region = r
          ? ['-offset_x', String(r.x), '-offset_y', String(r.y),
            '-video_size', `${r.w}x${r.h}`]
          : [];
        return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', ...region,
          '-i', s.desktop ?? 'desktop'];
      }
      // ddagrab 是 filter source，输入侧没有帧率参数（区域裁剪在 captureArgs 的 -vf 里做）
      return ['-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=${s.mouse ? 1 : 0}`];
    }
    case 'file':
      // `realtime` 才加 -re；离线跑要看的是「管线本身多快」，不能被播放速度骗了
      return [...(s.realtime ? ['-re'] : []), '-i', String(s.path)];
    case 'rtmp':
      return s.listen === false ? ['-i', String(s.url)] : ['-listen', '1', '-i', String(s.url)];
    default:
      throw new RangeError(`unknown source kind: ${s.kind}`);
  }
}

/** ddagrab 出来的帧还在 GPU 上，得先 hwdownload 再缩。 */
function isDda(source, engine) {
  if (source?.kind !== 'screen') return false;
  const e = source?.engine ?? engine;
  return e !== 'gdigrab';
}

/**
 * 完整的采集命令。
 *
 * **`-r` 只在源帧率不等于目标时才挂**：gdigrab/ddagrab 已经按 fps 抓了，
 * 再串一个 fps 滤镜是白跑一趟（实测 12fps 下省 3–5% CPU）。
 */
export function captureArgs({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  fast = true, sws = 'area',
} = {}) {
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  if (fast) {
    // `-fflags nobuffer` 只对**直播式**输入有意义，而且它会把 `-re` 的文件回放直接堵死
    // （实测：加上它、配上 -re，4 秒一个字节都不出；去掉立刻 57MB）。
    if (source?.kind !== 'file') args.push('-fflags', 'nobuffer');
    args.push('-flags', 'low_delay');
    if (source?.kind === 'obs' || source?.kind === 'camera') {
      args.push('-probesize', '32', '-analyzeduration', '0');
    }
  }
  args.push(...sourceArgs(source, { engine, fps }));
  args.push('-an', '-sn');
  // 区域订阅（新-P1-01）：gdigrab 已在设备侧偏移+裁好（见 sourceArgs），这里只剩 scale；
  // ddagrab 输入侧没有裁剪参数，在 -vf 里插 crop —— 位置必须在 hwdownload/format 之后
  // （crop 吃内存帧，不能裁 GPU 帧）、scale 之前（先裁再缩，缩放只算区域那一份像素）。
  const r = source?.kind === 'screen' ? normalizeRegion(source?.region) : null;
  args.push('-vf', isDda(source, engine)
    ? `hwdownload,format=bgra,${r ? `crop=${r.w}:${r.h}:${r.x}:${r.y},` : ''}scale=${width}:${height}:flags=${sws}`
    : `scale=${width}:${height}:flags=${sws}`);
  if (source?.kind !== 'screen') args.push('-r', String(fps));
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return args;
}

/**
 * 逐帧读，**同步回调**。回调里做的事会直接变成对 ffmpeg 的背压 —— 这是刻意的：
 * 判帧、留帧、重排都在回调里跑完，绝不让帧在内存里越堆越多。
 *
 * @returns {{stop:()=>void, done:Promise<{frames:number, ms:number, code:number|null}>}}
 */export function spawnFrames({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  onFrame, onStderr = null, onFirst = null,
} = {}) {
  const args = captureArgs({ source, width, height, fps, ffmpegPath, engine }).slice(1);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const need = width * height * 3;
  // 帧字节管道：chunk 先攒进数组，凑满一帧才**一次性** concat。
  // 旧写法每来一个 ~64KB chunk 就把 pending 整体重拼一次（一帧 1MB 要拼 ~17 次，
  // 实测 ~100MB/s 内存带宽放大）。帧**拷出成独立 buffer**，不留大拼接块上的
  // subarray 视图（视图会把整块 pending 拖住不放）。
  let chunks = [];
  let have = 0;
  let n = 0;
  const t0 = Date.now();
  const t0Mono = performance.now();
  // 直播源帧时钟用单调墙钟（performance.now 差值，防 NTP 校时/休眠跳变）：
  // 背压丢帧时帧序时间 i/fps 会失真，而全部节奏常数（maxWaitSec、silentFloorSec）
  // 都是按真实秒设计的。文件源保留 i/fps —— 离线回归语义不变。
  const live = source?.kind !== 'file';
  let err = '';

  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      have += chunk.length;
      while (have >= need) {
        const exact = have === need;
        const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
        // exact（含单 chunk 正好一帧）时 joined 本身就是独立新 buffer，零拷贝直出
        const buf = exact ? joined : Buffer.from(joined.subarray(0, need));
        const rest = exact ? null : joined.subarray(need);
        chunks = rest ? [rest] : [];
        have = rest ? rest.length : 0;
        const i = n;
        n += 1;
        if (i === 0) onFirst?.(Date.now() - t0);
        onFrame?.({ i, t: live ? (performance.now() - t0Mono) / 1000 : i / fps, buf });
      }
    });
    child.stderr.on('data', (d) => {
      err = `${err}${d}`.slice(-4000);
      onStderr?.(String(d));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (err.trim() && code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-300)}`));
        return;
      }
      resolve({ frames: n, ms: Date.now() - t0, code });
    });
  });

  return {
    done,
    stop() {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    },
  };
}

/* ---------------------------------------------------------------- 引擎探测 */

/**
 * 屏幕源用哪个引擎 —— **测一次、整个进程记住**。
 *
 * 为什么需要探测：`ddagrab` 走桌面复制 API，独占全屏的游戏 / 部分远程桌面会把它挡住
 * （报 "Selected output not supported" 或者干脆不吐帧）。那种情况下不能哑着 ——
 * 退到 `gdigrab` 只是多花 0.17 核，画面照样能看。
 *
 * 代价是进程里第一次开屏幕要多 spawn 一次 ffmpeg（~400ms）。所以结果缓存，
 * 之后每次 start 都是 0 成本；本机这两种引擎的可用性不会在一次会话里变。
 */
let cachedEngine = null;

export function resetScreenEngineCache() {
  cachedEngine = null;
}

export function pickScreenEngine({
  ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500,
} = {}) {
  if (cachedEngine) return Promise.resolve(cachedEngine);
  const W = 64;
  const H = 36;                     // 探针只取 1 帧，尺寸越小越快
  const args = captureArgs({
    source: { kind: 'screen', engine: 'ddagrab' }, width: W, height: H, fps, ffmpegPath, engine: 'ddagrab',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let got = 0;
    const done = (engine) => {
      cachedEngine = engine;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve(engine);
    };
    const timer = setTimeout(() => done('gdigrab'), timeoutMs);
    child.stdout.on('data', (d) => {
      got += d.length;
      if (got >= W * H * 3) { clearTimeout(timer); done('ddagrab'); }
    });
    child.on('error', () => { clearTimeout(timer); done('gdigrab'); });
    child.on('close', () => { clearTimeout(timer); if (!got) done('gdigrab'); });
  });
}

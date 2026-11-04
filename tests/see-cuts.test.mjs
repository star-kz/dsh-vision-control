/**
 * 表征测试：see/cuts.js —— 逐帧画面变化分（HSV 三通道加权绝对差）。
 *
 * 覆盖任务书要求的「变化分边界值」：
 *   - 第一帧 score === null（无前帧可比）；
 *   - 完全相同的两帧 score === 0（下界）；
 *   - 实测量程上界：scorePair 把单像素的 (加权色差+|ΔS|+|ΔV|) 均摊到 3 个通道，
 *     黑↔白 这类极端变化得分是 255/3 = 85，理论最大值 (127.5+255+255)/3 = 212.5
 *     —— 注意这与文件头注释「0–255」不一致，按实测表征（见报告）。
 *   - 色相环形距离（5° 与 250° 相差 10/3 而不是 245/3）；
 *   - 低饱和像素色相降权（白↔蓝 只差饱和度，色相项为 0）；
 *   - 对称性 scorePair(a,b) === scorePair(b,a)；
 *   - createScorer 的 hsv 返回的是复用缓冲（同一引用，注释明示「要用就自己拷走」）。
 *
 * 本文件独立可跑：node --test tests/see-cuts.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_W, SCAN_H, gridRgb, rgbToHsv, scorePair, createScorer,
} from '../see/cuts.js';

const closeTo = (actual, expected, eps = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected}`,
  );
};

/** 造一帧 width×height 的 RGB 缓冲，fill 可以是 [r,g,b] 或 (x,y)=>[r,g,b]。 */
function makeFrame(width, height, fill) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = typeof fill === 'function' ? fill(x, y) : fill;
      const i = (y * width + x) * 3;
      rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
    }
  }
  return rgb;
}

test('gridRgb：纯色帧降采样后每个网格都是该颜色', () => {
  const frame = makeFrame(128, 72, [40, 80, 120]);
  const out = new Float32Array(SCAN_W * SCAN_H * 3);
  gridRgb(frame, 128, 72, out);
  for (let i = 0; i < SCAN_W * SCAN_H; i += 1) {
    closeTo(out[i * 3], 40);
    closeTo(out[i * 3 + 1], 80);
    closeTo(out[i * 3 + 2], 120);
  }
});

test('gridRgb：左右半屏异色帧，网格按列归属左右（64×36 帧采样点对齐网格）', () => {
  // 帧尺寸恰好等于网格尺寸时 sx=sy=1，采样点落在 (gx,gy) 自身，结果逐格可预期。
  const frame = makeFrame(SCAN_W, SCAN_H, (x) => (x < SCAN_W / 2 ? [255, 0, 0] : [0, 0, 255]));
  const out = new Float32Array(SCAN_W * SCAN_H * 3);
  gridRgb(frame, SCAN_W, SCAN_H, out);
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const i = (gy * SCAN_W + gx) * 3;
      if (gx < SCAN_W / 2) {
        closeTo(out[i], 255); closeTo(out[i + 1], 0); closeTo(out[i + 2], 0);
      } else {
        closeTo(out[i], 0); closeTo(out[i + 1], 0); closeTo(out[i + 2], 255);
      }
    }
  }
});

test('rgbToHsv：六个锚点颜色的精确换算', () => {
  const cases = [
    [[255, 0, 0], [0, 255, 255]],        // 红：H=0
    [[0, 255, 0], [85, 255, 255]],       // 绿：H=120° → 120/360*255 = 85
    [[0, 0, 255], [170, 255, 255]],      // 蓝：H=240° → 170
    [[255, 255, 255], [0, 0, 255]],      // 白：S=0
    [[0, 0, 0], [0, 0, 0]],              // 黑：V=0 且 S 强制 0
    [[128, 128, 128], [0, 0, 128]],      // 灰：d=0 → H=0,S=0
  ];
  for (const [rgb, hsv] of cases) {
    const out = new Float32Array(3);
    rgbToHsv(rgb, out);
    closeTo(out[0], hsv[0]);
    closeTo(out[1], hsv[1]);
    closeTo(out[2], hsv[2]);
  }
});

test('scorePair：下界——完全相同的两帧得 0', () => {
  const a = new Float32Array([85, 255, 255]);
  assert.equal(scorePair(a, a), 0);
  assert.equal(scorePair(a, new Float32Array([85, 255, 255])), 0);
});

test('scorePair：极端边界——黑↔白得 85（只动 V 通道，均摊 255/3）', () => {
  const black = new Float32Array([0, 0, 0]);
  const white = new Float32Array([0, 0, 255]);
  closeTo(scorePair(black, white), 85);
});

test('scorePair：红→绿 H 差 85（满饱和，色相项满权重），得分 85/3', () => {
  const red = new Float32Array([0, 255, 255]);
  const green = new Float32Array([85, 255, 255]);
  closeTo(scorePair(red, green), 85 / 3);
});

test('scorePair：色相按环形取短弧——5 与 250 的色差是 10 而不是 245', () => {
  const a = new Float32Array([5, 255, 255]);
  const b = new Float32Array([250, 255, 255]);
  closeTo(scorePair(a, b), 10 / 3);
});

test('scorePair：低饱和像素色相降权——白↔蓝只差 S，色相项为 0', () => {
  const white = new Float32Array([0, 0, 255]);
  const blue = new Float32Array([170, 255, 255]);
  // 若色相不降权会多 85×min(S)/255 的项；这里 min(S)=0，所以只剩 |ΔS|=255 → 85。
  closeTo(scorePair(white, blue), 85);
});

test('scorePair：对称性 scorePair(a,b) === scorePair(b,a)（权重取两侧较小饱和）', () => {
  const a = new Float32Array([10, 100, 200, 30, 40, 50]);
  const b = new Float32Array([200, 30, 90, 60, 250, 5]);
  closeTo(scorePair(a, b), scorePair(b, a));
});

test('scorePair：多像素取均值——一半像素黑变白，得分减半', () => {
  const prev = new Float32Array([0, 0, 0, 0, 0, 0]);   // 两个黑像素
  const cur = new Float32Array([0, 0, 255, 0, 0, 0]);  // 一个变白
  closeTo(scorePair(prev, cur), 255 / 6);
});

test('createScorer：第一帧 score 为 null，同帧重放得 0', () => {
  const score = createScorer({ width: SCAN_W, height: SCAN_H });
  const frame = makeFrame(SCAN_W, SCAN_H, [10, 20, 30]);
  assert.equal(score(frame).score, null);
  assert.equal(score(frame).score, 0);
});

test('createScorer：全黑切全白得 85（与 scorePair 的黑↔白一致）', () => {
  const score = createScorer({ width: SCAN_W, height: SCAN_H });
  score(makeFrame(SCAN_W, SCAN_H, [0, 0, 0]));
  closeTo(score(makeFrame(SCAN_W, SCAN_H, [255, 255, 255])).score, 85);
});

test('createScorer：返回的 hsv 是复用缓冲（同一引用）；内部比较用的是副本，不受复用影响', () => {
  const score = createScorer({ width: SCAN_W, height: SCAN_H });
  const black = makeFrame(SCAN_W, SCAN_H, [0, 0, 0]);
  const white = makeFrame(SCAN_W, SCAN_H, [255, 255, 255]);
  const r1 = score(black);
  const r2 = score(white);
  // 表征：两次返回同一个 Float32Array（调用方要自己拷走，注释已明示）。
  assert.equal(r1.hsv, r2.hsv);
  // 复用缓冲不改变评分：黑→白 之后再 白→白 得 0，再 白→黑 得 85。
  assert.equal(score(white).score, 0);
  closeTo(score(black).score, 85);
});

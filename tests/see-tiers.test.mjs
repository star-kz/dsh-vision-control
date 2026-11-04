/**
 * 表征测试：see/tiers.js —— 密度 → 档位，重点是任务书要求的「档位滞回」。
 *
 * 滞回的精确语义（阈值 1、滞回 0.5 的定制参数下逐帧钉死）：
 *   - 升档要跨过 threshold×(1+h)，降档要跌破 threshold×(1-h)，
 *     中间带（本例 raw=1 ∈ (0.75, 1.5)）双向都**保持原档**；
 *   - 密度窗是 (t-W, t]：恰好落在 t-W 上的边界**不计入**（严格大于）。
 *   - 注意 tick 只数 `bounds[i] > t-W`，**不设上界**：测试里必须先 mark 再 tick
 *     保持因果序，否则窗口会数到"未来"的边界（这也是源码注释要求每帧按序调用的原因）。
 *
 * 另有两组默认参数回归：
 *   - 文档表（tiers.js:23-24）：持续每秒 1 个边界 → 4 档；每秒 4 个 → 8 档；
 *   - applyStrategy 四策略，含 0（FREE 补位档）在各策略下的去向差异。
 *
 * 断言值均为 2026-11-04 对当前代码的实测（Node v24.20.0）。
 * 本文件独立可跑：node --test tests/see-tiers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_THRESHOLDS, HYSTERESIS, TIER_MIN, TIER_MAX,
  STRATEGIES, applyStrategy, createTiers,
} from '../see/tiers.js';

test('常量锚点：7 道阈值（帧/秒）、滞回 0.05、档域 [1,8]', () => {
  assert.deepEqual([...LEVEL_THRESHOLDS], [0.26, 0.6, 0.9, 1.2, 1.8, 2.4, 3.0]);
  assert.equal(HYSTERESIS, 0.05);
  assert.equal(TIER_MIN, 1);
  assert.equal(TIER_MAX, 8);
});

test('初始档位为 1；空跑 tick 不升档', () => {
  const t = createTiers({});
  assert.equal(t.levelAt(), 1);
  assert.equal(t.tick(1.0), 1);
  assert.equal(t.tick(2.0), 1);
  assert.equal(t.density, 0);
});

/**
 * 定制参数让 EMA 一步收敛（smoothFrames=1）、窗宽 1 秒（fps=1, dtFrames=1）、
 * 单阈值 1 帧/秒、滞回 0.5 → 升档线 1.5、降档线 0.75。
 */
const makeHyst = () => createTiers({
  fps: 1, dtFrames: 1, smoothFrames: 1, thresholds: [1], hysteresis: 0.5,
});

test('滞回：升档要跨过 threshold×(1+h)', () => {
  const t = makeHyst();
  assert.equal(t.tick(0), 1);
  // 一个边界：raw=1，低于升档线 1.5 → 保持 1 档
  t.mark(0.1);
  assert.equal(t.tick(0.5), 1);
  // 两个边界：raw=2 > 1.5 → 升 2 档
  t.mark(0.6);
  assert.equal(t.tick(1.0), 2);
});

test('滞回：中间带保持原档（从上方进入不降）', () => {
  const t = makeHyst();
  t.mark(0.1); t.mark(0.2);
  assert.equal(t.tick(0.5), 2);      // raw=2 → 2 档
  // 窗口里只剩一个边界：raw=1，在 (0.75, 1.5) 滞回带里 → 不降
  assert.equal(t.tick(1.15), 2);
  // 窗口清空：raw=0 < 0.75 → 降回 1 档
  assert.equal(t.tick(2.5), 1);
});

test('滞回：中间带保持原档（从下方进入不升，即使 raw 已等于阈值）', () => {
  const t = makeHyst();
  t.mark(1.0);
  assert.equal(t.tick(1.5), 1);      // raw=1 ≥ 阈值 1 但 < 升档线 1.5 → 保持 1
});

test('密度窗边界：恰好 t-W 时刻的边界不计入（严格大于 lo）', () => {
  // hyst=0、阈值 0.5：raw=1 → 2 档，raw=0 → 1 档，两种 raw 落到不同档才有区分度。
  const t = createTiers({
    fps: 1, dtFrames: 1, smoothFrames: 1, thresholds: [0.5], hysteresis: 0,
  });
  t.mark(4.5);
  // W=1：tick(5.5) 的窗口是 (4.5, 5.5]，4.5 被排除 → raw=0 → 1 档
  assert.equal(t.tick(5.5), 1);
  // 窗口内的边界（5.0 ∈ (4.6, 5.6]）则计入 → raw=1 > 0.5 → 2 档
  t.mark(5.0);
  assert.equal(t.tick(5.6), 2);
});

test('无滞回时多档连跳：一次升 3 档、一次降到底', () => {
  const t = createTiers({
    fps: 1, dtFrames: 1, smoothFrames: 1, thresholds: [1, 2, 3], hysteresis: 0,
  });
  t.mark(0.1); t.mark(0.2); t.mark(0.3); t.mark(0.4);
  assert.equal(t.tick(0.5), 4);      // raw=4 → 1+countAtLeast(4,[1,2,3]) = 4
  assert.equal(t.tick(5.5), 1);      // raw=0 → 直接降回 1
});

/**
 * 按因果序交替 mark/tick：mark 时刻落在第 i 秒内的边界，先于该秒最后一个 tick 打上。
 * （先打全部 mark 再 tick 会让早期窗口数到未来的边界 —— tick 不检查上界。）
 */
function runFeed(tiers, { seconds, marksPerSecond }) {
  const markTimes = [];
  for (let k = 0; k < 6; k += 1) {
    for (let m = 0; m < marksPerSecond; m += 1) {
      markTimes.push(k + (m + 0.5) / marksPerSecond);
    }
  }
  let mi = 0;
  for (let i = 1; i <= secondsTicks(6); i += 1) {
    const t = i / 12;
    while (mi < markTimes.length && markTimes[mi] <= t) { tiers.mark(markTimes[mi]); mi += 1; }
    tiers.tick(t);
  }
}
const secondsTicks = (s) => s * 12;

test('默认参数回归：持续每秒 1 个边界 → 4 档（文档表 F=1 → k=4）', () => {
  const t = createTiers({ fps: 12, dtFrames: 12, smoothFrames: 6 });
  runFeed(t, { seconds: 6, marksPerSecond: 1 });
  assert.equal(t.levelAt(), 4);
});

test('默认参数回归：持续每秒 4 个边界 → 8 档（文档表 F=4 → k=8）', () => {
  const t = createTiers({ fps: 12, dtFrames: 12, smoothFrames: 6 });
  runFeed(t, { seconds: 6, marksPerSecond: 4 });
  assert.equal(t.levelAt(), 8);
});

test('applyStrategy：native 恒等 bump 但 0 被钳成 1；full 降档；compact 升档封顶 8；single 全 1 但保 0', () => {
  // native：bump=0，但最后 clamp 到 [TIER_MIN,TIER_MAX] 会把 FREE 档 0 抬成 1（实测）。
  assert.deepEqual(applyStrategy([0, 1, 5, 8], 'native'), [1, 1, 5, 8]);
  // full：bump=-1, floor=1 —— 0 同样被抬成 1
  assert.deepEqual(applyStrategy([0, 1, 2, 5, 8], 'full'), [1, 1, 1, 4, 7]);
  // compact：bump=+1，8 封顶；0 → 1
  assert.deepEqual(applyStrategy([0, 1, 8], 'compact'), [1, 2, 8]);
  // single：fixed=1 走提前返回分支，唯独它保留 0（注释 tiers.js:56 明示）
  assert.deepEqual(applyStrategy([0, 3, 8], 'single'), [0, 1, 1]);
  // 未知名 → 回落 native（0 同样被钳成 1）
  assert.deepEqual(applyStrategy([0, 3], 'nope'), [1, 3]);
  assert.equal(Object.keys(STRATEGIES).sort().join(','), 'compact,full,native,single');
});

test('tick 返回档与 levelAt 一致；mark 后 density 变正', () => {
  const t = createTiers({});
  t.mark(0.5);
  const lv = t.tick(0.5);
  assert.equal(lv, t.levelAt());
  assert.ok(t.density > 0);
});

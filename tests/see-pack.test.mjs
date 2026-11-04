/**
 * 表征测试：see/pack.js —— 分镜排布，重点钉死任务书要求的
 * 「splitOneBin 单箱不变量：任何输入输出不超过 1 bin」。
 *
 * 为什么是表征（characterization）而不是按注释写期望：
 *   本文件的断言值全部来自 2026-11-04 对当前代码的**实测**（Node v24.20.0），
 *   其中两处与源码注释的叙事不一致，按实测钉住并在此标注：
 *
 *   1. pack.js:143-144 注释说 binCost=1.02 让 `[1,1]` 排成「一张里并排两个 1/2」；
 *      实测默认参数下 `solve([1,1]).bins === 2`（两箱各占 100% 面积得分更高），
 *      binCost ≥ 1.5 时才是 1 箱。`solve([1,1,1]).bins === 3` 同理。
 *   2. splitOneBin 的注释块（pack.js:284-294）叙述「4 个 1 档帧装得进一张」——
 *      `solve([1,1,1,1]).bins === 1` 确实成立，但 `splitOneBin([1,1,1,1,1])`
 *      实测切成 5 个单帧段（因为 [1,1] 已经 2 箱），不是直觉的 [[1,1,1,1],[1]]。
 *      不变量（每段单箱）依然成立，只是分段比注释暗示的更碎。
 *
 * 本文件独立可跑：node --test tests/see-pack.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT, FREE, DEFAULT_GROW, bounds, solve, splitOneBin, bestPlan, toRects,
} from '../see/pack.js';

test('bounds：各档位边长区间（UNIT=840 单位）实测锚点', () => {
  assert.equal(UNIT, 840);
  assert.deepEqual(bounds(FREE), [35, 420]);            // [UNIT/24, UNIT/2]
  assert.deepEqual(bounds(1), [420, 840]);              // [UNIT/2, UNIT]
  assert.deepEqual(bounds(2), [280, 420]);              // [UNIT/3, UNIT/2]
  assert.deepEqual(bounds(3), [210, 420]);              // 默认 grow 含 3 → 上限 UNIT/2
  assert.equal(bounds(8)[1], 120);                      // UNIT/7
  assert.ok(Math.abs(bounds(8)[0] - 840 / 9) < 1e-9);   // UNIT/9
  // grow 把 3 移出后上限回落到 UNIT/3
  assert.deepEqual(bounds(3, []), [210, 280]);
  assert.ok(DEFAULT_GROW.includes(3) && !DEFAULT_GROW.includes(1) && !DEFAULT_GROW.includes(2));
});

test('solve：空序列 → 0 箱空 cells', () => {
  assert.deepEqual(solve([]), { bins: 0, fill: 0, cells: [], area: 0 });
});

test('solve：1 档连帧的箱数实测锚点（含与注释不符处，见文件头）', () => {
  assert.equal(solve([1]).bins, 1);
  assert.equal(solve([1, 1]).bins, 2);          // 注释叙事说应为 1，实测为 2
  assert.equal(solve([1, 1, 1]).bins, 3);
  assert.equal(solve([1, 1, 1, 1]).bins, 1);    // 「4 个 1 档装得进一张」属实
  assert.equal(solve([1, 1, 1, 1, 1]).bins, 2); // 5 个装不下 属实
  assert.equal(solve([1, 1, 1, 1, 1, 1]).bins, 3);
  // binCost 加大到 1.5 才出现注释里的「并排放一箱」
  assert.equal(solve([1, 1], { binCost: 1.5 }).bins, 1);
});

test('solve：cells 几何不变量——数量、时序、画布内、面积为正', () => {
  const tiers = [3, 2, 5, 1, 0, 8, 8, 2];
  const r = solve(tiers);
  assert.equal(r.cells.length, tiers.length);
  r.cells.forEach((c, i) => {
    assert.equal(c.seq, i);                 // 时序一格不动：格子 i 放第 i 帧
    assert.equal(c.t, tiers[i]);
    assert.ok(c.x >= 0 && c.x + c.w <= 1 + 1e-9, `cell ${i} x+w 出界`);
    assert.ok(c.y >= 0 && c.y + c.h <= 1 + 1e-9, `cell ${i} y+h 出界`);
    assert.ok(c.w > 0 && c.h > 0);
  });
  assert.equal(r.bins, Math.max(...r.cells.map((c) => c.bin)) + 1);
  assert.ok(r.fill > 0 && r.fill <= 1);
});

test('splitOneBin：空输入 → 空；单帧 → 一段', () => {
  assert.deepEqual(splitOneBin([]), []);
  assert.deepEqual(splitOneBin([1]), [[1]]);
  assert.deepEqual(splitOneBin([8]), [[8]]);
});

test('splitOneBin：实测锚点分段（1 档在默认参数下两两装不下，见文件头）', () => {
  assert.deepEqual(splitOneBin([1, 1, 1, 1, 1]), [[1], [1], [1], [1], [1]]);
  assert.deepEqual(
    splitOneBin([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]),
    [[1], [1], [1], [1], [1, 2, 2, 2], [2, 2]],
  );
});

/** 确定性伪随机（LCG），让性质测试可复现。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('splitOneBin 单箱不变量：80 条伪随机序列，每段 solve 后 bins===1、保序、不丢帧', () => {
  const rand = lcg(20261104);
  // 偏向小档位（1/2 最占地方，最能压出多箱边界），偶尔掺 FREE(0) 补位帧。
  const pool = [1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 7, 8, 0];
  for (let caseNo = 0; caseNo < 80; caseNo += 1) {
    const n = 1 + Math.floor(rand() * 20);
    const tiers = Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]);
    const segs = splitOneBin(tiers);
    assert.ok(segs.length >= 1, `case ${caseNo}: 非空输入至少一段`);
    assert.deepEqual(segs.flat(), tiers, `case ${caseNo}: 保序且不丢帧`);
    segs.forEach((seg, segNo) => {
      assert.ok(seg.length >= 1, `case ${caseNo} seg ${segNo}: 不允许空段`);
      assert.equal(
        solve(seg).bins, 1,
        `case ${caseNo} seg ${segNo}: 段 [${seg}] 必须单箱装下`,
      );
    });
  }
});

test('splitOneBin 单箱不变量：定向序列（全同档 1..8、1/8 交替、掺 FREE）', () => {
  const directed = [
    ...Array.from({ length: 8 }, (_, k) => new Array(12).fill(k + 1)),
    Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 1 : 8)),
    [0, 1, 0, 1, 0, 1, 0],
    [1, 2, 3, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 3, 2, 1],
  ];
  for (const tiers of directed) {
    for (const seg of splitOneBin(tiers)) {
      assert.equal(solve(seg).bins, 1, `段 [${seg}] 必须单箱装下（源 [${tiers}]）`);
    }
  }
});

test('bestPlan(4)：实测挑中 all-1/2，fill=1，一箱', () => {
  const plan = bestPlan(4);
  assert.equal(plan.tag, 'all-1/2');
  assert.equal(plan.bins, 1);
  assert.ok(Math.abs(plan.fill - 1) < 1e-9);
});

test('toRects：2×2 均分画布、全局连续编号、gutter 只外扩不重叠', () => {
  const { cells } = solve([2, 2, 2, 2]);
  const rects = toRects(cells, { width: 840, height: 840 });
  assert.equal(rects.length, 4);
  assert.deepEqual(
    rects.map((r) => [r.px, r.py, r.pw, r.ph]),
    [[0, 0, 420, 420], [420, 0, 420, 420], [0, 420, 420, 420], [420, 420, 420, 420]],
  );
  assert.deepEqual(rects.map((r) => r.index), [1, 2, 3, 4]); // 全局 1-based 编号
  const withGutter = toRects(cells, { width: 840, height: 840, gutter: 2 });
  assert.deepEqual([withGutter[0].px, withGutter[0].py], [2, 2]);
});

test('toRects：bin 过滤只取指定张，编号仍然全局连续', () => {
  const { cells, bins } = solve([1, 1, 1]);
  assert.equal(bins, 3);
  const one = toRects(cells, { width: 840, height: 840, bin: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].bin, 1);
  assert.equal(one[0].index, 2); // 第 2 张图接着全局序号
});

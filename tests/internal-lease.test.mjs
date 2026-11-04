/**
 * 表征测试：internal/lease.mjs —— 控制权租约生命周期。
 *
 * lease.mjs 用模块级单例存「谁在动桌面」（重构-5 工厂化的对象）。本文件两种对策：
 *   1. 每个用例经 `import('../internal/lease.mjs?fresh=…')` 拿**全新模块实例**，互不染指；
 *   2. 空闲过期用 node:test 的 mock timers 拨 Date，不真等 10 秒。
 *
 * 钉住的契约：
 *   - 只有动桌面的命令需要租约；读操作与任意会话无关；
 *   - 同会话重取幂等；异会话被拒且 [CONTROLLER_BUSY] 说清「正在执行」vs「安静了 N 秒」；
 *   - 写执行期（beginWrite/finishWrite 计数 >0）永久挡住别的会话，哪怕空闲钟早已超时；
 *   - 空闲钟在 finishWrite 那一刻重拨，CONTROLLER_IDLE_MS(=10000) 到期自动让位；
 *   - 边界：空闲恰好 10000ms 时让位（条件是 `< CONTROLLER_IDLE_MS` 才拒）。
 *
 * 断言值均为 2026-11-04 对当前代码的实测（Node v24.20.0）。
 * 本文件独立可跑：node --test tests/internal-lease.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fresh = (tag) => import(`../internal/lease.mjs?fresh=${tag}`);
const BASE = 1_700_000_000_000; // 一个固定的虚拟现在

test('movesDesktop：只有动桌面的调用需要租约', async () => {
  const { movesDesktop } = await fresh('moves');
  // 写命令
  for (const cmd of ['click', 'drag', 'scroll', 'type', 'key', 'paste', 'launch', 'focus']) {
    assert.equal(movesDesktop(cmd, {}), true, cmd);
  }
  // 读命令
  assert.equal(movesDesktop('screenshot', {}), false);
  assert.equal(movesDesktop('ping'), false);
  assert.equal(movesDesktop('frameproject', {}), false);
  assert.equal(movesDesktop('frob'), false); // 未知命令按不動桌面处理（表征）
  // clipboard 按 op
  assert.equal(movesDesktop('clipboard', { op: 'get' }), false);
  assert.equal(movesDesktop('clipboard', {}), false); // 缺省即 get
  assert.equal(movesDesktop('clipboard', { op: 'set' }), true);
  // uiact 按 action
  assert.equal(movesDesktop('uiact', { action: 'get_text' }), false);
  assert.equal(movesDesktop('uiact', { action: 'GET_TEXT' }), false); // 大小写不敏感
  assert.equal(movesDesktop('uiact', { action: 'invoke' }), true);
  // batch：全只读 → false；掺一个写步骤 → true
  assert.equal(movesDesktop('batch', { steps: [{ action: 'wait' }, { action: 'screenshot' }] }), false);
  assert.equal(movesDesktop('batch', { steps: [{ action: 'wait' }, { action: 'key' }] }), true);
  assert.equal(movesDesktop('batch', { steps: [{ action: 'clipboard', op: 'get' }] }), false);
  assert.equal(movesDesktop('batch', { steps: [{ action: 'clipboard', op: 'set' }] }), true);
  // 表征：steps 缺失 → some([]) → false
  assert.equal(movesDesktop('batch', {}), false);
});

test('生命周期：同会话幂等、异会话拒绝、读操作永不挡', async () => {
  const lease = await fresh('lifecycle');
  const A = 'session-alpha-0001';
  const B = 'session-bravo-0002';
  // A 取租约（写命令）
  lease.claimController(A, 'click', { x: 1, y: 2 });
  assert.equal(lease.leaseReport(A).owns, true);
  assert.equal(lease.leaseReport(A).held, true);
  assert.equal(lease.leaseReport(B).owns, false);
  // 同会话重取不炸
  lease.claimController(A, 'type', { text: 'hi' });
  // 异会话写命令被拒：[CONTROLLER_BUSY] + 「安静了 N 秒」变体
  assert.throws(
    () => lease.claimController(B, 'click', {}),
    /\[CONTROLLER_BUSY\].*drove the desktop \d+s ago/s,
  );
  // 读操作永不挡：B 随时可以截屏
  lease.claimController(B, 'screenshot', {});
  // 租约仍归 A（B 的读不改变归属）
  assert.equal(lease.leaseReport(A).owns, true);
});

test('拒绝文案：写执行期说「正在执行」，结束后回到「安静了 N 秒」', async () => {
  const lease = await fresh('wording');
  const A = 'session-alpha-0001';
  const B = 'session-bravo-0002';
  lease.claimController(A, 'click', {});
  lease.beginWrite();
  assert.throws(
    () => lease.claimController(B, 'click', {}),
    /is in the middle of a write right now \(the desktop is being driven this instant\)/,
  );
  lease.finishWrite();
  assert.throws(
    () => lease.claimController(B, 'click', {}),
    /drove the desktop \d+s ago/,
  );
});

test('空闲过期：CONTROLLER_IDLE_MS=10000，恰好到期那一瞬让位（mock Date）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const lease = await fresh('expiry');
  const A = 'session-alpha-0001';
  const B = 'session-bravo-0002';
  assert.equal(lease.CONTROLLER_IDLE_MS, 10_000);
  lease.claimController(A, 'click', {});
  t.mock.timers.tick(9_999);
  assert.throws(() => lease.claimController(B, 'click', {}), /\[CONTROLLER_BUSY\]/);
  assert.equal(lease.leaseReport(B).lease.held, true);
  // 边界：now - at === 10000 时 `< 10000` 为假 → 让位
  t.mock.timers.tick(1);
  lease.claimController(B, 'click', {});
  assert.equal(lease.leaseReport(B).owns, true);
  assert.equal(lease.leaseReport(A).owns, false);
});

test('写执行期永久挡住别的会话，哪怕空闲钟早已超时；finishWrite 重拨空闲钟', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const lease = await fresh('writehold');
  const A = 'session-alpha-0001';
  const B = 'session-bravo-0002';
  lease.claimController(A, 'drag', {});
  lease.beginWrite();
  t.mock.timers.tick(60_000); // 空闲钟停在 beginWrite 之前的那一刻
  assert.throws(
    () => lease.claimController(B, 'click', {}),
    /is in the middle of a write right now/,
  );
  // finishWrite 重拨空闲钟 → 从此刻重新计 10s
  lease.finishWrite();
  assert.throws(() => lease.claimController(B, 'click', {}), /drove the desktop 0s ago/);
  t.mock.timers.tick(10_000);
  lease.claimController(B, 'click', {});
  assert.equal(lease.leaseReport(B).owns, true);
});

test('匿名会话：owner 显示为 (an unidentified session)，leaseReport 的 owner 为 null', async () => {
  const lease = await fresh('anon');
  lease.claimController('', 'click', {});
  assert.throws(
    () => lease.claimController('session-bravo-0002', 'click', {}),
    /\(an unidentified session\)/,
  );
  const report = lease.leaseReport('');
  assert.equal(report.owns, true);
  assert.equal(report.lease.owner, null);
  // 具名会话的 owner 是末 8 位
  const named = await fresh('named');
  named.claimController('session-alpha-0001', 'click', {});
  assert.equal(named.leaseReport('someone-else').lease.owner, '…pha-0001');
});

test('leaseReport：无人持有时 lease 为 null；lastAction 只报给本人', async () => {
  const lease = await fresh('report');
  const A = 'session-alpha-0001';
  const B = 'session-bravo-0002';
  const empty = lease.leaseReport(A);
  assert.deepEqual({ owns: empty.owns, idleMs: empty.idleMs, held: empty.held, lease: empty.lease, lastAction: empty.lastAction }, {
    owns: false, idleMs: null, held: false, lease: null, lastAction: null,
  });
  lease.noteAction(A, 'click (1,2)');
  const ra = lease.leaseReport(A);
  assert.equal(ra.lastAction.what, 'click (1,2)');
  assert.ok(ra.lastAction.ageMs >= 0);
  assert.equal(lease.leaseReport(B).lastAction, null);
});

test('finishWrite 计数有下限：多调不变成负数也不炸', async () => {
  const lease = await fresh('floor');
  lease.finishWrite();
  lease.finishWrite();
  lease.claimController('session-alpha-0001', 'click', {});
  assert.equal(lease.leaseReport('session-alpha-0001').owns, true);
});

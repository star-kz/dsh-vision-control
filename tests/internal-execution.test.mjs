/**
 * 表征测试：internal/execution.mjs —— combineSignals / describeCall / createExecutionRegistry。
 *
 * 钉住的契约：
 *   - combineSignals：无信号 → undefined；单信号 → 原引用；多信号任一中止即中止、原因透传；
 *     已在列表里就带着 aborted 的信号 → 合并信号立即中止（AbortSignal.any 语义）。
 *   - track/count：按归一化会话键记账，注销函数幂等，count('') 是全机会计而不是匿名会话计数。
 *   - abort：只中止目标会话，返回中止数，reason 包成 Error。
 *   - stopping 三件套：beginStop/isStopping/endStop。
 *   - runSessionCall：在飞期间计入 count、结束（含抛错）必注销；exec.signal 与兜底截止时间
 *     合并成 body 收到的 signal；deadline = 调用时刻 + budgetMs。
 *
 * 断言值均为 2026-11-04 对当前代码的实测（Node v24.20.0，含 AbortSignal.any）。
 * 本文件独立可跑：node --test tests/internal-execution.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineSignals, describeCall, createExecutionRegistry,
} from '../internal/execution.mjs';

test('combineSignals：零个/全是空 → undefined；单个 → 原引用', () => {
  assert.equal(combineSignals(), undefined);
  assert.equal(combineSignals(null, undefined), undefined);
  const ac = new AbortController();
  assert.equal(combineSignals(ac.signal), ac.signal);
  assert.equal(combineSignals(undefined, ac.signal, null), ac.signal);
});

test('combineSignals：任一中止即中止，原因透传', () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineSignals(a.signal, b.signal);
  assert.equal(combined.aborted, false);
  const reason = new Error('user stop');
  b.abort(reason);
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, reason);
});

test('combineSignals：入列时已中止的信号让合并信号立即中止', () => {
  const a = new AbortController();
  a.abort(new Error('already'));
  const b = new AbortController();
  const combined = combineSignals(a.signal, b.signal);
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason.message, 'already');
});

test('describeCall：各命令的一句话描述', () => {
  assert.equal(describeCall('batch', { steps: [{}, {}, {}] }), '3 step(s)');
  assert.equal(describeCall('batch', {}), '0 step(s)');
  assert.equal(describeCall('click', { x: 10, y: 20 }), 'click (10,20)');
  assert.equal(describeCall('drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }), 'drag (1,2)->(3,4)');
  assert.equal(describeCall('type', { text: 'hello' }), 'type 5 char(s)');
  assert.equal(describeCall('paste', { text: '你好' }), 'paste 2 char(s)');
  assert.equal(describeCall('key', { keys: 'ctrl+c' }), 'key ctrl+c');
  assert.equal(describeCall('scroll', { direction: 'down' }), 'scroll down');
  assert.equal(describeCall('focus', { hwnd: 1234 }), 'focus hwnd=1234');
  assert.equal(describeCall('launch', { target: 'notepad' }), 'launch notepad');
  assert.equal(describeCall('uiact', { action: 'invoke' }), 'uiact invoke');
  assert.equal(describeCall('clipboard', { op: 'set' }), 'clipboard set');
  assert.equal(describeCall('clipboard', {}), 'clipboard get');
  assert.equal(describeCall('frob', {}), 'frob');
});

test('track/count：登记-注销生命周期；count(空) 是全机合计', () => {
  const reg = createExecutionRegistry();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const un1 = reg.track('s1', c1);
  assert.equal(reg.count('s1'), 1);
  const un2 = reg.track('s1', c2);
  assert.equal(reg.count('s1'), 2);
  assert.equal(reg.count('s2'), 0);
  // 匿名键 '' 返回所有会话合计（注释 execution.mjs:87）
  assert.equal(reg.count(''), 2);
  reg.track('s2', new AbortController());
  assert.equal(reg.count(''), 3);
  un1();
  assert.equal(reg.count('s1'), 1);
  un2();
  assert.equal(reg.count('s1'), 0);
  assert.equal(reg.count(''), 1);
});

test('track 的会话键归一化：123 与 "123" 同键；null 落匿名桶', () => {
  const reg = createExecutionRegistry();
  reg.track(123, new AbortController());
  assert.equal(reg.count('123'), 1);
  reg.track(null, new AbortController());
  // null → 匿名 ''；而 count('') 又是全机合计 → 2
  assert.equal(reg.count(''), 2);
  assert.equal(reg.count(null), 2);
});

test('abort：只中止目标会话，返回中止数，reason 是 Error', () => {
  const reg = createExecutionRegistry();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const c3 = new AbortController();
  reg.track('s1', c1);
  reg.track('s1', c2);
  reg.track('s2', c3);
  const n = reg.abort('s1', 'stop now');
  assert.equal(n, 2);
  assert.equal(c1.signal.aborted, true);
  assert.equal(c1.signal.reason instanceof Error, true);
  assert.equal(c1.signal.reason.message, 'stop now');
  assert.equal(c3.signal.aborted, false);
  assert.equal(reg.abort('nobody', 'x'), 0);
});

test('stopping 三件套', () => {
  const reg = createExecutionRegistry();
  assert.equal(reg.isStopping('s1'), false);
  reg.beginStop('s1');
  assert.equal(reg.isStopping('s1'), true);
  assert.equal(reg.isStopping('s2'), false);
  reg.endStop('s1');
  assert.equal(reg.isStopping('s1'), false);
});

test('runSessionCall：body 拿到 signal/deadline；在飞期间计入 count；结束注销', async () => {
  const reg = createExecutionRegistry();
  const exec = { agent: { session: { id: 's1' } } };
  let during;
  const result = await reg.runSessionCall(exec, { timeoutMs: 5000, label: 'probe' }, async ({ signal, deadline }) => {
    during = reg.count('s1');
    assert.equal(signal.aborted, false);
    assert.ok(deadline - Date.now() <= 5000 && deadline > Date.now());
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(during, 1);
  assert.equal(reg.count('s1'), 0); // finally 注销
});

test('runSessionCall：默认预算 60000ms、默认 label；body 抛错也注销', async () => {
  const reg = createExecutionRegistry();
  await assert.rejects(
    reg.runSessionCall({}, {}, async ({ deadline }) => {
      assert.ok(deadline - Date.now() > 59_000 && deadline - Date.now() <= 60_000);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(reg.count(''), 0);
});

test('runSessionCall：exec.signal 中止会传播给 body 的信号', async () => {
  const reg = createExecutionRegistry();
  const execAc = new AbortController();
  const exec = { signal: execAc.signal, agent: { session: { id: 's1' } } };
  const pending = reg.runSessionCall(exec, { timeoutMs: 60_000 }, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  execAc.abort(new Error('user stop'));
  await assert.rejects(pending, /user stop/);
  assert.equal(reg.count('s1'), 0);
});

test('runSessionCall：兜底截止时间到点中止 body（超时文案带 label 与预算）', async () => {
  const reg = createExecutionRegistry();
  await assert.rejects(
    reg.runSessionCall(
      { agent: { session: { id: 's1' } } },
      { timeoutMs: 20, label: 'the probe call' },
      ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ),
    /the probe call exceeded its 20 ms deadline/,
  );
  assert.equal(reg.count('s1'), 0);
});

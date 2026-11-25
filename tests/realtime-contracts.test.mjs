/**
 * realtime/contracts.mjs 契约测试（Task 5 · RED 先行）。
 *
 * 钉住的是控制面协议的**公开形状**：版本号、工具名清单（一次定型）、hello/response
 * 包络校验、run/replay 请求校验、active 授权规则、stop 记录的诚实初值、旧 runId /
 * 旧 sourceEpoch 判定。这些是 worker-client 与 controller 共同依赖的纯数据层，
 * 先把契约钉死，传输层和控制面才有可对表的基准（对照 docs/worker-protocol.md 的
 * 三层校验思想第 1 层）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RT_PROTOCOL_VERSION,
  RT_TOOL_NAMES,
  RT_MAX_CONTROL_LINE_BYTES,
  RUN_MODES,
  RUN_STATES,
  RT_ERROR_CODES,
  validateHello,
  validateResponseEnvelope,
  validateRunSpec,
  validateActiveAuthorization,
  validateReplaySpec,
  makeStopRecord,
  makeRunRecord,
  isStaleRunResult,
  isStaleEpoch,
  isStaleEventSeq,
  defaultVerifyHilTarget,
  HIL_TARGET_KIND,
} from '../realtime/contracts.mjs';

test('RT_TOOL_NAMES 公开契约一次定型：九个工具名，含首迭代的 snapshot', () => {
  assert.deepEqual(RT_TOOL_NAMES, [
    'realtime_targets',
    'realtime_skill_validate',
    'realtime_calibrate',
    'realtime_run',
    'realtime_status',
    'realtime_stop',
    'realtime_snapshot',
    'realtime_replay',
    'realtime_trace_read',
  ]);
  assert.ok(Object.isFrozen(RT_TOOL_NAMES), '工具名清单必须冻结，防运行期扩充');
});

test('RT_PROTOCOL_VERSION 为整数，控制面行上限远小于 1MB（数据面不得经过 Node）', () => {
  assert.equal(Number.isInteger(RT_PROTOCOL_VERSION), true);
  assert.equal(RT_PROTOCOL_VERSION, 1);
  assert.equal(typeof RT_MAX_CONTROL_LINE_BYTES, 'number');
  assert.ok(RT_MAX_CONTROL_LINE_BYTES < 1024 * 1024, '控制面是 JSON 行，不是帧通道');
});

test('validateHello：接受合法 hello，拒绝非 hello 包络与非整数协议号', () => {
  const ok = validateHello({
    rt: 'hello',
    protocol: 1,
    worker: { name: 'Rt.Worker', version: '0.1.0' },
    pid: 42,
    capabilities: ['run', 'heartbeat'],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.capabilities, ['run', 'heartbeat']);

  assert.equal(validateHello({ rt: 'res', protocol: 1 }).ok, false);
  assert.equal(validateHello({ rt: 'hello', protocol: 'one' }).ok, false);
  assert.equal(validateHello({ rt: 'hello' }).ok, false);
});

test('validateResponseEnvelope：ok/error 两种形态都认，缺 id 或 rt 不符都拒', () => {
  const good = validateResponseEnvelope({ rt: 'res', id: 'r-1', ok: true, result: { x: 1 } });
  assert.equal(good.ok, true);

  const bad = validateResponseEnvelope({ rt: 'res', id: 'r-2', ok: false, error: { code: 'BAD_REQUEST', message: 'nope' } });
  assert.equal(bad.ok, true);

  assert.equal(validateResponseEnvelope({ rt: 'event', id: 'r-3', ok: true }).ok, false);
  assert.equal(validateResponseEnvelope({ rt: 'res', ok: true, result: {} }).ok, false);
});

test('validateRunSpec：shadow 为默认；skill/target/deadlineMs 非法一律 BAD_REQUEST', () => {
  const base = { skill: 'rhythm-basic', target: { id: 'win-1', kind: 'window' } };
  const v = validateRunSpec(base);
  assert.equal(v.ok, true);
  assert.equal(v.mode, 'shadow', '不写 mode 就是 shadow，默认安全');

  assert.equal(validateRunSpec({ ...base, mode: 'turbo' }).code, 'BAD_REQUEST');
  assert.equal(validateRunSpec({ target: base.target }).code, 'BAD_REQUEST');
  assert.equal(validateRunSpec({ skill: 's' }).code, 'BAD_REQUEST');
  assert.equal(validateRunSpec({ ...base, target: { kind: 'window' } }).code, 'BAD_REQUEST');
  assert.equal(validateRunSpec({ ...base, deadlineMs: 0 }).code, 'BAD_REQUEST');
  assert.equal(validateRunSpec({ ...base, deadlineMs: -5 }).code, 'BAD_REQUEST');
  assert.equal(validateRunSpec(null).code, 'BAD_REQUEST');
});

test('validateRunSpec：完整克隆并冻结 authorization，调用方后续突变不能改变派发描述', () => {
  const authorization = { targetId: 'hil-1', granted: true, permit: { id: 'permit-1', scopes: ['shadow'] } };
  const v = validateRunSpec({
    skill: 'rhythm-basic', target: { id: 'hil-1', kind: 'hil' }, authorization,
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.authorization, authorization);
  assert.notEqual(v.authorization, authorization);
  assert.notEqual(v.authorization.permit, authorization.permit);
  assert.equal(Object.isFrozen(v.authorization), true);
  assert.equal(Object.isFrozen(v.authorization.permit), true);
  authorization.permit.id = 'mutated-after-validation';
  assert.equal(v.authorization.permit.id, 'permit-1');
});

test('validateActiveAuthorization：无授权 / granted 非 true / targetId 不匹配都拒', () => {
  const target = { id: 'hil-1', kind: HIL_TARGET_KIND };
  assert.equal(validateActiveAuthorization({ mode: 'active', skill: 's', target }).code, 'NOT_AUTHORIZED');
  assert.equal(
    validateActiveAuthorization({ mode: 'active', skill: 's', target, authorization: { targetId: 'hil-1', granted: false } }).code,
    'NOT_AUTHORIZED',
  );
  const mismatch = validateActiveAuthorization({
    mode: 'active', skill: 's', target,
    authorization: { targetId: 'hil-other', granted: true },
  });
  assert.equal(mismatch.code, 'NOT_AUTHORIZED');
  assert.match(mismatch.message, /does not transfer|names target/i);

  assert.equal(
    validateActiveAuthorization({ mode: 'active', skill: 's', target, authorization: { targetId: 'hil-1', granted: true, expiresQpc: 1 } }).ok,
    true,
  );
});

test('validateReplaySpec：tracePath 必填；mode=active 拒绝（回放永不注入真实输入）', () => {
  assert.equal(validateReplaySpec({ tracePath: 'D:/t/trace.bin' }).ok, true);
  assert.equal(validateReplaySpec({}).code, 'BAD_REQUEST');
  const active = validateReplaySpec({ tracePath: 'D:/t/trace.bin', mode: 'active' });
  assert.equal(active.code, 'BAD_REQUEST');
  assert.match(active.message, /never injects|offline/i);
});

test('makeStopRecord 初值：一切未确认字段为 false/null，不允许凭空声称已停止或已释放', () => {
  const rec = makeStopRecord('run-x', 1000);
  assert.equal(rec.runId, 'run-x');
  assert.equal(rec.requestedAtMs, 1000);
  assert.equal(rec.estopSent, false);
  assert.equal(rec.estopAcked, false);
  assert.equal(rec.leaseRevoked, false);
  assert.equal(rec.releaseConfirmed, false);
  assert.equal(rec.released, false);
  assert.equal(rec.releaseError, null);
  assert.equal(rec.state, null);
  assert.equal(rec.duplicate, false);
});

test('makeRunRecord：active 才持有 lease；deadline 元数据按 run 独立记录', () => {
  const shadow = makeRunRecord({ runId: 'r1', mode: 'shadow', skill: 's', target: { id: 't', kind: 'window' }, sessionId: 'sess-1', deadlineMs: 5000, now: () => 123 });
  assert.equal(shadow.lease.held, false, 'shadow 永不持写租约');
  assert.equal(shadow.lease.acquiredAtMs, 123);
  assert.deepEqual(shadow.deadline, { deadlineMs: 5000, setAtMs: 123 });
  assert.equal(shadow.state, 'starting');
  assert.equal(shadow.eventSeqMax, null, '每个 run 独立从空 eventSeq 水位开始');

  const active = makeRunRecord({ runId: 'r2', mode: 'active', skill: 's', target: { id: 't', kind: 'window' }, sessionId: 'sess-2', now: () => 200 });
  assert.equal(active.lease.held, true);
  assert.equal(active.deadline, null, '不写 deadline 就没有 deadline 元数据，不虚构默认值');
});

test('isStaleRunResult：runId 缺席不算 stale（非 run 作用域结果）；不匹配才拒绝', () => {
  assert.equal(isStaleRunResult('run-a', { runId: 'run-a' }), false);
  assert.equal(isStaleRunResult('run-a', { framePath: 'x' }), false);
  assert.equal(isStaleRunResult('run-a', null), false);
  assert.equal(isStaleRunResult('run-a', { runId: 'run-b' }), true);
});

test('isStaleEpoch：只允许 epoch 回退为 stale；同 epoch 的递增事件必须可接受', () => {
  assert.equal(isStaleEpoch(5, 3), true);
  assert.equal(isStaleEpoch(5, 5), false, '同一 native epoch 可产生多条不同 eventSeq 的事件');
  assert.equal(isStaleEpoch(5, 6), false);
  assert.equal(isStaleEpoch(null, 6), false);
  assert.equal(isStaleEpoch(5, null), true, '缺 epoch 的 run 事件也 fail-closed');
  for (const malformed of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '6', null, undefined]) {
    assert.equal(isStaleEpoch(null, malformed), true, '畸形 epoch ' + String(malformed) + ' 必须拒收');
  }
  assert.equal(isStaleEpoch(null, 0), false, '0 是合法初始 epoch');
  assert.equal(isStaleEpoch(null, Number.MAX_SAFE_INTEGER), false);
  assert.equal(isStaleEpoch('5', 6), true, '已存最大值损坏时同样 fail-closed');
});

test('isStaleEventSeq：每 run 严格递增；重复、回退、缺失与畸形序号全部拒收', () => {
  assert.equal(isStaleEventSeq(null, 0), false);
  assert.equal(isStaleEventSeq(null, 1), false);
  assert.equal(isStaleEventSeq(1, 2), false);
  assert.equal(isStaleEventSeq(2, 2), true, '重复 eventSeq 是重放，不是新事件');
  assert.equal(isStaleEventSeq(2, 1), true);
  assert.equal(isStaleEventSeq(2, null), true);
  for (const malformed of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', undefined]) {
    assert.equal(isStaleEventSeq(null, malformed), true);
  }
  assert.equal(isStaleEventSeq('2', 3), true, '损坏的本地水位 fail-closed');
});

test('defaultVerifyHilTarget：默认永不放行 active——本阶段没有接 HIL 窗口验证，诚实拒绝', async () => {
  const wrongKind = await defaultVerifyHilTarget({ id: 't', kind: 'window' });
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.reason, /HIL/i);

  const rightKind = await defaultVerifyHilTarget({ id: 't', kind: HIL_TARGET_KIND });
  assert.equal(rightKind.ok, false, '本阶段未接线 HIL 验证器，即使类型正确也拒绝');
  assert.match(rightKind.reason, /not wired|phase/i);
});

test('RUN_MODES/RUN_STATES/RT_ERROR_CODES 是冻结枚举，含传输层与控制面全部错误码', () => {
  assert.deepEqual(RUN_MODES, ['shadow', 'active', 'replay']);
  for (const state of ['starting', 'running', 'stopping', 'stopped', 'stopped-unknown', 'unknown', 'failed']) {
    assert.ok(RUN_STATES.includes(state), `run 状态 ${state} 必须在枚举里`);
  }
  for (const code of [
    'PROTOCOL_MISMATCH', 'START_TIMEOUT', 'SPAWN_FAILED', 'WRITE_FAILED', 'WORKER_EXITED',
    'HEARTBEAT_LOST', 'TIMEOUT', 'ABORTED', 'DISPOSED', 'NOT_STARTED',
    'STALE_RUN', 'NOT_AUTHORIZED', 'NOT_DISPATCHED', 'TARGET_BUSY', 'BAD_REQUEST', 'WORKER_ERROR',
  ]) {
    assert.ok(RT_ERROR_CODES.includes(code), `错误码 ${code} 必须在契约里`);
  }
  assert.ok(Object.isFrozen(RT_ERROR_CODES));
});

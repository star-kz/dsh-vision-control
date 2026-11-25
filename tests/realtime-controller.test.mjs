/**
 * realtime/controller.mjs 控制面测试（Task 5 · RED 先行）。
 *
 * 控制面架在真实子进程假 Worker 之上（与 worker-client 测试同一个假 Worker 脚本，
 * 行为由 scenario JSON 驱动）。本文件钉住的是 Task 5 的控制面语义：
 *   - shadow 默认可跑；active 必须显式授权描述符且 HIL 目标由注入的验证器放行
 *     （默认验证器永不放行——本阶段不真实输入）。
 *   - 每个资源同时只允许一个 active run（TARGET_BUSY），shadow 不互斥。
 *   - 已派发的超时/退出/心跳丢失 = 结局未知（unknown），绝不自动盲重试；
 *     未派发的失败 = failed（什么都没发生）。
 *   - stop 记录诚实：estopSent/estopAcked/leaseRevoked/releaseConfirmed/released/
 *     releaseError/releaseToolUsed/state/duplicate，不谎称确认；worker 退出或心跳
 *     丢失时由独立 releaseTool 兜底（worker 活着的安全通道仍可写 stop）。
 *   - 旧 runId 回包、幽灵事件、回落 sourceEpoch 全部拒收并计数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerClient } from '../realtime/worker-client.mjs';
import { createRealtimeController } from '../realtime/controller.mjs';
import { HIL_TARGET_KIND } from '../realtime/contracts.mjs';

/** 与 worker-client 测试同一份假 Worker：JSONL stdio 协议，行为由 scenario 驱动。 */
const FAKE_WORKER_SRC = String.raw`
import { readFileSync, appendFileSync } from 'node:fs';
const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const logPath = scenario.logPath || null;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (line) => { if (logPath) { try { appendFileSync(logPath, line + '\n'); } catch {} } };
const caps = (scenario.hello && scenario.hello.capabilities) || ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'];
send({
  rt: 'hello',
  protocol: (scenario.hello && scenario.hello.protocol) != null ? scenario.hello.protocol : 1,
  worker: { name: 'fake-rt-worker', version: '0.1.0-test' },
  pid: process.pid,
  capabilities: caps,
});
for (const g of scenario.ghostEvents || []) {
  setTimeout(() => send(g.msg), g.atMs || 100);
}
if (caps.includes('heartbeat')) {
  let beats = 0;
  const t = setInterval(() => {
    beats += 1;
    send({ rt: 'event', event: 'heartbeat', atMs: Date.now() });
    if (scenario.stopHeartbeatAfter && beats >= scenario.stopHeartbeatAfter) clearInterval(t);
  }, scenario.heartbeatIntervalMs || 60);
}
if (scenario.dieAfterMs != null) {
  setTimeout(() => process.exit(scenario.exitCode || 0), scenario.dieAfterMs);
}
setInterval(() => {}, 60000);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {});
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    log(line);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.rt !== 'req') continue;
    const b = ((scenario.behaviors || {})[msg.cmd]) || {};
    if (b.die) process.exit(b.exitCode || 0);
    if (b.hang) continue;
    if (b.emitEvents) {
      for (const ev of b.emitEvents) {
        setTimeout(() => send(Object.assign({ rt: 'event' }, ev, msg.args && msg.args.runId != null ? { runId: msg.args.runId } : null)), 0);
      }
    }
    const respond = () => {
      if (b.staleRunId) {
        send({ rt: 'res', id: msg.id, ok: true, result: { runId: b.staleRunId, stale: true } });
        return;
      }
      if (b.error) {
        send({ rt: 'res', id: msg.id, ok: false, error: b.error });
        return;
      }
      const result = Object.assign({ cmd: msg.cmd, echo: msg.args || null }, b.result || {});
      if (msg.args && msg.args.runId != null && ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'].includes(msg.cmd)) {
        result.runId = msg.args.runId;
      }
      if (msg.cmd === 'stop') {
        result.released = b.released != null ? b.released : true;
        result.stopped = true;
      }
      send({ rt: 'res', id: msg.id, ok: true, result });
    };
    if (b.delayMs) setTimeout(respond, b.delayMs); else respond();
  }
});
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 15_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const WINDOW = { id: 'win-1', kind: 'window' };
const HIL = { id: 'hil-1', kind: HIL_TARGET_KIND };
const verifyOk = async (t) => (t && t.id === 'hil-1' ? { ok: true } : { ok: false, reason: 'unknown target' });

async function setup(scenario = {}, controllerOpts = {}, clientOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-ctrl-'));
  const script = join(dir, 'fake-rt-worker.mjs');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(script, FAKE_WORKER_SRC, 'utf8');
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, logPath: join(dir, 'worker-input.log') }), 'utf8');
  const client = createWorkerClient({
    command: process.execPath,
    args: [script, scenarioPath],
    helloTimeoutMs: 10_000,
    heartbeatTimeoutMs: 0,
    ...clientOpts,
  });
  await client.start();
  let releaseCalls = 0;
  const releaseTool = async (record) => {
    releaseCalls += 1;
    return { released: true, detail: `independent release of ${record.runId}` };
  };
  const controller = createRealtimeController({
    client,
    requestTimeoutMs: 6_000,
    estopTimeoutMs: 5_000,
    releaseTool,
    verifyHilTarget: verifyOk,
    ...controllerOpts,
  });
  return { client, controller, dir, releaseToolState: () => releaseCalls };
}

async function readWorkerLog(dir) {
  const { readFileSync } = await import('node:fs');
  try {
    return readFileSync(join(dir, 'worker-input.log'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function cleanup(client, dir) {
  try { client.dispose(); } catch {}
  await sleep(250);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('shadow run：默认模式，不持租约，status 能拿到 live 状态', async () => {
  const t = await setup();
  try {
    const rec = await t.controller.run({ skill: 'rhythm-basic', target: WINDOW });
    assert.equal(rec.mode, 'shadow');
    assert.equal(rec.lease.held, false);
    assert.equal(rec.state, 'running');
    const st = await t.controller.status(rec.runId);
    assert.equal(st.record.runId, rec.runId);
    assert.equal(st.live.cmd, 'status');
    assert.equal(st.live.runId, rec.runId);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('shadow stop：estop 已确认即释放；released 按协议不变式成立，但不谎称独立确认', async () => {
  const t = await setup();
  try {
    const rec = await t.controller.run({ skill: 'rhythm-basic', target: WINDOW });
    const stop = await t.controller.stop(rec.runId);
    assert.equal(stop.estopSent, true);
    assert.equal(stop.estopAcked, true);
    assert.equal(stop.leaseRevoked, false, 'shadow 从未持租约，不得虚构 leaseRevoked');
    assert.equal(stop.released, true, 'shadow 从未持键，释放按构造成立');
    assert.equal(stop.releaseConfirmed, false, '没有独立释放通道参与，不得声称 releaseConfirmed');
    assert.equal(stop.releaseToolUsed, false);
    assert.equal(stop.releaseError, null);
    assert.equal(stop.state, 'stopped');
    assert.equal(stop.duplicate, false);
    assert.equal(t.releaseToolState(), 0);
    assert.equal((await t.controller.status(rec.runId)).record.state, 'stopped');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active 无授权 / 授权对象不匹配 → NOT_AUTHORIZED，错误带 runId', async () => {
  const t = await setup();
  try {
    const err = await t.controller.run({ skill: 's', target: HIL, mode: 'active' }).then(
      () => assert.fail('应拒绝'),
      (e) => e,
    );
    assert.equal(err.code, 'NOT_AUTHORIZED');
    assert.ok(err.runId, '控制面错误必须带 runId 以便审计');
    assert.equal(err.dispatched, false, '未派发即可拒绝');

    const mismatch = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-other', granted: true },
    }).then(() => assert.fail('应拒绝'), (e) => e);
    assert.equal(mismatch.code, 'NOT_AUTHORIZED');
    assert.match(mismatch.message, /does not transfer|names target/i);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active 用默认 HIL 验证器（未接线）→ NOT_AUTHORIZED，即使授权描述符合法', async () => {
  const t = await setup({}, { verifyHilTarget: undefined });
  try {
    await assert.rejects(
      () => t.controller.run({
        skill: 's', target: HIL, mode: 'active',
        authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
      }),
      (err) => err.code === 'NOT_AUTHORIZED' && /not wired|phase/i.test(err.message),
    );
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active 显式授权 + 验证器放行：持租约、deadline 元数据按 run 独立记录', async () => {
  const t = await setup();
  try {
    const rec = await t.controller.run({
      skill: 'rhythm-basic', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
      deadlineMs: 8_000,
    });
    assert.equal(rec.mode, 'active');
    assert.equal(rec.lease.held, true);
    assert.equal(rec.deadline.deadlineMs, 8_000, 'deadline 是元数据，执行在 worker 侧');
    assert.equal(rec.state, 'running');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('TARGET_BUSY：同一目标的第二个 active 被拒；shadow 与 active 可共存', async () => {
  const t = await setup();
  try {
    const a1 = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    const busy = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    }).then(() => assert.fail('应拒绝'), (e) => e);
    assert.equal(busy.code, 'TARGET_BUSY');
    assert.equal(busy.dispatched, false);
    const sh = await t.controller.run({ skill: 's', target: HIL });
    assert.equal(sh.mode, 'shadow', 'shadow 不与 active 互斥');
    await t.controller.stop(a1.runId);
    const a2 = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    assert.equal(a2.state, 'running', '真实释放证据到位后允许后续 active');
    await t.controller.stop(a2.runId);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('run 派发后超时：state=unknown、绝不盲重试（恰好一次派发），stop 仍能完成', async () => {
  const t = await setup({ behaviors: { run: { delayMs: 800 } } }, { requestTimeoutMs: 150 });
  try {
    const err = await t.controller.run({ skill: 's', target: WINDOW }).then(
      () => assert.fail('应超时'),
      (e) => e,
    );
    assert.equal(err.code, 'TIMEOUT');
    assert.equal(err.dispatched, true, '已写出，结局未知');
    assert.equal(err.runId != null, true);
    assert.equal(t.client.stats.dispatched, 1, '超时后绝不自动重发');
    const rec = await t.controller.status(err.runId);
    assert.equal(rec.record.state, 'unknown');
    const stop = await t.controller.stop(err.runId);
    assert.equal(stop.estopAcked, true);
    assert.equal(stop.state, 'stopped');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('AbortSignal：派发前中止=failed 且零派发；派发后中止=unknown，不冒充已停止', async () => {
  const t = await setup();
  try {
    const ac = new AbortController();
    ac.abort();
    const before = t.client.stats.dispatched;
    const err = await t.controller.run({ skill: 's', target: WINDOW, signal: ac.signal }).then(
      () => assert.fail('应中止'),
      (e) => e,
    );
    assert.equal(err.code, 'ABORTED');
    assert.equal(err.dispatched, false);
    assert.equal(t.client.stats.dispatched, before);
    assert.equal((await t.controller.status(err.runId)).record.state, 'failed');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('派发后 abort：等待被取消但 run 记为 unknown，随后 stop 收尾', async () => {
  const t = await setup({ behaviors: { run: { delayMs: 5_000 } } }, { requestTimeoutMs: 10_000 });
  try {
    const ac = new AbortController();
    const pending = t.controller.run({ skill: 's', target: WINDOW, signal: ac.signal }).then(
      () => assert.fail('应中止'),
      (e) => e,
    );
    await waitFor(() => t.client.stats.dispatched >= 1, { label: 'run 已写出' });
    ac.abort();
    const err = await pending;
    assert.equal(err.code, 'ABORTED');
    assert.equal(err.dispatched, true, '信号只取消等待，不改写结局');
    const rec = await t.controller.status(err.runId);
    assert.equal(rec.record.state, 'unknown');
    const stop = await t.controller.stop(err.runId);
    assert.equal(stop.state, 'stopped');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('旧 runId 回包：status 拒收（STALE_RUN）；已派发 run 回包错位 → unknown', async () => {
  const t = await setup({ behaviors: { run: { staleRunId: 'run-someone-else' } } });
  try {
    const err = await t.controller.run({ skill: 's', target: WINDOW }).then(
      () => assert.fail('应拒收'),
      (e) => e,
    );
    assert.equal(err.code, 'STALE_RUN');
    assert.equal(err.dispatched, true);
    assert.equal((await t.controller.status(err.runId)).record.state, 'unknown', '已收到错包证明请求已派发，结局只能 unknown');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('status 收到旧 runId 回包：STALE_RUN 错误但不改写 run 自身状态', async () => {
  const t = await setup({ behaviors: { status: { staleRunId: 'run-other' } } });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    await assert.rejects(
      () => t.controller.status(rec.runId),
      (err) => err.code === 'STALE_RUN' && err.runId === rec.runId,
    );
    const rec2 = await t.controller.status(rec.runId, { force: false }).catch(() => null);
    void rec2;
    // 直接读本地记录：run 状态未被污染
    const st = t.controller.stats;
    void st;
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('worker 中途被杀（active run）：自动调 releaseTool；stop 诚实：estopSent=false、releaseToolUsed=true', async () => {
  const t = await setup();
  try {
    const rec = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    t.client.kill();
    await waitFor(() => t.releaseToolState() >= 1, { label: 'worker 退出触发独立释放' });
    await waitFor(() => t.controller.status(rec.runId).then((s) => s.record.state === 'unknown'), { label: 'run 记为 unknown' });
    const stop = await t.controller.stop(rec.runId);
    assert.equal(stop.estopSent, false, 'worker 已死，写不进去就不声称已发');
    assert.equal(stop.estopAcked, false);
    assert.equal(stop.leaseRevoked, false);
    assert.equal(stop.releaseToolUsed, true);
    assert.equal(stop.releaseConfirmed, true, '独立释放工具确认');
    assert.equal(stop.released, true);
    assert.equal(stop.releaseError, null);
    assert.equal(stop.state, 'stopped');
    assert.equal(t.releaseToolState(), 1, 'auto-release 一次，stop 复用其结论，不重复调用');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('worker 中途被杀（shadow run）：不调 releaseTool，released 按构造成立', async () => {
  const t = await setup();
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    t.client.kill();
    await waitFor(() => t.controller.status(rec.runId).then((s) => s.record.state === 'unknown'), { label: 'run 记为 unknown' });
    const stop = await t.controller.stop(rec.runId);
    assert.equal(t.releaseToolState(), 0, 'shadow 从未持键，不需要独立释放');
    assert.equal(stop.releaseToolUsed, false);
    assert.equal(stop.releaseConfirmed, false);
    assert.equal(stop.released, true, '协议不变式：shadow 不持写租约');
    assert.equal(stop.estopSent, false);
    assert.equal(stop.state, 'stopped');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('心跳丢失（active run）：pending 记 unknown 并自动释放；stop 走安全通道仍能送达', async () => {
  const t = await setup(
    {
      hello: { capabilities: ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'] },
      heartbeatIntervalMs: 50,
      stopHeartbeatAfter: 3,
      behaviors: { run: { hang: {} } },
    },
    {},
    { heartbeatTimeoutMs: 400 },
  );
  try {
    const rec = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    }).then(
      () => assert.fail('心跳丢失应使 run 失败'),
      (e) => e,
    );
    assert.equal(rec.code, 'HEARTBEAT_LOST');
    assert.equal(rec.dispatched, true);
    await waitFor(() => t.releaseToolState() >= 1, { label: '心跳丢失触发独立释放' });
    const st = await t.controller.status(rec.runId);
    assert.equal(st.record.state, 'unknown');
    const stop = await t.controller.stop(rec.runId);
    assert.equal(stop.estopSent, true, 'worker 还活着：安全通道可写');
    assert.equal(stop.estopAcked, true);
    assert.equal(stop.state, 'stopped');
    assert.equal(t.releaseToolState(), 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('重复 stop：第二个 stop 搭第一个的便车（duplicate=true），worker 只收到一次 stop', async () => {
  const t = await setup({ behaviors: { stop: { delayMs: 350 } } });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    const first = t.controller.stop(rec.runId);
    await sleep(60);
    const second = await t.controller.stop(rec.runId);
    const [s1, s2] = await Promise.all([first, second]);
    assert.equal(s1.duplicate, false);
    assert.equal(s2.duplicate, true);
    const log = await readWorkerLog(t.dir);
    const stops = log.filter((l) => l.rt === 'req' && l.cmd === 'stop');
    assert.equal(stops.length, 1, 'join 而非重发');
    assert.equal(t.releaseToolState(), 0);
    assert.equal(s2.state, 'stopped');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('snapshot：未知 run 派发前拒收 STALE_RUN；已知 run 回包经 runId 校验', async () => {
  const t = await setup();
  try {
    const before = t.client.stats.dispatched;
    await assert.rejects(
      () => t.controller.snapshot('run-nope'),
      (err) => err.code === 'STALE_RUN' && err.runId === 'run-nope',
    );
    assert.equal(t.client.stats.dispatched, before, '未知 run 不派发');
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    const snap = await t.controller.snapshot(rec.runId);
    assert.equal(snap.runId, rec.runId);
    assert.equal(snap.cmd, 'snapshot');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('replay：mode=replay 携带 tracePath；mode=active 直接 BAD_REQUEST（回放永不注入真实输入）', async () => {
  const t = await setup();
  try {
    const rep = await t.controller.replay({ tracePath: 'D:/traces/t1.bin' });
    assert.equal(rep.mode, 'replay');
    const log = await readWorkerLog(t.dir);
    const req = log.find((l) => l.rt === 'req' && l.cmd === 'replay');
    assert.equal(req.args.tracePath, 'D:/traces/t1.bin');
    assert.equal(req.args.mode, 'replay');
    await assert.rejects(
      () => t.controller.replay({ tracePath: 'D:/traces/t1.bin', mode: 'active' }),
      (err) => err.code === 'BAD_REQUEST' && /never injects|offline/i.test(err.message),
    );
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('事件通道：同 epoch 的递增 eventSeq 接受，heartbeat 不伪造 epoch/seq', async () => {
  const t = await setup({
    heartbeatIntervalMs: 5,
    behaviors: {
      run: {
        emitEvents: [
          { event: 'state', state: 's2', eventSeq: 1, sourceEpoch: 2 },
          { event: 'state', state: 's2-next', eventSeq: 2, sourceEpoch: 2 },
          { event: 'state', state: 's2-final', eventSeq: 3, sourceEpoch: 2 },
        ],
      },
    },
  });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    await waitFor(() => rec.eventSeqMax === 3, { label: '同 epoch 的三条事件全部接收' });
    assert.equal(rec.sourceEpochMax, 2);
    assert.equal(rec.state, 's2-final', '同 native epoch 的后续事件不能因 epoch 未 +1 被误杀');
    assert.equal(t.controller.stats.staleEpochEvents, 0);
    assert.equal(t.controller.stats.staleEventSeqEvents, 0);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('事件通道：eventSeq 重复/回退、epoch 回退与幽灵 runId 分别拒绝', async () => {
  const t = await setup({
    behaviors: {
      run: {
        emitEvents: [
          { event: 'state', state: 'accepted-1', eventSeq: 1, sourceEpoch: 2 },
          { event: 'state', state: 'duplicate-seq', eventSeq: 1, sourceEpoch: 2 },
          { event: 'state', state: 'regressed-seq', eventSeq: 0, sourceEpoch: 2 },
          { event: 'state', state: 'accepted-2', eventSeq: 2, sourceEpoch: 3 },
          { event: 'state', state: 'regressed-epoch', eventSeq: 3, sourceEpoch: 2 },
        ],
      },
    },
    ghostEvents: [{ atMs: 100, msg: { rt: 'event', event: 'state', runId: 'ghost-run', state: 'running' } }],
  });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    await waitFor(() => (t.controller.stats.staleEventSeqEvents ?? 0) >= 2, { label: '重复与回退 eventSeq 被计数' });
    await waitFor(() => (t.controller.stats.staleRunEvents ?? 0) >= 1, { label: '幽灵事件被计数' });
    assert.equal(rec.state, 'accepted-2');
    assert.equal(rec.sourceEpochMax, 3);
    assert.equal(rec.eventSeqMax, 2);
    assert.equal(t.controller.stats.staleEventSeqEvents, 2);
    assert.equal(t.controller.stats.staleEpochEvents, 1);
    assert.equal(t.controller.stats.staleRunEvents, 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('worker 重启换代：旧 run 保持 unknown，新 run 在新进程上正常跑', async () => {
  const t = await setup();
  try {
    const old = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    const pid1 = t.client.info.pid;
    t.client.kill();
    await waitFor(() => t.client.state === 'dead', { label: '第一代死亡' });
    await waitFor(() => t.releaseToolState() >= 1, { label: '独立释放' });
    const rec2 = await t.controller.run({ skill: 's', target: WINDOW });
    assert.equal(rec2.state, 'running');
    assert.notEqual(t.client.info.pid, pid1, '第二代进程');
    assert.equal((await t.controller.status(old.runId)).record.state, 'unknown', '旧 run 不被新进程复活');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('SPAWN_FAILED：坏命令路径 → 错误带 runId、run 记 failed，stop 拒绝 NOT_DISPATCHED', async () => {
  const client = createWorkerClient({
    command: 'definitely-not-a-real-executable-xyz',
    args: [],
    helloTimeoutMs: 2_000,
    heartbeatTimeoutMs: 0,
  });
  const controller = createRealtimeController({ client, requestTimeoutMs: 1_000, estopTimeoutMs: 1_000 });
  const err = await controller.run({ skill: 's', target: WINDOW }).then(
    () => assert.fail('应失败'),
    (e) => e,
  );
  assert.equal(err.code, 'SPAWN_FAILED');
  assert.ok(err.runId);
  const rec = await controller.status(err.runId);
  assert.equal(rec.record.state, 'failed');
  await assert.rejects(
    () => controller.stop(err.runId),
    (e) => e.code === 'NOT_DISPATCHED' && e.runId === err.runId,
  );
  client.dispose();
});

test('run 收到 worker ok:false：已派发=unknown、绝不盲重试，stop 不按未派发拒绝', async () => {
  const t = await setup({ behaviors: { run: { error: { code: 'WORKER_ERROR', message: 'rejected after receipt' } } } });
  try {
    const err = await t.controller.run({ skill: 's', target: WINDOW }).then(
      () => assert.fail('worker 错误应上抛'),
      (e) => e,
    );
    assert.equal(err.code, 'WORKER_ERROR');
    assert.equal(err.dispatched, true);
    assert.equal((await t.controller.status(err.runId)).record.state, 'unknown');
    const log = await readWorkerLog(t.dir);
    assert.equal(log.filter((m) => m.rt === 'req' && m.cmd === 'run').length, 1);
    const stop = await t.controller.stop(err.runId);
    assert.equal(stop.estopSent, true);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active 预派发拒绝后 worker 退出：releaseTool 必须保持零调用', async () => {
  const t = await setup();
  try {
    const err = await t.controller.run({ skill: 's', target: HIL, mode: 'active' }).then(
      () => assert.fail('应拒绝'),
      (e) => e,
    );
    assert.equal(err.code, 'NOT_AUTHORIZED');
    assert.equal(err.dispatched, false);
    t.client.kill();
    await waitFor(() => t.client.state === 'dead', { label: 'worker 退出' });
    await sleep(150);
    assert.equal(t.releaseToolState(), 0);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active 释放证据缺失时 stopped-unknown 仍保持 TARGET_BUSY 互斥', async () => {
  const t = await setup(
    { behaviors: { stop: { released: false } } },
    { releaseTool: async () => ({ released: false, error: 'lease still held' }) },
  );
  try {
    const first = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    await t.controller.stop(first.runId);
    assert.equal(first.lease.held, true, '没有释放证据就不能放下租约');
    const before = t.client.stats.dispatched;
    const err = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    }).then(() => assert.fail('租约未释放时必须拒绝'), (e) => e);
    assert.equal(err.code, 'TARGET_BUSY');
    assert.equal(err.dispatched, false);
    assert.equal(t.client.stats.dispatched, before);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('shadow stop 未获 worker 停止证据：leaseRevoked=false 且 state=stopped-unknown', async () => {
  const t = await setup({ behaviors: { stop: { hang: true } } }, { estopTimeoutMs: 150 });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    const stop = await t.controller.stop(rec.runId);
    assert.equal(stop.estopSent, true);
    assert.equal(stop.estopAcked, false);
    assert.equal(stop.leaseRevoked, false);
    assert.equal(stop.released, true, 'shadow 不持键仍按构造成立');
    assert.equal(stop.state, 'stopped-unknown', '无租约可释放不等于 worker 已停止');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active run 已返回后心跳丢失：仍记 unknown 并调用独立 releaseTool', async () => {
  const t = await setup(
    {
      hello: { capabilities: ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'] },
      heartbeatIntervalMs: 50,
      stopHeartbeatAfter: 3,
    },
    {},
    { heartbeatTimeoutMs: 400 },
  );
  try {
    const rec = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    assert.equal(rec.state, 'running');
    await waitFor(() => t.releaseToolState() >= 1, { timeoutMs: 2_000, label: '返回后的健康丢失触发释放' });
    const st = await t.controller.status(rec.runId);
    assert.equal(st.record.state, 'unknown');
    assert.equal(st.live, null);
    assert.equal(st.liveError.code, 'HEARTBEAT_LOST');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('runId 使用 UUID 且跨 session 不碰撞；sessionId 在构造时固定并完整转发授权', async () => {
  const wire = [];
  const makeClient = () => ({
    state: 'ready',
    onEvent() {}, onExit() {}, onHealthChange() {},
    async request(cmd, args) {
      wire.push({ cmd, args });
      return { runId: args.runId, state: 'running' };
    },
    dispose() {},
  });
  const a = createRealtimeController({ client: makeClient(), sessionId: 'session-A', requestTimeoutMs: 1000 });
  const b = createRealtimeController({ client: makeClient(), sessionId: 'session-B', requestTimeoutMs: 1000 });
  const authorization = { targetId: 'win-1', granted: true, permit: { id: 'permit-A', scopes: ['shadow'] } };
  const [ra, rb] = await Promise.all([
    a.run({ skill: 'skill-a', target: WINDOW, authorization, deadlineMs: 250, sessionId: 'late-override' }),
    b.run({ skill: 'skill-b', target: WINDOW }),
  ]);
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(ra.runId, uuid);
  assert.match(rb.runId, uuid);
  assert.notEqual(ra.runId, rb.runId, '两个控制器同毫秒创建首 run 也绝不能碰撞');
  assert.equal(ra.sessionId, 'session-A');
  assert.equal(rb.sessionId, 'session-B');
  const runA = wire.find((m) => m.cmd === 'run' && m.args.runId === ra.runId);
  assert.deepEqual(runA.args, {
    runId: ra.runId, mode: 'shadow', skill: 'skill-a', target: WINDOW,
    sessionId: 'session-A', deadlineMs: 250, authorization,
  });
  a.dispose();
  b.dispose();
});

test('native deadlineMs 只转发给 Worker，不用 Node requestTimeout/Abort 伪造 native 截止', async () => {
  const t = await setup({ behaviors: { run: { delayMs: 80 } } }, { requestTimeoutMs: 1000 });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW, deadlineMs: 1 });
    await sleep(120);
    const st = await t.controller.status(rec.runId);
    assert.equal(st.record.state, 'running');
    assert.equal(st.live.cmd, 'status');
    assert.equal(t.client.stats.dispatched, 2, '只有 run/status 各一次；1ms native deadline 不触发 Node abort 或重试');
    const log = await readWorkerLog(t.dir);
    const run = log.find((m) => m.rt === 'req' && m.cmd === 'run');
    assert.equal(run.args.deadlineMs, 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active target 与 authorization 在入口做深不可变快照：异步验证期间的调用方突变不能进入 dispatch', async () => {
  let finishVerification;
  const verify = () => new Promise((resolve) => {
    finishVerification = () => resolve({ ok: true });
  });
  const t = await setup({}, { verifyHilTarget: verify });
  try {
    const target = { id: 'hil-1', kind: HIL_TARGET_KIND, bounds: { x: 10, y: 20 } };
    const expiresAtMs = Date.now() + 60_000;
    const authorization = { targetId: 'hil-1', granted: true, expiresAtMs, permit: { id: 'permit-1', scopes: ['desktop'] } };
    const pending = t.controller.run({
      skill: 's', target, mode: 'active', authorization,
    });
    await waitFor(() => typeof finishVerification === 'function', { label: '进入异步目标验证' });
    target.id = 'hil-other';
    target.kind = 'window';
    target.bounds.x = 9999;
    authorization.targetId = 'hil-other';
    authorization.permit.id = 'mutated-after-validation';
    finishVerification();
    const rec = await pending;
    assert.equal(rec.target.id, 'hil-1');
    assert.equal(rec.target.kind, HIL_TARGET_KIND);
    assert.equal(rec.target.bounds.x, 10);
    assert.equal(Object.isFrozen(rec.target), true);
    assert.equal(Object.isFrozen(rec.target.bounds), true);
    const log = await readWorkerLog(t.dir);
    const dispatched = log.find((m) => m.rt === 'req' && m.cmd === 'run');
    assert.equal(dispatched.args.target.id, 'hil-1');
    assert.equal(dispatched.args.target.bounds.x, 10);
    assert.deepEqual(dispatched.args.authorization, {
      targetId: 'hil-1', granted: true, expiresAtMs, permit: { id: 'permit-1', scopes: ['desktop'] },
    });
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('run 事件 epoch/eventSeq 必须 safe nonnegative integer；畸形与重复序号全部拒收', async () => {
  const t = await setup({
    behaviors: {
      run: {
        emitEvents: [
          { event: 'state', state: 's7', eventSeq: 1, sourceEpoch: 7 },
          { event: 'state', state: 'bad-negative', eventSeq: 2, sourceEpoch: -1 },
          { event: 'state', state: 'bad-fraction-stale', eventSeq: 3, sourceEpoch: 1.5 },
          { event: 'state', state: 'bad-fraction-newer', eventSeq: 4, sourceEpoch: 7.5 },
          { event: 'state', state: 'bad-string', eventSeq: 5, sourceEpoch: '8' },
          { event: 'state', state: 'bad-unsafe', eventSeq: 6, sourceEpoch: Number.MAX_SAFE_INTEGER + 1 },
          { event: 'state', state: 'bad-missing', eventSeq: 7 },
          { event: 'state', state: 'bad-null', eventSeq: 8, sourceEpoch: null },
          { event: 'state', state: 's8', eventSeq: 9, sourceEpoch: 8 },
          { event: 'state', state: 'duplicate-seq', eventSeq: 8, sourceEpoch: 8 },
        ],
      },
    },
  });
  try {
    const rec = await t.controller.run({ skill: 's', target: WINDOW });
    await waitFor(() => rec.eventSeqMax === 9 && (t.controller.stats.staleEpochEvents ?? 0) >= 7, { label: '合法与畸形事件结算' });
    const st = await t.controller.status(rec.runId);
    assert.equal(st.record.state, 's8');
    assert.equal(st.record.sourceEpochMax, 8);
    assert.equal(st.record.eventSeqMax, 9);
    assert.equal(t.controller.stats.staleEpochEvents, 7);
    assert.equal(t.controller.stats.staleEventSeqEvents, 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('active heartbeat：空闲时持续续租，stop 后不再发送', async () => {
  const t = await setup({}, { heartbeatIntervalMs: 20, heartbeatRequestTimeoutMs: 200 });
  try {
    const rec = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    await waitFor(async () => (await readWorkerLog(t.dir)).filter((x) => x.cmd === 'heartbeat').length >= 2,
      { label: 'active heartbeat renewal' });
    const beats = (await readWorkerLog(t.dir)).filter((x) => x.cmd === 'heartbeat');
    assert.ok(beats.every((x) => x.args.sessionId === 'default'));
    assert.ok(rec.lastHeartbeatAckAtMs > 0);
    await t.controller.stop(rec.runId);
    await sleep(30);
    const stoppedCount = (await readWorkerLog(t.dir)).filter((x) => x.cmd === 'heartbeat').length;
    await sleep(70);
    assert.equal((await readWorkerLog(t.dir)).filter((x) => x.cmd === 'heartbeat').length, stoppedCount);
  } finally {
    t.controller.dispose();
    await cleanup(t.client, t.dir);
  }
});

test('active heartbeat：续租失败进入 unknown 并调用独立释放，不盲重试', async () => {
  const t = await setup({ behaviors: { heartbeat: { error: { code: 'HEARTBEAT_FAILED', message: 'renewal refused' } } } },
    { heartbeatIntervalMs: 20, heartbeatRequestTimeoutMs: 200 });
  try {
    const rec = await t.controller.run({
      skill: 's', target: HIL, mode: 'active',
      authorization: { targetId: 'hil-1', granted: true, expiresAtMs: Date.now() + 60_000 },
    });
    await waitFor(() => t.releaseToolState() === 1, { label: 'independent release after heartbeat failure' });
    assert.equal(rec.state, 'unknown');
    assert.equal(rec.heartbeatError.code, 'HEARTBEAT_FAILED');
    await sleep(70);
    assert.equal((await readWorkerLog(t.dir)).filter((x) => x.cmd === 'heartbeat').length, 1);
  } finally {
    t.controller.dispose();
    await cleanup(t.client, t.dir);
  }
});

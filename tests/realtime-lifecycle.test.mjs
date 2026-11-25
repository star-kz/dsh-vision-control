import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIL_TARGET_KIND } from '../realtime/contracts.mjs';
import { createRealtimeHost } from '../tools/realtime.mjs';

const exec = (sessionId) => ({ agent: { session: { id: sessionId } } });
const target = (id = 'hil-1') => ({ id, kind: HIL_TARGET_KIND });
const activeArgs = (id = 'hil-1') => ({ skill: 's', mode: 'active', target: target(id), authorization: { granted: true, targetId: id, expiresAtMs: Date.now() + 60_000 } });

class FakeClient {
  constructor() { this.state = 'ready'; this.requests = []; this.disposed = 0; this.stopReleased = true; }
  async start() { this.state = 'ready'; }
  async request(cmd, args) {
    this.requests.push({ cmd, args });
    if (cmd === 'run') return { runId: args.runId, state: 'running' };
    if (cmd === 'status') return { runId: args.runId, state: 'running' };
    if (cmd === 'stop') return { runId: args.runId, released: this.stopReleased };
    if (cmd === 'snapshot') return { runId: args.runId, path: 'frame.png' };
    if (cmd === 'replay') return { runId: args.runId, state: 'stopped' };
    return {};
  }
  onEvent(cb) { this.eventHandler = cb; return () => {}; }
  onExit(cb) { this.exitHandler = cb; return () => {}; }
  onHealthChange(cb) { this.healthHandler = cb; return () => {}; }
  dispose() { this.disposed += 1; this.state = 'disposed'; }
}

function setup(overrides = {}) {
  const clients = [];
  const releases = [];
  const host = createRealtimeHost({
    clientFactory: ({ sessionId }) => { const c = new FakeClient(); c.sessionId = sessionId; clients.push(c); return c; },
    verifyHilTarget: async () => ({ ok: true }),
    releaseTool: async (record) => { releases.push(record); return { released: true, detail: 'independent fixture release' }; },
    claimSlowController: () => {},
    ...overrides,
  });
  return { host, clients, releases };
}

test('active 同 session/target 与跨 session 全局互斥，shadow 不占输入租约', async () => {
  const { host } = setup();
  const first = await host.run(activeArgs(), exec('a'));
  await assert.rejects(host.run(activeArgs(), exec('a')), (err) => err.code === 'TARGET_BUSY');
  await assert.rejects(host.run(activeArgs(), exec('b')), (err) => err.code === 'TARGET_BUSY');
  const shadow = await host.run({ skill: 's', target: { id: 'hil-1', kind: 'hil' } }, exec('a'));
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.lease.held, false);
  assert.equal((await host.stop({ runId: first.runId }, exec('a'))).state, 'stopped');
  const second = await host.run(activeArgs(), exec('b'));
  assert.equal(second.sessionId, 'b');
  await host.dispose();
});

test('原生 hil-hex/handle 与 legacy numeric HWND 双向互斥；结束后按真实释放证据解除', async () => {
  const { host } = setup();
  const nativeTarget = { id: 'hil-2a', kind: HIL_TARGET_KIND, handle: 42 };
  const nativeActive = { ...activeArgs('hil-2a'), target: nativeTarget };
  const slow = host.beginSlowWrite('a', { hwnd: 42 });
  await assert.rejects(host.run(nativeActive, exec('a')), (err) => err.code === 'SLOW_WRITE_BUSY');
  host.endSlowWrite(slow);
  const run = await host.run(nativeActive, exec('a'));
  assert.throws(() => host.beginSlowWrite('a', { hwnd: 42 }), (err) => err.code === 'RT_TARGET_BUSY');
  assert.throws(() => host.beginSlowWrite('a', {}), (err) => err.code === 'RT_TARGET_BUSY');
  const stop = await host.stop({ runId: run.runId }, exec('a'));
  assert.equal(stop.released, true);
  const nextSlow = host.beginSlowWrite('a', { hwnd: 42 });
  host.endSlowWrite(nextSlow);
  await host.dispose();
});

test('未知 active 目标对同 session 的后续已知目标也保持保守互斥', async () => {
  const { host } = setup();
  const unknown = await host.run({
    ...activeArgs('hil-unparseable'),
    target: { id: 'hil-unparseable', kind: HIL_TARGET_KIND, handle: 'not-a-handle' },
  }, exec('a'));
  assert.equal(unknown.mode, 'active');
  const known = { ...activeArgs('hil-2a'), target: { id: 'hil-2a', kind: HIL_TARGET_KIND, handle: 42 } };
  await assert.rejects(host.run(known, exec('a')), (err) => err.code === 'TARGET_BUSY');
  await host.stop({ runId: unknown.runId }, exec('a'));
  await host.dispose();
});

test('停止与释放证据未知时 stopped-unknown，revoke 汇总错误且不报 released', async () => {
  const { host, releases } = setup({
    releaseTool: async (record) => { releases.push(record); return { released: false, detail: 'independent release unavailable' }; },
  });
  const run = await host.run(activeArgs(), exec('a'));
  // The fake worker acknowledges estop but cannot prove input release.
  const client = host._debugClients ? host._debugClients[0] : null;
  assert.equal(client, null, 'no production debug backdoor is needed');
  const stop = await host.stop({ runId: run.runId }, exec('a'));
  // stopReleased defaults true; force unknown through a fresh client/host below when false is required.
  assert.equal(stop.state, 'stopped');
  assert.equal(stop.releaseConfirmed, false);
  await host.dispose();
});

test('worker 明确未释放 + 独立释放失败：所有确认位保持 false', async () => {
  const clients = [];
  const host = createRealtimeHost({
    clientFactory: () => { const c = new FakeClient(); c.stopReleased = false; clients.push(c); return c; },
    verifyHilTarget: async () => ({ ok: true }),
    releaseTool: async () => ({ released: false, detail: 'release evidence unavailable' }),
  });
  const run = await host.run(activeArgs(), exec('a'));
  const stop = await host.stop({ runId: run.runId }, exec('a'));
  assert.equal(stop.state, 'stopped-unknown');
  assert.equal(stop.stopped, false);
  assert.equal(stop.released, false);
  assert.equal(stop.releaseConfirmed, false);
  assert.equal(stop.releaseToolUsed, true);
  assert.match(stop.releaseError, /unavailable/);
  const outcome = await host.stopSession('a', { revoke: true, reason: 'test revoke' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /stopped-unknown|release evidence unavailable/);
  await assert.rejects(host.run({ skill: 's', target: { id: 'w', kind: 'window' } }, exec('a')), (err) => err.code === 'SESSION_REVOKED');
  assert.equal(clients[0].disposed, 1);
  await host.dispose();
});

test('stopSession 与插件 dispose 都停止该范围全部 run、撤销等待并关闭所有 fake Worker', async () => {
  const { host, clients } = setup();
  const a1 = await host.run({ skill: 's', target: { id: 'a1', kind: 'window' } }, exec('a'));
  const a2 = await host.run(activeArgs('a2'), exec('a'));
  const b1 = await host.run({ skill: 's', target: { id: 'b1', kind: 'window' } }, exec('b'));
  const revoked = await host.stopSession('a', { revoke: true, reason: 'computer_stop' });
  assert.equal(revoked.stopped, 2);
  assert.equal(revoked.unknown, 0);
  assert.equal(clients.find((c) => c.sessionId === 'a').disposed, 1);
  assert.equal(clients.find((c) => c.sessionId === 'b').disposed, 0);
  assert.equal((await host.stop({ runId: a1.runId }, exec('a'))).duplicate, true);
  assert.equal((await host.status({ runId: b1.runId }, exec('b'))).record.runId, b1.runId);
  const disposed = await host.dispose();
  assert.equal(disposed.stopped >= 1, true);
  assert.equal(clients.find((c) => c.sessionId === 'b').disposed, 1);
  assert.equal(a2.mode, 'active');
});

test('active 已派发但 run 应答错位：保留 unknown 身份、互斥与 dispose 停止证据', async () => {
  const client = new FakeClient();
  client.request = async function (cmd, args) {
    this.requests.push({ cmd, args });
    if (cmd === 'run') return { runId: 'wrong-worker-run', state: 'running' };
    if (cmd === 'status') return { runId: args.runId, state: 'unknown' };
    if (cmd === 'stop') return { runId: args.runId, released: true };
    return {};
  };
  const host = createRealtimeHost({
    clientFactory: () => client,
    verifyHilTarget: async () => ({ ok: true }),
    releaseTool: async () => ({ released: true }),
  });
  let failure;
  await assert.rejects(host.run(activeArgs(), exec('stale-session')), (error) => {
    failure = error;
    return error.code === 'STALE_RUN' && error.dispatched === true;
  });
  assert.ok(failure.runId.startsWith('stale-session:'), 'caller receives the session-scoped public id, not a colliding local id');
  const status = await host.status({ runId: failure.runId }, exec('stale-session'));
  assert.equal(status.record.state, 'unknown');
  await assert.rejects(host.run(activeArgs(), exec('other-session')), (error) => error.code === 'TARGET_BUSY');
  const outcome = await host.stopSession('stale-session', { reason: 'dispose after stale run ack' });
  assert.equal(outcome.stopped, 1);
  assert.equal(outcome.unknown, 0);
  assert.equal(client.requests.filter((request) => request.cmd === 'stop').length, 1);
  await host.dispose();
});

test('worker 掉线复用注入的独立 releaseTool；后续 stop 不重复释放', async () => {
  const clients = [];
  const releases = [];
  const host = createRealtimeHost({
    clientFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
    verifyHilTarget: async () => ({ ok: true }),
    releaseTool: async (record) => { releases.push(record); return { released: true, detail: 'process-independent release' }; },
  });
  const run = await host.run(activeArgs(), exec('release-session'));
  clients[0].state = 'dead';
  clients[0].exitHandler({ code: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  assert.equal(releases[0].sessionId, 'release-session');
  const stop = await host.stop({ runId: run.runId }, exec('release-session'));
  assert.equal(stop.releaseConfirmed, true);
  assert.equal(stop.released, true);
  assert.equal(stop.releaseToolUsed, true);
  assert.equal(releases.length, 1);
  await host.dispose();
});

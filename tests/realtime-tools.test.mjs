import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RT_TOOL_NAMES, HIL_TARGET_KIND } from '../realtime/contracts.mjs';
import { REALTIME_TOOL_CONTRACTS } from '../internal/tool-contracts.mjs';
import { createRealtimeHost, registerRealtimeTools } from '../tools/realtime.mjs';
import { createRealtimeController } from '../realtime/controller.mjs';

const exec = (sessionId = 'session-a') => ({ agent: { session: { id: sessionId } } });
const HIL = { id: 'hil-1', kind: HIL_TARGET_KIND };

class FakeClient {
  constructor() {
    this.state = 'ready';
    this.requests = [];
    this.disposed = 0;
    this.stopReleased = true;
    this.eventHandler = null;
    this.exitHandler = null;
    this.healthHandler = null;
  }
  async start() { this.state = 'ready'; return { protocol: 1, capabilities: ['run'] }; }
  async request(cmd, args) {
    this.requests.push({ cmd, args });
    if (cmd === 'run') return { runId: args.runId, state: 'running' };
    if (cmd === 'status') return { runId: args.runId, state: 'running', worker: true };
    if (cmd === 'stop') return { runId: args.runId, stopped: true, released: this.stopReleased };
    if (cmd === 'snapshot') return { runId: args.runId, path: 'slow-ring/frame-7.png', attachmentId: 'sha256:frame-7' };
    if (cmd === 'replay') return { runId: args.runId, state: 'stopped', events: 3 };
    if (cmd === 'targets') return { targets: [{ id: 'hil-1', kind: 'hil', name: 'HIL fixture' }] };
    if (cmd === 'skill_validate') return { valid: true, skill: args.skill, warnings: [] };
    if (cmd === 'calibrate') return { calibrated: true, target: args.target, details: { scale: 1 } };
    if (cmd === 'trace_read') return { path: args.tracePath, offset: args.offset, limit: args.limit, events: [{ type: 'state' }] };
    throw new Error(`unexpected command: ${cmd}`);
  }
  onEvent(cb) { this.eventHandler = cb; return () => {}; }
  onExit(cb) { this.exitHandler = cb; return () => {}; }
  onHealthChange(cb) { this.healthHandler = cb; return () => {}; }
  dispose() { this.disposed += 1; this.state = 'disposed'; }
}

function register(config = {}) {
  const definitions = [];
  const host = registerRealtimeTools({
    config,
    defineTracedTool: (definition) => definition,
    safeRegister: (definition) => { definitions.push(definition); return true; },
    logger: { warn() {}, error() {} },
  });
  return { host, definitions, byName: new Map(definitions.map((d) => [d.name, d])) };
}

test('公开契约恰好注册冻结的 9 个 RT_TOOL_NAMES，顺序一致且没有第 10 个工具', () => {
  const { definitions } = register({ clientFactory: () => new FakeClient() });
  assert.deepEqual(definitions.map((d) => d.name), RT_TOOL_NAMES);
  assert.deepEqual(Object.keys(REALTIME_TOOL_CONTRACTS), RT_TOOL_NAMES);
  assert.equal(new Set(definitions.map((d) => d.name)).size, 9);
  for (const [name, contract] of Object.entries(REALTIME_TOOL_CONTRACTS)) {
    assert.equal(contract.parameters.type, 'object');
    assert.equal(contract.parameters.additionalProperties, false);
    assert.equal(contract.output.schema.type, 'object');
    assert.equal(contract.output.schema.additionalProperties, false);
  }
  for (const definition of definitions) {
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.output.schema.additionalProperties, false);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('每个 RT 工具独立安全注册：一个定义失败不拖垮其余 8 个', () => {
  const names = [];
  const host = registerRealtimeTools({
    config: {},
    defineTracedTool(definition) {
      if (definition.name === 'realtime_calibrate') throw new Error('schema rejected');
      return definition;
    },
    safeRegister(definition) { names.push(definition.name); return true; },
    logger: { warn() {}, error() {} },
  });
  assert.ok(host);
  assert.deepEqual(names, RT_TOOL_NAMES.filter((name) => name !== 'realtime_calibrate'));
});

test('Worker 路径未配置时明确 degraded，不启动 factory，也不伪造 shadow run', async () => {
  let factories = 0;
  const host = createRealtimeHost({
    env: {},
    config: { worker: { bundled: false } },
    clientFactory: null,
    releaseTool: async () => { throw new Error('must not release a run that never existed'); },
  });
  const targets = await host.targets({}, exec());
  assert.equal(targets.degraded, true);
  assert.equal(targets.code, 'RT_WORKER_NOT_CONFIGURED');
  assert.deepEqual(targets.targets, []);
  const run = await host.run({ skill: 'rhythm-basic', target: { id: 'w1', kind: 'window' } }, exec());
  assert.equal(run.degraded, true);
  assert.equal(run.state, 'degraded');
  assert.equal(run.runId, undefined);
  assert.equal(factories, 0);
});

test('注入 fake Worker 后 9 个工具走 RT 控制面；sessionId 与慢环引用正确，绝不走 PowerShell call', async () => {
  const clients = [];
  const { host, byName } = register({
    clientFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
    verifyHilTarget: async () => ({ ok: true }),
  });
  const invoke = (name, args = {}) => byName.get(name).execute(args, exec('rt-session'));
  const targets = await invoke('realtime_targets');
  assert.equal(targets.degraded, false);
  assert.equal(targets.targets[0].id, 'hil-1');
  assert.equal((await invoke('realtime_skill_validate', { skill: 'rhythm-basic', target: HIL })).result.valid, true);
  assert.equal((await invoke('realtime_calibrate', { target: HIL })).result.calibrated, true);

  const run = await invoke('realtime_run', { skill: 'rhythm-basic', target: { id: 'w1', kind: 'window' } });
  assert.equal(run.degraded, false);
  assert.equal(run.mode, 'shadow');
  assert.equal(run.sessionId, 'rt-session');
  const status = await invoke('realtime_status', { runId: run.runId });
  assert.equal(status.record.runId, run.runId);
  assert.equal(status.live.worker, true);
  const snapshot = await invoke('realtime_snapshot', { runId: run.runId });
  assert.equal(snapshot.snapshot.path, 'slow-ring/frame-7.png');
  assert.equal(snapshot.snapshot.attachmentId, 'sha256:frame-7');
  const replay = await invoke('realtime_replay', { tracePath: 'trace.ndjson' });
  assert.equal(replay.mode, 'replay');
  assert.equal(replay.result.events, 3);
  const trace = await invoke('realtime_trace_read', { tracePath: 'trace.ndjson', offset: 4, limit: 10 });
  assert.equal(trace.result.offset, 4);
  assert.equal(trace.result.events.length, 1);
  assert.equal((await invoke('realtime_stop', { runId: run.runId })).state, 'stopped');

  const client = clients[0];
  assert.ok(client.requests.some((r) => r.cmd === 'run' && r.args.sessionId === 'rt-session'));
  assert.ok(client.requests.some((r) => r.cmd === 'status' && r.args.sessionId === 'rt-session'));
  assert.ok(client.requests.some((r) => r.cmd === 'snapshot' && r.args.sessionId === 'rt-session'));
  assert.ok(client.requests.some((r) => r.cmd === 'trace_read' && r.args.tracePath === 'trace.ndjson'));
  await host.dispose();
});

test('宿主在 controller 构造时绑定真实 sessionId，而不是依赖事后改写记录', async () => {
  let constructedSessionId;
  const host = createRealtimeHost({
    clientFactory: () => new FakeClient(),
    config: { controllerOptions: { sessionId: 'untrusted-override' } },
    controllerFactory(options) {
      constructedSessionId = options.sessionId;
      return createRealtimeController(options);
    },
  });
  const result = await host.run({ skill: 'rhythm-basic', target: { id: 'w1', kind: 'window' } }, exec('rt-constructed-session'));
  assert.equal(constructedSessionId, 'rt-constructed-session');
  assert.equal(result.sessionId, 'rt-constructed-session');
  await host.dispose();
});

test('active 必须同时有目标匹配的显式授权与独立 HIL 验证器；宿主 chip 不是验证器', async () => {
  const clients = [];
  const verified = [];
  const host = createRealtimeHost({
    clientFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
    verifyHilTarget: async (target) => { verified.push(target.id); return { ok: target.id === 'hil-1', reason: 'not the authorized HIL fixture' }; },
    releaseTool: async () => ({ released: true }),
    requireGrant: () => { throw new Error('the computer chip must not replace HIL authorization'); },
  });
  await assert.rejects(host.run({ skill: 's', mode: 'active', target: HIL }, exec()), (err) => err.code === 'NOT_AUTHORIZED');
  await assert.rejects(host.run({ skill: 's', mode: 'active', target: HIL, authorization: { granted: true, targetId: 'other' } }, exec()), (err) => err.code === 'NOT_AUTHORIZED');
  await assert.rejects(host.run({ skill: 's', mode: 'active', target: { id: 'hil-2', kind: 'hil' }, authorization: { granted: true, targetId: 'hil-2', expiresAtMs: Date.now() + 60_000 } }, exec()), (err) => err.code === 'NOT_AUTHORIZED');
  assert.equal(clients[0].requests.filter((r) => r.cmd === 'run').length, 0);
  const accepted = await host.run({ skill: 's', mode: 'active', target: HIL, authorization: { granted: true, targetId: 'hil-1', expiresAtMs: Date.now() + 60_000 } }, exec());
  assert.equal(accepted.mode, 'active');
  assert.deepEqual(verified, ['hil-2', 'hil-1']);
  assert.doesNotThrow(() => JSON.stringify(accepted), 'active run must not expose circular Timeout handles');
  assert.equal(JSON.parse(JSON.stringify(accepted)).heartbeatTimer, undefined);
  const status = await host.status({ runId: accepted.runId }, exec());
  assert.doesNotThrow(() => JSON.stringify(status), 'active status must remain JSON serializable');
  const stopped = await host.stop({ runId: accepted.runId }, exec());
  assert.doesNotThrow(() => JSON.stringify(stopped), 'active stop must remain JSON serializable');
  await host.dispose();
});

test('worker 异步事件直接推进已有 run；snapshot 只返回慢环引用，不产生逐帧公开事件工具', async () => {
  const client = new FakeClient();
  const host = createRealtimeHost({ clientFactory: () => client, releaseTool: async () => ({ released: true }) });
  const run = await host.run({ skill: 's', target: { id: 'w1', kind: 'window' } }, exec());
  const localRunId = client.requests.find((request) => request.cmd === 'run').args.runId;
  assert.notEqual(localRunId, run.runId, 'public ids are session-scoped; Worker events retain local protocol ids');
  client.eventHandler({ rt: 'event', event: 'state', runId: localRunId, eventSeq: 1, sourceEpoch: 1, state: 'calibrating' });
  const status = await host.status({ runId: run.runId }, exec());
  assert.equal(status.record.state, 'calibrating');
  const snapshot = await host.snapshot({ runId: run.runId }, exec());
  assert.deepEqual(Object.keys(snapshot).sort(), ['degraded', 'runId', 'snapshot']);
  assert.equal(snapshot.snapshot.path, 'slow-ring/frame-7.png');
  assert.equal(RT_TOOL_NAMES.some((name) => /event|frame|attachment/.test(name)), false);
  await host.dispose();
});

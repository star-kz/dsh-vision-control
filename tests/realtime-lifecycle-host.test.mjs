import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RT_TOOL_NAMES } from '../realtime/contracts.mjs';
import { ALL_MANAGED_TOOL_NAMES } from '../internal/modes.mjs';
import { PowerShellBackend } from '../backend/bridge.js';
import { createWatchRuntimeFacade } from '../see/apply.mjs';

// Boot the real apply() against a tiny, temporary host-package double. This tests the
// production entry point without importing a checkout-specific DSH installation.
const hostModules = await mkdtemp(join(tmpdir(), 'rt-host-modules-'));
for (const [name, source] of [
  ['dsh-tools', 'export const defineTool = (definition) => definition;\n'],
  ['dsh-scope', 'export const scopeOf = (ctx) => ctx;\n'],
]) {
  const root = join(hostModules, '@deepseek-ai', name);
  await mkdir(join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0-test', type: 'module', main: './lib/index.js' }));
  await writeFile(join(root, 'lib', 'index.js'), source);
}
process.env.DSH_APP_MODULES = hostModules;
const { apply } = await import('../index.js');

const tempRoots = [hostModules];
async function mount(t, realtime = {}, extra = {}, harness = {}) {
  const shotDir = await mkdtemp(join(tmpdir(), 'rt-host-shots-'));
  tempRoots.push(shotDir);
  const tools = new Map();
  const disposers = [];
  const root = {};
  const routes = new Map();
  const promptContexts = [];
  const eventHandlers = new Map();
  const deniedSchemas = new Set();
  const ctx = {
    root,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) { tools.set(definition.name, definition); return definition; },
      get(name) { return deniedSchemas.has(name) ? undefined : tools.get(name); },
      restrict({ deny = [] } = {}) {
        if (!harness.filteringTools) return () => {};
        for (const name of deny) deniedSchemas.add(name);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          for (const name of deny) deniedSchemas.delete(name);
        };
      },
    },
    get() { return undefined; },
    inject(names, fn) {
      if (harness.webServer && names.includes('webServer')) fn(ctx);
      return () => {};
    },
    on(name, handler) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
      return () => {};
    },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
  };
  if (harness.webServer) {
    ctx.webServer = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } };
  }
  if (harness.systemPrompt) {
    ctx.systemPrompt = { context(definition) { promptContexts.push(definition); return () => {}; } };
  }
  // These lifecycle tests exercise RT ownership/cleanup, not the mode gate.
  // Opt their sessions into control explicitly; mode-denial coverage lives separately.
  apply(ctx, {
    defaultEnabled: true,
    shotDir,
    auditLog: false,
    browser: false,
    appLaunch: { enabled: false },
    tokenGuard: { enabled: false },
    realtime,
    ...extra,
  });
  t.after(async () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { await dispose?.(); } catch { /* teardown assertions are made in the test body */ }
    }
  });
  const emit = (name, payload) => { for (const handler of eventHandlers.get(name) ?? []) handler(payload); };
  return { ctx, tools, disposers, routes, promptContexts, emit };
}

test.after(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
});

class HostFakeWorker {
  constructor() { this.state = 'ready'; this.requests = []; this.disposed = 0; this.sequence = 0; this.listeners = new Set(); }
  async start() { return this; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onExit() { return () => {}; }
  onHealthChange() { return () => {}; }
  async dispose() { this.disposed += 1; this.state = 'disposed'; }
  async request(command, args = {}) {
    this.requests.push({ command, args });
    if (command === 'run') {
      this.sequence += 1;
      const runId = args.runId;
      return { runId, state: 'running', dispatched: true, lease: { held: args.mode === 'active', token: `lease-${runId}` } };
    }
    if (command === 'stop') return { runId: args.runId, state: 'stopped', released: true, estopAcked: true };
    if (command === 'status') return { runId: args.runId, state: 'running' };
    if (command === 'snapshot') return { runId: args.runId, path: 'shots/slow.png', attachment: { attachmentId: 'slow-1' } };
    return { runId: args.runId, ok: true };
  }
}

// Match WorkerTargetCatalog's real native identity, including a hex letter.
const HIL = { id: 'hil-2a', kind: 'hil', handle: 42 };
const activeArgs = {
  mode: 'active', skill: 'rhythm-basic', target: HIL, deadlineMs: 10_000,
  authorization: { granted: true, targetId: HIL.id, expiresAtMs: Date.now() + 60_000 },
};
const execFor = (id) => ({ agent: { session: { id, header: {} } }, callId: `call-${id}` });

test('computer_stop 即使 release_input=false 也停止所有 session 的 RT run，随后允许新 run', async (t) => {
  const workers = [];
  const { tools } = await mount(t, {
    clientFactory: () => { const worker = new HostFakeWorker(); workers.push(worker); return worker; },
    verifyHilTarget: async () => ({ ok: true }),
  });
  const exec = execFor('host-stop');
  const first = await tools.get('realtime_run').execute(activeArgs, exec);
  assert.equal(first.degraded, false);
  const other = await tools.get('realtime_run').execute({ ...activeArgs, mode: 'shadow', authorization: undefined }, execFor('other-session'));
  assert.notEqual(other.runId, first.runId, 'same-millisecond controller ids must not collide across sessions');
  const result = await tools.get('computer_stop').execute({ release_input: false, disable_capability: false }, exec);
  const requests = workers.flatMap((worker) => worker.requests);
  assert.equal(requests.filter((entry) => entry.command === 'stop').length, 2, JSON.stringify({ result, requests }));
  assert.equal(result.cancelled, 2);
  assert.match(result.note, /realtime/i);
  const second = await tools.get('realtime_run').execute(activeArgs, exec);
  assert.equal(second.degraded, false, 'ordinary computer_stop is not a permanent session revocation');
  assert.notEqual(second.runId, first.runId);
});

test('realtime status/stop/snapshot 按 session 隔离已知 run，不泄露也不跨session操控', async (t) => {
  const worker = new HostFakeWorker();
  const { tools } = await mount(t, { clientFactory: () => worker });
  const started = await tools.get('realtime_run').execute(
    { mode: 'shadow', skill: 'rhythm-basic', target: { id: 'monitor-1', kind: 'monitor' } },
    execFor('owner-session'),
  );
  assert.equal(started.degraded, false);
  const before = worker.requests.length;
  for (const name of ['realtime_status', 'realtime_stop', 'realtime_snapshot']) {
    const result = await tools.get(name).execute({ runId: started.runId }, execFor('intruder-session'));
    assert.equal(result.code, 'STALE_RUN', name + ': ' + JSON.stringify(result));
    assert.equal(result.degraded, false, '所有权拒绝不是 Worker 降级');
  }
  assert.equal(worker.requests.length, before, '跨session请求不得到达Worker');
  const owner = await tools.get('realtime_status').execute({ runId: started.runId }, execFor('owner-session'));
  assert.equal(owner.degraded, false);
  assert.equal(owner.record.state, 'running');
});

test('disable_capability 经 revokeSession 永久撤销当前 RT session，不影响其他 session', async (t) => {
  const workers = [];
  const { tools } = await mount(t, {
    clientFactory: () => { const worker = new HostFakeWorker(); workers.push(worker); return worker; },
    verifyHilTarget: async () => ({ ok: true }),
  });
  const exec = execFor('revoke-me');
  await tools.get('realtime_run').execute(activeArgs, exec);
  const result = await tools.get('computer_stop').execute({ release_input: false, disable_capability: true }, exec);
  assert.equal(result.disabled, true);
  assert.match(result.note, /realtime/i);
  await assert.rejects(
    tools.get('realtime_run').execute({ ...activeArgs, mode: 'shadow', authorization: undefined }, exec),
    (error) => /\[NOT_AUTHORIZED\]/.test(error.message),
  );
  const other = await tools.get('realtime_run').execute(
    { ...activeArgs, mode: 'shadow', authorization: undefined },
    execFor('still-allowed'),
  );
  assert.equal(other.degraded, false);
  assert.equal(workers[0].requests.filter((request) => request.command === 'stop').length, 1);
});

test('直接 computer_stop 禁用立即隐藏全部 managed schema，无需等待下一次拒绝', async (t) => {
  const originalStart = PowerShellBackend.prototype.start;
  PowerShellBackend.prototype.start = async function () { throw new Error('TEST_NO_DESKTOP_WORKER'); };
  t.after(() => { PowerShellBackend.prototype.start = originalStart; });
  const { ctx, tools, emit } = await mount(t, { worker: { bundled: false } }, {}, { filteringTools: true });
  const exec = { ...execFor('direct-stop-schemas'), agent: { ...execFor('direct-stop-schemas').agent, ctx } };
  emit('agent/created', { agent: exec.agent });
  const initiallyVisible = ALL_MANAGED_TOOL_NAMES.filter((name) => ctx.tools.get(name) !== undefined);
  assert.ok(initiallyVisible.length >= 25, 'this fixture must begin with the managed tools advertised');
  const result = await tools.get('computer_stop').execute({ release_input: false, disable_capability: true }, exec);
  assert.equal(result.disabled, true);
  assert.equal(result.releaseConfirmed, false, 'the synthetic backend failure must remain honest');
  assert.deepEqual(ALL_MANAGED_TOOL_NAMES.filter((name) => ctx.tools.get(name) !== undefined), []);
});

test('直接禁用先同步隐藏工具，并与后续 HTTP 启用共用顺序队列', async (t) => {
  let releaseStop;
  let markStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const stopStarted = new Promise((resolve) => { markStop = resolve; });
  class GatedWorker extends HostFakeWorker {
    async request(command, args = {}) {
      if (command === 'stop') { markStop(); await stopGate; }
      return super.request(command, args);
    }
  }
  const originalStart = PowerShellBackend.prototype.start;
  PowerShellBackend.prototype.start = async function () { throw new Error('REVIEW_NO_DESKTOP_WORKER'); };
  t.after(() => { PowerShellBackend.prototype.start = originalStart; releaseStop(); });
  const { ctx, tools, routes, emit } = await mount(t, {
    clientFactory: () => new GatedWorker(), verifyHilTarget: async () => ({ ok: true }),
  }, { defaultEnabled: true }, { filteringTools: true, webServer: true });
  const exec = { ...execFor('direct-queue'), agent: { ...execFor('direct-queue').agent, ctx } };
  emit('agent/created', { agent: exec.agent });
  const active = await tools.get('realtime_run').execute(activeArgs, exec);
  assert.equal(active.state, 'running');
  const stopping = tools.get('computer_stop').execute({ release_input: false, disable_capability: true }, exec);
  await stopStarted;
  const during = await callStateRoute(routes.get('/computer-use/state'), { sessionId: 'direct-queue' });
  assert.equal(during.body.mode, 'disabled');
  assert.equal(ALL_MANAGED_TOOL_NAMES.filter((name) => ctx.tools.get(name) !== undefined).length, 0);
  await assert.rejects(
    tools.get('computer_actions').execute({ steps: [{ action: 'click', x: 1, y: 1 }] }, exec),
    /NOT_AUTHORIZED/,
  );
  const enabling = callStateRoute(routes.get('/computer-use/state'), {
    method: 'POST', body: { sessionId: 'direct-queue', mode: 'control' }, sessionId: 'direct-queue',
  });
  let enableSettled = false;
  void enabling.finally(() => { enableSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(enableSettled, false, 'later HTTP enable must wait for the direct stop');
  releaseStop();
  const stopped = await stopping;
  assert.equal(stopped.disabled, true);
  const enabled = await enabling;
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.mode, 'control', 'the later enable must be the final authoritative state');
  assert.ok(ALL_MANAGED_TOOL_NAMES.filter((name) => ctx.tools.get(name) !== undefined).length >= 25);
});

test('禁用当前 session 不取消其他 session 的 legacy release 请求', async (t) => {
  const original = {
    start: PowerShellBackend.prototype.start,
    request: PowerShellBackend.prototype.request,
    cancelAll: PowerShellBackend.prototype.cancelAll,
    cancelSession: PowerShellBackend.prototype.cancelSession,
  };
  const pending = [];
  // startWithRetry ignores the return value and the host accepts a minimal worker
  // with no advertised metadata; info is a getter-only property and must not be assigned.
  PowerShellBackend.prototype.start = async function () { return {}; };
  PowerShellBackend.prototype.request = function (command, _args = {}, options = {}) {
    if (command === 'release' && options.sessionKey === 'other-control') {
      return new Promise((resolve, reject) => pending.push({ sessionKey: options.sessionKey, resolve, reject }));
    }
    if (command === 'release') return Promise.resolve({ released: [], count: 0 });
    return Promise.resolve({});
  };
  PowerShellBackend.prototype.cancelAll = function (reason) {
    const entries = pending.splice(0);
    for (const entry of entries) entry.reject(new Error(reason + '; REVIEW_CROSS_SESSION_CANCEL'));
    return entries.length;
  };
  PowerShellBackend.prototype.cancelSession = function (sessionKey, reason) {
    const entries = pending.filter((entry) => entry.sessionKey === sessionKey);
    for (const entry of entries) entry.reject(new Error(reason));
    return entries.length;
  };
  t.after(() => {
    PowerShellBackend.prototype.start = original.start;
    PowerShellBackend.prototype.request = original.request;
    PowerShellBackend.prototype.cancelAll = original.cancelAll;
    if (original.cancelSession === undefined) delete PowerShellBackend.prototype.cancelSession;
    else PowerShellBackend.prototype.cancelSession = original.cancelSession;
    for (const entry of pending.splice(0)) entry.resolve({ released: [], count: 0 });
  });
  const { tools } = await mount(t, { worker: { bundled: false } });
  let otherSettled = false;
  const other = tools.get('computer_stop').execute(
    { release_input: true, disable_capability: false }, execFor('other-control'),
  ).finally(() => { otherSettled = true; });
  for (let i = 0; i < 100 && pending.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pending.length, 1, 'the other session release must be in flight');
  const current = await tools.get('computer_stop').execute(
    { release_input: false, disable_capability: true }, execFor('revoke-me'),
  );
  assert.equal(current.disabled, true);
  assert.equal(current.cancelled, 0, 'no request belongs to the revoking session');
  assert.equal(otherSettled, false, 'the other session must not be rejected by this revoke');
  pending.splice(0).forEach((entry) => entry.resolve({ released: [], count: 0 }));
  assert.equal((await other).releaseConfirmed, true);
});

test('插件 dispose 停止 RT runs 并关闭 fake Worker，且重复 dispose 不重复 estop', async (t) => {
  const worker = new HostFakeWorker();
  const { tools, disposers } = await mount(t, {
    clientFactory: () => worker,
    verifyHilTarget: async () => ({ ok: true }),
  });
  await tools.get('realtime_run').execute(activeArgs, execFor('host-dispose'));
  await tools.get('realtime_run').execute({ ...activeArgs, mode: 'shadow', authorization: undefined }, execFor('host-dispose'));
  const pending = disposers.splice(0).reverse();
  for (const dispose of pending) await dispose?.();
  assert.equal(worker.requests.filter((entry) => entry.command === 'stop').length, 2);
  assert.equal(worker.disposed, 1);
});

test('真实慢速写与 RT active 双向互斥，backend 启动失败也释放 RT 写预约', async (t) => {
  const worker = new HostFakeWorker();
  const originalStart = PowerShellBackend.prototype.start;
  PowerShellBackend.prototype.start = async function () { throw new Error('TEST_BACKEND_START_SENTINEL'); };
  t.after(() => { PowerShellBackend.prototype.start = originalStart; });
  const { tools } = await mount(t, {
    clientFactory: () => worker,
    verifyHilTarget: async () => ({ ok: true }),
  }, { defaultEnabled: true });
  const exec = execFor('host-write-mutex');
  const first = await tools.get('realtime_run').execute(activeArgs, exec);
  const legacyWrite = () => tools.get('computer_actions').execute({
    steps: [{ action: 'click', x: 1, y: 1 }], state: { hwnd: 42 }, evidence: false,
  }, exec);
  await assert.rejects(legacyWrite, /RT_TARGET_BUSY/);
  await tools.get('realtime_stop').execute({ runId: first.runId }, exec);
  await assert.rejects(legacyWrite, /TEST_BACKEND_START_SENTINEL/);
  const second = await tools.get('realtime_run').execute(activeArgs, exec);
  assert.equal(second.degraded, false, 'failed legacy startup must not leak a slow-write reservation');
});

test('真实 apply 注册冻结 9 个 RT schema，旧工具仍在；未配置 Worker 明确 degraded', async (t) => {
  const { tools } = await mount(t, { worker: { bundled: false } });
  const names = [...tools.keys()];
  for (const name of ['computer_screenshot', 'computer_actions', 'computer_ui', 'computer_ui_action', 'computer_stop', 'computer_watch']) {
    assert.ok(tools.has(name), `legacy tool ${name} must survive RT registration`);
  }
  assert.deepEqual(names.filter((name) => name.startsWith('realtime_')), RT_TOOL_NAMES);
  assert.equal(names.filter((name) => name.startsWith('realtime_')).length, 9, 'no tenth synonym');
  const result = await tools.get('realtime_targets').execute({}, { agent: { session: { id: 'host-degraded' } } });
  assert.equal(result.degraded, true);
  assert.equal(result.code, 'RT_WORKER_NOT_CONFIGURED');
});


async function callStateRoute(route, { method = 'GET', body, sessionId = 'route-mode' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = '/computer-use/state?sessionId=' + encodeURIComponent(sessionId);
  req.headers = {
    host: '127.0.0.1',
    'x-dsh-computer-use': '1',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  let status = 0;
  let text = '';
  const res = {
    writeHead(value) { status = value; },
    end(value) { text = String(value ?? ''); },
  };
  await route.handler(req, res);
  return { status, body: JSON.parse(text) };
}

test('真实 apply 路由、执行门禁和动态提示词共同执行三态', async (t) => {
  const { tools, routes, promptContexts } = await mount(
    t,
    { worker: { bundled: false } },
    { defaultEnabled: false },
    { webServer: true, systemPrompt: true },
  );
  const route = routes.get('/computer-use/state');
  assert.ok(route, 'state route is registered');
  const exec = execFor('route-mode');
  const prompt = () => promptContexts[0].text({ agent: exec.agent });

  assert.equal(prompt(), '', 'disabled contributes no computer prompt');
  await assert.rejects(tools.get('realtime_targets').execute({}, exec), /\[NOT_AUTHORIZED\]/);

  const watched = await callStateRoute(route, { method: 'POST', body: { sessionId: 'route-mode', mode: 'watch' } });
  assert.equal(watched.status, 200);
  assert.equal(watched.body.mode, 'watch');
  assert.equal(watched.body.enabled, true);
  assert.equal(watched.body.controlEnabled, false);
  assert.match(prompt(), /仅观看/);
  assert.doesNotMatch(prompt(), /观看\+操作模式已开启/);
  const observed = await tools.get('realtime_targets').execute({}, exec);
  assert.equal(observed.code, 'RT_WORKER_NOT_CONFIGURED', 'watch passed the mode gate before Worker discovery');
  await assert.rejects(
    tools.get('realtime_run').execute({ mode: 'active' }, exec),
    /\[CONTROL_REQUIRED\]/,
  );
  await assert.rejects(
    tools.get('computer_actions').execute({ steps: [{ action: 'click', x: 1, y: 1 }] }, exec),
    /\[CONTROL_REQUIRED\]/,
  );

  const controlled = await callStateRoute(route, { method: 'POST', body: { sessionId: 'route-mode', enabled: true } });
  assert.equal(controlled.body.mode, 'control', 'legacy true maps to control');
  assert.equal(controlled.body.controlEnabled, true);
  assert.match(prompt(), /观看\+操作/);

  const disabled = await callStateRoute(route, { method: 'POST', body: { sessionId: 'route-mode', mode: 'disabled' } });
  assert.equal(disabled.body.mode, 'disabled');
  assert.equal(disabled.body.enabled, false);
  assert.equal(prompt(), '');
  await assert.rejects(tools.get('realtime_targets').execute({}, exec), /\[NOT_AUTHORIZED\]/);

  const ambiguous = await callStateRoute(route, { method: 'POST', body: { sessionId: 'route-mode', mode: 'watch', enabled: true } });
  assert.equal(ambiguous.status, 400);
});

test('真实 watch 状态路由投影盯屏、停止采集，并在 disabled 时清理', async (t) => {
  let running = true;
  let stops = 0;
  const watchRuntime = {
    status: () => ({ running, source: 'screen', since: 12, quality: 'balanced', frames: 30 }),
    stop: () => { stops += 1; running = false; return { stopped: true }; },
  };
  const { routes } = await mount(t, { worker: { bundled: false } }, { watchRuntime }, { webServer: true });
  const state = routes.get('/computer-use/state');
  const initial = await callStateRoute(state, { sessionId: 'watch-route' });
  assert.equal(initial.body.control.state, 'watching');
  assert.equal(initial.body.control.watch.alive, true);
  assert.equal(initial.body.control.watch.seconds, 12);
  const watchRoute = routes.get('/computer-use/watch');
  assert.ok(watchRoute, 'client stop button must have a real backend route');
  const stopped = await callStateRoute(watchRoute, {
    method: 'POST', body: { sessionId: 'watch-route', action: 'stop' }, sessionId: 'watch-route',
  });
  assert.equal(stopped.status, 200);
  assert.equal(stops, 1);
  assert.equal(stopped.body.control.watch.alive, false);
  running = true;
  const disabled = await callStateRoute(state, {
    method: 'POST', body: { sessionId: 'watch-route', mode: 'disabled' }, sessionId: 'watch-route',
  });
  assert.equal(disabled.status, 200);
  assert.equal(stops, 2, 'disabled also stops the legacy continuous watch');
  assert.equal(disabled.body.control.watch.alive, false);
  const refused = await callStateRoute(watchRoute, {
    method: 'POST', body: { sessionId: 'watch-route', action: 'stop' }, sessionId: 'watch-route',
  });
  assert.equal(refused.status, 409);
  assert.equal(stops, 2, 'disabled requests have no watch side effects');
});

test('watch 采集由单 session 持有，其他 session 不能加入、停止或禁用', async (t) => {
  let running = true;
  let physicalStops = 0;
  const watchRuntime = createWatchRuntimeFacade({
    status: () => ({ running, source: { kind: 'screen' }, since: 5 }),
    stop: () => { physicalStops += 1; running = false; return { stopped: true }; },
  });
  watchRuntime.subscribe('watch-a');
  assert.throws(() => watchRuntime.subscribe('watch-b'), /another session/);
  const { routes } = await mount(t, { worker: { bundled: false } }, { watchRuntime }, { webServer: true });
  const state = routes.get('/computer-use/state');
  assert.equal((await callStateRoute(state, { sessionId: 'watch-a' })).body.control.state, 'watching');
  assert.equal((await callStateRoute(state, { sessionId: 'watch-b' })).body.control.watch.alive, false);
  const stopped = await callStateRoute(routes.get('/computer-use/watch'), {
    method: 'POST', body: { sessionId: 'watch-b', action: 'stop' }, sessionId: 'watch-b',
  });
  assert.equal(stopped.status, 200);
  assert.equal(physicalStops, 0, 'B cannot stop A');
  assert.equal((await callStateRoute(state, { sessionId: 'watch-a' })).body.control.watch.alive, true);
  const disabled = await callStateRoute(state, {
    method: 'POST', body: { sessionId: 'watch-b', mode: 'disabled' }, sessionId: 'watch-b',
  });
  assert.equal(disabled.status, 200);
  assert.equal(physicalStops, 0, 'disabling B cannot stop A');
  const ownerDisabled = await callStateRoute(state, {
    method: 'POST', body: { sessionId: 'watch-a', mode: 'disabled' }, sessionId: 'watch-a',
  });
  assert.equal(ownerDisabled.status, 200);
  assert.equal(physicalStops, 1, 'owner disable stops the physical runner');
});

test('同 session 的禁用后启用按到达顺序串行提交，最终 schema 必须恢复', async (t) => {
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  class GatedWorker extends HostFakeWorker {
    async request(command, args = {}) {
      if (command === 'stop') await stopGate;
      return super.request(command, args);
    }
  }
  const { tools, routes, emit } = await mount(t, {
    clientFactory: () => new GatedWorker(), verifyHilTarget: async () => ({ ok: true }),
  }, { defaultEnabled: true }, { webServer: true });
  emit('agent/created', { agent: execFor('serial-mode').agent });
  const first = await tools.get('realtime_run').execute(activeArgs, execFor('serial-mode'));
  assert.equal(first.state, 'running');
  const state = routes.get('/computer-use/state');
  const disabling = callStateRoute(state, {
    method: 'POST', body: { sessionId: 'serial-mode', mode: 'disabled' }, sessionId: 'serial-mode',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const enabling = callStateRoute(state, {
    method: 'POST', body: { sessionId: 'serial-mode', mode: 'control' }, sessionId: 'serial-mode',
  });
  releaseStop();
  const [, enabled] = await Promise.all([disabling, enabling]);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.mode, 'control');
  assert.equal(enabled.body.toolSchemas, 'visible');
  const restarted = await tools.get('realtime_run').execute(activeArgs, execFor('serial-mode'));
  assert.equal(restarted.state, 'running', JSON.stringify(restarted));
  assert.notEqual(restarted.runId, first.runId);
});

function failLegacyBackendStart(t) {
  const originalStart = PowerShellBackend.prototype.start;
  PowerShellBackend.prototype.start = async function () { throw new Error('TEST_TRANSITION_BACKEND_STOP'); };
  t.after(() => { PowerShellBackend.prototype.start = originalStart; });
}

test('control → watch 先停止 active/在飞写并 dispose Worker，再开放只读观察', async (t) => {
  failLegacyBackendStart(t);
  const workers = [];
  const { tools, routes } = await mount(t, {
    clientFactory: () => { const worker = new HostFakeWorker(); workers.push(worker); return worker; },
    verifyHilTarget: async () => ({ ok: true }),
  }, { defaultEnabled: true }, { webServer: true });
  const exec = execFor('transition-watch');
  const active = await tools.get('realtime_run').execute(activeArgs, exec);
  assert.equal(active.state, 'running');
  const watched = await callStateRoute(routes.get('/computer-use/state'), {
    method: 'POST', body: { sessionId: 'transition-watch', mode: 'watch' }, sessionId: 'transition-watch',
  });
  assert.equal(watched.status, 409, 'legacy release failure must not be reported as a clean transition');
  assert.equal(watched.body.mode, 'watch', 'the authoritative session mode is still watch');
  assert.equal(watched.body.ok, false);
  assert.match(watched.body.error, /TEST_TRANSITION_BACKEND_STOP/);
  assert.equal(workers[0].requests.filter((entry) => entry.command === 'stop').length, 1);
  assert.equal(workers[0].disposed, 1);
  const status = await tools.get('realtime_status').execute({ runId: active.runId }, exec);
  assert.equal(status.record.state, 'stopped');
  await assert.rejects(tools.get('realtime_run').execute(activeArgs, exec), /\[CONTROL_REQUIRED\]/);
});

test('disabled → watch/control 是显式恢复：清撤销标记并允许新 shadow/active run', async (t) => {
  failLegacyBackendStart(t);
  const workers = [];
  const { tools, routes } = await mount(t, {
    clientFactory: () => { const worker = new HostFakeWorker(); workers.push(worker); return worker; },
    verifyHilTarget: async () => ({ ok: true }),
  }, { defaultEnabled: true }, { webServer: true });
  const route = routes.get('/computer-use/state');
  const exec = execFor('transition-reenable');
  const transition = (mode) => callStateRoute(route, {
    method: 'POST', body: { sessionId: 'transition-reenable', mode }, sessionId: 'transition-reenable',
  });
  await transition('disabled');
  await transition('watch');
  const shadow = await tools.get('realtime_run').execute({
    mode: 'shadow', skill: 'rhythm-basic', target: HIL, deadlineMs: 10_000,
  }, exec);
  assert.equal(shadow.degraded, false, 'disabled → watch must clear the old RT revocation');
  await transition('disabled');
  await transition('control');
  const active = await tools.get('realtime_run').execute(activeArgs, exec);
  assert.equal(active.degraded, false, 'disabled → control must also clear the old RT revocation');
  assert.equal(active.state, 'running');
  assert.equal(workers.length, 2, 'each re-enabled session receives a fresh disposed-worker generation');
});

test('disabled 的直接 computer_stop 不得先停止其他 session 的 RT Worker', async (t) => {
  const workers = [];
  const { tools, routes } = await mount(t, {
    clientFactory: () => { const worker = new HostFakeWorker(); workers.push(worker); return worker; },
    verifyHilTarget: async () => ({ ok: true }),
  }, { defaultEnabled: true }, { webServer: true });
  const owner = execFor('stop-owner');
  const disabled = execFor('stop-disabled');
  const active = await tools.get('realtime_run').execute(activeArgs, owner);
  assert.equal(active.state, 'running');
  const off = await callStateRoute(routes.get('/computer-use/state'), {
    method: 'POST', body: { sessionId: 'stop-disabled', mode: 'disabled' }, sessionId: 'stop-disabled',
  });
  assert.equal(off.body.mode, 'disabled');
  const before = workers[0].requests.length;
  await assert.rejects(
    tools.get('computer_stop').execute({ release_input: false }, disabled),
    /\[NOT_AUTHORIZED\]/,
  );
  assert.equal(workers[0].requests.length, before, 'authorization precedes every global stop side effect');
  assert.equal(workers[0].disposed, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createRealtimeHost } from '../tools/realtime.mjs';
import { PowerShellBackend } from '../backend/bridge.js';

function deferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((res, rej) => {
    resolve = (value) => { settled = true; res(value); };
    reject = (error) => { settled = true; rej(error); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

class FakeWorker {
  constructor({ stopReleased = true, holdRunAck = false, gateStop = false, rejectRunOnDispose = false } = {}) {
    this.state = 'ready';
    this.requests = [];
    this.disposed = 0;
    this.stopReleased = stopReleased;
    this.rejectRunOnDispose = rejectRunOnDispose;
    this.runSeen = deferred();
    this.stopSeen = deferred();
    this.runAck = holdRunAck ? deferred() : null;
    this.stopGate = gateStop ? deferred() : null;
  }

  async start() { this.state = 'ready'; }
  onEvent(cb) { this.eventHandler = cb; return () => {}; }
  onExit(cb) { this.exitHandler = cb; return () => {}; }
  onHealthChange(cb) { this.healthHandler = cb; return () => {}; }

  async request(cmd, args = {}) {
    this.requests.push({ cmd, args });
    if (cmd === 'run') {
      this.runSeen.resolve(args.runId);
      if (this.runAck) return this.runAck.promise;
      return { runId: args.runId, state: 'running' };
    }
    if (cmd === 'stop') {
      this.stopSeen.resolve(args.runId);
      if (this.stopGate) await this.stopGate.promise;
      return { runId: args.runId, released: this.stopReleased };
    }
    if (cmd === 'status') return { runId: args.runId, state: 'running' };
    return { runId: args.runId, ok: true };
  }

  async dispose() {
    this.disposed += 1;
    this.state = 'disposed';
    if (this.rejectRunOnDispose && this.runAck && !this.runAck.settled) {
      this.runAck.reject(Object.assign(new Error('fake worker disposed with run ack pending'), {
        code: 'DISPOSED', dispatched: true, runId: this.requests.find((entry) => entry.cmd === 'run')?.args.runId,
      }));
    }
  }
}

const HIL = { id: 'hil-2a', kind: 'hil', handle: 42 };
const execFor = (sessionId) => ({ agent: { session: { id: sessionId, header: {} } }, callId: `call-${sessionId}` });
const activeArgs = () => ({
  mode: 'active', skill: 'rhythm-basic', target: HIL, deadlineMs: 10_000,
  authorization: { granted: true, targetId: HIL.id, expiresAtMs: Date.now() + 60_000 },
});

function hostFixture(t, options = {}) {
  const worker = new FakeWorker(options);
  const releaseCalls = [];
  const outcomes = [...(options.releaseOutcomes ?? [])];
  const host = createRealtimeHost({
    clientFactory: () => worker,
    verifyHilTarget: async () => ({ ok: true }),
    releaseTool: async (record) => {
      releaseCalls.push(record);
      const released = outcomes.length > 0 ? outcomes.shift() : false;
      return { released, detail: released ? 'independent release confirmed' : 'still-held' };
    },
  });
  t.after(async () => {
    if (worker.runAck && !worker.runAck.settled) {
      worker.runAck.resolve({ runId: worker.requests.find((entry) => entry.cmd === 'run')?.args.runId, state: 'running' });
    }
    if (worker.stopGate && !worker.stopGate.settled) worker.stopGate.resolve();
    await host.dispose();
  });
  return { host, worker, releaseCalls };
}

test('stopped-unknown survives repeated stopSession and only succeeds after real independent release', async (t) => {
  const { host, worker, releaseCalls } = hostFixture(t, {
    stopReleased: false,
    releaseOutcomes: [false, false, true],
  });
  const started = await host.run(activeArgs(), execFor('persistent-unknown'));

  const first = await host.stopSession('persistent-unknown', { reason: 'first stop' });
  assert.equal(first.ok, false);
  assert.equal(first.stopped, 0);
  assert.equal(first.unknown, 1);
  assert.equal(first.results[0].released, false);
  assert.match(first.error, /still-held/);

  const second = await host.stopSession('persistent-unknown', { reason: 'repeated stop' });
  assert.equal(second.ok, false, 'a disposed runtime must not erase its unresolved release');
  assert.equal(second.unknown, 1);
  assert.equal(second.results[0].released, false);
  assert.match(second.error, /still-held/);
  assert.equal(releaseCalls.length, 2, 'the known active lease gets one safe independent retry');

  const third = await host.stopSession('persistent-unknown', { reason: 'retry after release' });
  assert.equal(third.ok, true);
  assert.equal(third.stopped, 1);
  assert.equal(third.unknown, 0);
  assert.equal(third.results[0].released, true);
  assert.equal(third.results[0].releaseConfirmed, true);
  assert.equal(third.results[0].runId, started.runId);
  assert.equal(releaseCalls.length, 3);
  assert.equal(worker.requests.filter((entry) => entry.cmd === 'run').length, 1, 'stop never retries non-idempotent input');
  assert.equal(worker.requests.filter((entry) => entry.cmd === 'stop').length, 1);
  assert.equal(worker.disposed, 1);
});

test('concurrent stopSession callers share one stop and one Worker disposal without hiding failure', async (t) => {
  const { host, worker } = hostFixture(t, {
    stopReleased: false, gateStop: true, releaseOutcomes: [false],
  });
  await host.run(activeArgs(), execFor('concurrent-stop'));

  const firstPromise = host.stopSession('concurrent-stop');
  await worker.stopSeen.promise;
  const secondPromise = host.stopSession('concurrent-stop');
  await flush();
  assert.equal(worker.requests.filter((entry) => entry.cmd === 'stop').length, 1);
  assert.equal(worker.disposed, 0);
  worker.stopGate.resolve();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(first.unknown, 1);
  assert.equal(second.unknown, 1);
  assert.equal(worker.disposed, 1, 'concurrent failure must not double-dispose the Worker');
});

test('stopSession waits for a dispatched run ack, then stops the registered run instead of reporting an empty success', async (t) => {
  const { host, worker } = hostFixture(t, { holdRunAck: true, rejectRunOnDispose: true });
  const runOutcomePromise = host.run(activeArgs(), execFor('late-ack')).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await worker.runSeen.promise;

  let stopSettled = false;
  const stopPromise = host.stopSession('late-ack', { reason: 'stop while run ack pending' }).then((result) => {
    stopSettled = true;
    return result;
  });
  await flush();
  const settledBeforeAck = stopSettled;
  if (!worker.runAck.settled) {
    worker.runAck.resolve({ runId: worker.requests[0].args.runId, state: 'running' });
  }
  const [runOutcome, stopped] = await Promise.all([runOutcomePromise, stopPromise]);

  assert.equal(settledBeforeAck, false, 'stop must synchronize with the pending mutation');
  assert.equal(runOutcome.error, undefined, `run must not fail as ${runOutcome.error?.code}`);
  assert.equal(runOutcome.value.state, 'running');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, 1);
  assert.equal(stopped.unknown, 0);
  assert.equal(worker.requests.filter((entry) => entry.cmd === 'stop').length, 1);
  assert.equal(worker.disposed, 1);
});

test('a late dispatched-run failure retains an honest record and stop remains non-ok while release is unknown', async (t) => {
  const { host, worker } = hostFixture(t, {
    holdRunAck: true, stopReleased: false, releaseOutcomes: [false, false],
  });
  const runOutcomePromise = host.run(activeArgs(), execFor('late-failure')).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await worker.runSeen.promise;
  const stopPromise = host.stopSession('late-failure', { reason: 'stop before lost ack' });
  await flush();
  worker.runAck.reject(Object.assign(new Error('run ack lost after dispatch'), {
    code: 'ACK_LOST', dispatched: true,
  }));
  const [runOutcome, stopped] = await Promise.all([runOutcomePromise, stopPromise]);

  assert.equal(runOutcome.error?.code, 'ACK_LOST');
  assert.equal(runOutcome.error?.dispatched, true);
  assert.ok(runOutcome.error?.runId.startsWith('late-failure:'));
  assert.equal(stopped.ok, false);
  assert.equal(stopped.unknown, 1);
  assert.equal(stopped.results[0].state, 'stopped-unknown');
  assert.equal(stopped.results[0].released, false);

  const status = await host.status({ runId: runOutcome.error.runId }, execFor('late-failure'));
  assert.equal(status.record.state, 'stopped-unknown');
  assert.equal(status.record.dispatched, true);
  assert.equal(status.record.error.code, 'ACK_LOST');
  assert.equal(status.record.stop.released, false);

  const repeated = await host.stopSession('late-failure');
  assert.equal(repeated.ok, false);
  assert.equal(repeated.unknown, 1);
  assert.equal(worker.requests.filter((entry) => entry.cmd === 'run').length, 1, 'a lost ack must not cause another input dispatch');
});

// Boot the real route against tiny host-module doubles. The legacy backend is deliberately
// failed before startup, so all RT traffic in this file goes only to FakeWorker and no real
// input backend is ever started.
const hostModules = await mkdtemp(join(tmpdir(), 'rt-stop-races-modules-'));
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

test.after(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function mountRoute(t, worker) {
  const shotDir = await mkdtemp(join(tmpdir(), 'rt-stop-races-shots-'));
  tempRoots.push(shotDir);
  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const ctx = {
    root: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) { tools.set(definition.name, definition); return definition; },
      get(name) { return tools.get(name); },
      restrict() { return () => {}; },
    },
    get() { return undefined; },
    inject(names, fn) { if (names.includes('webServer')) fn(ctx); return () => {}; },
    on() { return () => {}; },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
  };
  apply(ctx, {
    defaultEnabled: true,
    shotDir,
    auditLog: false,
    browser: false,
    appLaunch: { enabled: false },
    tokenGuard: { enabled: false },
    realtime: { clientFactory: () => worker, verifyHilTarget: async () => ({ ok: true }) },
  });
  t.after(async () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { await dispose?.(); } catch { /* test body owns lifecycle assertions */ }
    }
  });
  return { tools, routes };
}

async function postMode(route, sessionId, mode) {
  const req = Readable.from([Buffer.from(JSON.stringify({ sessionId, mode }))]);
  req.method = 'POST';
  req.url = `/computer-use/state?sessionId=${encodeURIComponent(sessionId)}`;
  req.headers = { host: '127.0.0.1', 'x-dsh-computer-use': '1', 'content-type': 'application/json' };
  let status = 0;
  let text = '';
  const res = {
    writeHead(value) { status = value; },
    end(value) { text = String(value ?? ''); },
  };
  await route.handler(req, res);
  return { status, body: JSON.parse(text) };
}

test('control to watch and repeated disabled routes keep reporting unresolved RT release', async (t) => {
  const worker = new FakeWorker({ stopReleased: false });
  const originalStart = PowerShellBackend.prototype.start;
  PowerShellBackend.prototype.start = async function () { throw new Error('TEST_LEGACY_RELEASE_UNAVAILABLE'); };
  t.after(() => { PowerShellBackend.prototype.start = originalStart; });
  const { tools, routes } = await mountRoute(t, worker);
  const exec = execFor('route-persistent-stop');
  await tools.get('realtime_run').execute(activeArgs(), exec);
  const route = routes.get('/computer-use/state');

  const watched = await postMode(route, 'route-persistent-stop', 'watch');
  assert.equal(watched.status, 409);
  assert.equal(watched.body.ok, false);
  assert.match(watched.body.error, /stopped-unknown|no independent release tool configured/);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const disabled = await postMode(route, 'route-persistent-stop', 'disabled');
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.ok, false);
    assert.match(disabled.body.error, /stopped-unknown|no independent release tool configured/);
  }
  assert.equal(worker.requests.filter((entry) => entry.cmd === 'run').length, 1);
  assert.equal(worker.disposed, 1);
});

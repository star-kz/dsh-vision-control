/**
 * realtime/worker-client.mjs 传输层测试（Task 5 · RED 先行）。
 *
 * 用**真实子进程**假 Worker 做协议测试：假 Worker 是一个 Node 脚本，写在临时目录里，
 * 行为由同目录的 scenario JSON 驱动（延迟应答、挂死、自杀、停心跳、关 stdin、发垃圾行、
 * 旧 id 回包）。协议：JSONL 本地 stdio——worker 先发 hello（版本握手），host 回 welcome，
 * 之后 rt:req / rt:res / rt:event 逐行往返；帧与轨迹永远不进控制面。
 *
 * 钉住的语义（对照 plan Task 5 与 docs/worker-protocol.md §4）：
 *   - 版本握手：协议号不符 → PROTOCOL_MISMATCH 且杀掉子进程；不发 hello → START_TIMEOUT。
 *   - 乱序响应按 id 关联，不按到达顺序。
 *   - 请求超时/worker 退出后已写出 → dispatched=true（结果未知）；写失败/派发前 →
 *     dispatched=false（确定什么都没发生，可安全拒绝）。
 *   - 心跳丢失 → pending 以 HEARTBEAT_LOST 失败；新请求不再派发，但 safety 通道（stop 用的）仍可写。
 *   - 断管（Windows 现实）：worker 关 stdin 不死时，小写入被 OS 管道缓冲静默吞掉，
 *     按诚实语义记 TIMEOUT/dispatched=true（结局未知）；write 回调真报错才 WRITE_FAILED。
 *   - AbortSignal 只取消等待：写出前 ABORTED/dispatched=false，写出后 ABORTED/dispatched=true。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerClient } from '../realtime/worker-client.mjs';
import { RT_PROTOCOL_VERSION, RT_MAX_CONTROL_LINE_BYTES } from '../realtime/contracts.mjs';

const REQUIRED_CAPABILITIES = Object.freeze([
  'run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat',
]);

/**
 * 假 Worker 源码。读到一行就按 cmd 查 behaviors：
 *   {die} 自杀；{hang} 不应答；{delayMs} 延迟应答；{result} 覆盖默认回包（默认回 cmd+echo）；
 *   {staleRunId} 用旧 runId 回包；{error} 回 ok:false；{emitEvents} 借请求的 runId 发事件。
 * hello.protocol、capabilities、心跳间隔、停心跳时机、关 stdin、延迟自杀、开场的垃圾行/孤儿回包
 * 都由 scenario 配置。收到的每一行（含 welcome）记入 logPath 供断言。
 */
const FAKE_WORKER_SRC = String.raw`
import { readFileSync, appendFileSync, closeSync } from 'node:fs';
const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const logPath = scenario.logPath || null;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (line) => { if (logPath) { try { appendFileSync(logPath, line + '\n'); } catch {} } };
const caps = (scenario.hello && scenario.hello.capabilities) || ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'];
if (!scenario.silent) {
  send({
    rt: 'hello',
    protocol: (scenario.hello && scenario.hello.protocol) != null ? scenario.hello.protocol : 1,
    worker: { name: 'fake-rt-worker', version: '0.1.0-test' },
    pid: process.pid,
    capabilities: caps,
  });
}
for (const g of scenario.garbageOnStart || []) {
  setTimeout(() => process.stdout.write(g.line + '\n'), g.atMs || 50);
}
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
if (scenario.closeStdinAfterMs != null) {
  // destroy() 只销毁流对象，Windows 上不关 OS 读端句柄；再 closeSync(0) 才真正断管
  setTimeout(() => {
    try { process.stdin.destroy(); } catch {}
    try { closeSync(0); } catch {}
  }, scenario.closeStdinAfterMs);
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
      if (msg.args && msg.args.runId != null && ['run', 'status', 'stop', 'snapshot', 'replay'].includes(msg.cmd)) {
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

/** 建一套真实子进程环境：临时目录 + 假 worker 脚本 + scenario.json + client。 */
async function setup(scenario = {}, clientOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-client-'));
  const script = join(dir, 'fake-rt-worker.mjs');
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'worker-input.log');
  writeFileSync(script, FAKE_WORKER_SRC, 'utf8');
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, logPath }), 'utf8');
  const client = createWorkerClient({
    command: process.execPath,
    args: [script, scenarioPath],
    helloTimeoutMs: 10_000,
    heartbeatTimeoutMs: 0,
    ...clientOpts,
  });
  if (!scenario.manualStart && !scenario.silent && !(scenario.hello && scenario.hello.protocol != null && scenario.hello.protocol !== 1)) {
    await client.start();
  }
  const readLog = () => {
    try {
      return readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { client, dir, logPath, readLog };
}

async function cleanup(client, dir) {
  try { client.dispose(); } catch {}
  await sleep(250);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('版本握手：hello → welcome → ready；worker 收到的第一行是 welcome 且协议号一致', async () => {
  const t = await setup();
  try {
    assert.equal(t.client.state, 'ready');
    assert.equal(typeof t.client.info.pid, 'number');
    assert.equal(t.client.info.protocol, RT_PROTOCOL_VERSION);
    assert.equal(t.client.info.worker.name, 'fake-rt-worker');
    assert.ok(t.client.info.capabilities.includes('run'));
    await waitFor(() => t.readLog().length >= 1, { label: 'worker 收到 welcome' });
    const first = t.readLog()[0];
    assert.equal(first.rt, 'welcome');
    assert.equal(first.protocol, RT_PROTOCOL_VERSION);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('协议号不符：PROTOCOL_MISMATCH，子进程被杀，不自动重启', async () => {
  const t = await setup({ hello: { protocol: 99 } }, {});
  try {
    await assert.rejects(
      () => t.client.start(),
      (err) => err.code === 'PROTOCOL_MISMATCH' && /protocol 99/.test(err.message) && err.dispatched !== true,
    );
    await waitFor(() => t.client.state === 'dead', { label: 'mismatch 后子进程退出' });
    assert.equal(t.client.stats.spawns, 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('不发 hello：START_TIMEOUT，child 被清理', async () => {
  const t = await setup({ silent: true }, { helloTimeoutMs: 300 });
  try {
    await assert.rejects(() => t.client.start(), (err) => err.code === 'START_TIMEOUT');
    await waitFor(() => t.client.state === 'dead', { label: '超时后子进程退出' });
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('请求/应答按 id 关联；超时 → TIMEOUT 且 dispatched=true（已写出，结局未知）', async () => {
  const t = await setup({ behaviors: { hang: { hang: true } } });
  try {
    const res = await t.client.request('echo', { x: 7 });
    assert.equal(res.cmd, 'echo');
    assert.equal(res.echo.x, 7);
    const before = t.client.stats.dispatched;
    await assert.rejects(
      () => t.client.request('hang', {}, { timeoutMs: 200 }),
      (err) => err.code === 'TIMEOUT' && err.dispatched === true,
    );
    assert.equal(t.client.stats.dispatched, before + 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('乱序响应：慢请求后发出，快请求先回——各归各的 id，不按到达顺序结算', async () => {
  const t = await setup({
    behaviors: {
      slow: { delayMs: 350, result: { who: 'slow' } },
      fast: { result: { who: 'fast' } },
    },
  });
  try {
    const order = [];
    const slow = t.client.request('slow', { n: 1 }).then((r) => { order.push('slow'); return r; });
    const fast = t.client.request('fast', { n: 2 }).then((r) => { order.push('fast'); return r; });
    assert.equal((await fast).who, 'fast');
    assert.equal((await slow).who, 'slow');
    assert.deepEqual(order, ['fast', 'slow']);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('请求中途 worker 退出：WORKER_EXITED/dispatched=true；显式 start() 换代后新 pid 服务新请求', async () => {
  const t = await setup({ behaviors: { die: { die: true } } });
  try {
    const pid1 = t.client.info.pid;
    const err = await t.client.request('die', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('die 后请求不应成功'),
      (e) => e,
    );
    assert.equal(err.code, 'WORKER_EXITED');
    assert.equal(err.dispatched, true, '已写出的请求必须标记 unknown outcome');
    await waitFor(() => t.client.state === 'dead', { label: 'worker 退出' });
    // 传输层不得自作主张重启并重发：请求死在第一代上。
    assert.equal(t.client.stats.spawns, 1);
    const info2 = await t.client.start();
    assert.equal(t.client.stats.spawns, 2);
    assert.notEqual(info2.pid, pid1, '必须是新进程');
    const res = await t.client.request('echo', { ok: 1 });
    assert.equal(res.echo.ok, 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('worker 已死后新请求：派发前拒绝 WORKER_EXITED/dispatched=false，不写一个字节', async () => {
  const t = await setup({ behaviors: { die: { die: true } } });
  try {
    await t.client.request('die', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('不应成功'),
      (e) => assert.equal(e.code, 'WORKER_EXITED'),
    );
    await waitFor(() => t.client.state === 'dead', { label: 'worker 退出' });
    const dispatchedBefore = t.client.stats.dispatched;
    await assert.rejects(
      () => t.client.request('echo', {}),
      (err) => err.code === 'WORKER_EXITED' && err.dispatched === false,
    );
    assert.equal(t.client.stats.dispatched, dispatchedBefore, '未派发可拒绝：没有再写任何请求');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('断管（Windows 现实）：worker 关 stdin 不死 → 小写入被 OS 静默缓冲 → TIMEOUT/dispatched=true（结局未知）', async () => {
  // 平台事实（本运行时实测）：worker destroy(stdin) + closeSync(0) 后，宿主的小写入
  // 仍被 OS 管道缓冲静默吞掉、write 回调不报错；而超过管道缓冲（>64KB）的大写入在
  // 本 Windows 运行时会**原生崩溃整个 Node 进程**（libuv 崩溃，无 error 事件）。
  // 所以断管+worker 存活时，唯一诚实的结论是：已写出（dispatched=true）、无应答
  // （TIMEOUT、结局未知）——绝不能谎称 WRITE_FAILED/dispatched=false。
  // WRITE_FAILED 代码路径保留（write 回调真报错时归因），但在本平台无法用真实
  // 断管触发，属记录在案的限制（见 realtime/README.md）。
  const t = await setup({ closeStdinAfterMs: 200 });
  try {
    await sleep(450);
    await assert.rejects(
      () => t.client.request('echo', {}, { timeoutMs: 400 }),
      (err) => err.code === 'TIMEOUT' && err.dispatched === true && /outcome is unknown/i.test(err.message),
    );
    assert.equal(t.client.state, 'ready', 'worker 仍活着；无心跳监控时传输层无从发现管道已断');
    // 第二笔同样静默超时：传输层不崩、不自动重启、每笔都如实记 dispatched=true
    await assert.rejects(
      () => t.client.request('echo', {}, { timeoutMs: 300 }),
      (err) => err.code === 'TIMEOUT' && err.dispatched === true,
    );
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('心跳丢失：pending 以 HEARTBEAT_LOST/dispatched=true 失败；普通新请求拒发，safety 通道仍可写', async () => {
  const t = await setup(
    {
      hello: { capabilities: ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'] },
      heartbeatIntervalMs: 50,
      stopHeartbeatAfter: 3,
      behaviors: { hang: { hang: true } },
    },
    { heartbeatTimeoutMs: 400 },
  );
  try {
    const pending = t.client.request('hang', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('挂死请求不应成功'),
      (e) => e,
    );
    const err = await pending;
    assert.equal(err.code, 'HEARTBEAT_LOST');
    assert.equal(err.dispatched, true);
    await waitFor(() => t.client.state === 'unhealthy', { label: '进入 unhealthy' });
    await assert.rejects(
      () => t.client.request('echo', {}),
      (err) => err.code === 'HEARTBEAT_LOST' && err.dispatched === false,
    );
    // stop 用的安全通道不因心跳停跳而封死：worker 活着且 stdin 未断，就还写得进去。
    const res = await t.client.request('echo', { safety: true, via: 'estop' }, { safety: true, timeoutMs: 5_000 });
    assert.equal(res.echo.via, 'estop');
    const stopped = await t.client.stop({ runId: 'run-heartbeat-lost', sessionId: 'session-A' }, { safety: false });
    assert.equal(stopped.cmd, 'stop', 'stop 方法必须始终强制 safety 通道，即使调用方误传 safety:false');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('垃圾行 / 超长行 / 孤儿回包：计数而不崩，后续请求照常', async () => {
  const t = await setup({
    garbageOnStart: [
      { atMs: 60, line: 'this is not json' },
      { atMs: 70, line: JSON.stringify({ rt: 'res', id: 'orphan-1', ok: true, result: {} }) },
      { atMs: 80, line: 'x'.repeat(RT_MAX_CONTROL_LINE_BYTES + 2048) },
    ],
  });
  try {
    await sleep(300);
    assert.equal(t.client.stats.badLines, 1);
    assert.equal(t.client.stats.orphans, 1);
    assert.equal(t.client.stats.oversized, 1, '超长行直接拒收——控制面不是数据面');
    const res = await t.client.request('echo', { alive: true });
    assert.equal(res.echo.alive, true);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('AbortSignal：写出前 ABORTED/dispatched=false；写出后只取消等待，ABORTED/dispatched=true 且明说结局未知', async () => {
  const t = await setup({ behaviors: { hang: { hang: true } } });
  try {
    const ac = new AbortController();
    ac.abort();
    const before = t.client.stats.dispatched;
    await assert.rejects(
      () => t.client.request('echo', {}, { signal: ac.signal }),
      (err) => err.code === 'ABORTED' && err.dispatched === false,
    );
    assert.equal(t.client.stats.dispatched, before);

    const ac2 = new AbortController();
    const pending = t.client.request('hang', {}, { timeoutMs: 10_000, signal: ac2.signal }).then(
      () => assert.fail('不应成功'),
      (e) => e,
    );
    await waitFor(() => t.client.stats.dispatched === before + 1, { label: '请求已写出' });
    ac2.abort();
    const err = await pending;
    assert.equal(err.code, 'ABORTED');
    assert.equal(err.dispatched, true, '信号只取消等待，不冒充已停止');
    assert.match(err.message, /outcome is unknown|may still/i);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('dispose 后：DISPOSED，不再派发', async () => {
  const t = await setup();
  try {
    t.client.dispose();
    await assert.rejects(() => t.client.request('echo', {}), (err) => err.code === 'DISPOSED');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('worker ok:false 应答证明请求已派发：WORKER_ERROR/dispatched=true', async () => {
  const t = await setup({ behaviors: { run: { error: { code: 'WORKER_ERROR', message: 'rejected after receipt' } } } });
  try {
    const before = t.client.stats.dispatched;
    await assert.rejects(
      () => t.client.request('run', { runId: 'run-negative-ack' }),
      (err) => err.code === 'WORKER_ERROR' && err.dispatched === true,
    );
    assert.equal(t.client.stats.dispatched, before + 1);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('入站行限制按 UTF-8 字节而非 JS 字符数：多字节超限行计 oversized', async () => {
  const t = await setup({
    garbageOnStart: [{ atMs: 60, line: 'é'.repeat(RT_MAX_CONTROL_LINE_BYTES) }],
  });
  try {
    await sleep(300);
    assert.equal(t.client.stats.oversized, 1);
    assert.equal(t.client.stats.badLines, 0, '超限行必须在 JSON.parse 前拒收');
    const res = await t.client.request('echo', { alive: true });
    assert.equal(res.echo.alive, true);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('出站行限制按 UTF-8 字节：超限请求预派发拒绝且不写 worker', async () => {
  const t = await setup();
  try {
    const before = t.client.stats.dispatched;
    const payload = 'é'.repeat(RT_MAX_CONTROL_LINE_BYTES - 128);
    await assert.rejects(
      () => t.client.request('echo', { payload }),
      (err) => err.code === 'BAD_REQUEST' && err.dispatched === false && /bytes/.test(err.message),
    );
    assert.equal(t.client.stats.dispatched, before);
    assert.equal(t.readLog().filter((m) => m.rt === 'req').length, 0);
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('dispose 发生在 hello 握手期间：start Promise 必须以 DISPOSED settle', async () => {
  const t = await setup({ silent: true }, { helloTimeoutMs: 5_000 });
  try {
    const starting = t.client.start();
    await sleep(50);
    t.client.dispose();
    const outcome = await Promise.race([
      starting.then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (err) => err),
      sleep(400).then(() => ({ code: 'TEST_TIMEOUT' })),
    ]);
    assert.equal(outcome.code, 'DISPOSED');
    assert.equal(t.client.state, 'disposed');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('异步 write 回调失败保守记 dispatched=true，不自动重启', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const fake = new EventEmitter();
  fake.pid = 424242;
  fake.exitCode = null;
  fake.signalCode = null;
  fake.stdout = new PassThrough();
  fake.stderr = new PassThrough();
  fake.stdin = new EventEmitter();
  fake.stdin.write = (line, cb) => {
    const msg = JSON.parse(line);
    if (msg.rt === 'welcome') return true;
    queueMicrotask(() => cb(new Error('synthetic async write failure')));
    return true;
  };
  fake.kill = () => { fake.exitCode = 0; return true; };
  const client = createWorkerClient({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    spawnProcess: () => fake,
    requestTimeoutMs: 100,
    heartbeatTimeoutMs: 0,
  });
  try {
    const starting = client.start();
    fake.stdout.write(JSON.stringify({
      rt: 'hello', protocol: 1, worker: { name: 'write-failure-double' },
      pid: fake.pid, capabilities: ['run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat'],
    }) + '\n');
    await starting;
    await assert.rejects(
      () => client.request('run', { runId: 'run-write-unknown' }),
      (err) => err.code === 'WRITE_FAILED' && err.dispatched === true,
    );
    assert.equal(client.stats.spawns, 1);
    assert.equal(client.state, 'dead');
  } finally {
    client.dispose();
  }
});

test('hello 必须逐项声明九命令与 heartbeat；缺任何能力都拒绝握手且不发 welcome', async () => {
  for (const missing of REQUIRED_CAPABILITIES) {
    const capabilities = REQUIRED_CAPABILITIES.filter((name) => name !== missing);
    const t = await setup({ manualStart: true, hello: { capabilities } });
    try {
      await assert.rejects(
        () => t.client.start(),
        (err) => err.code === 'PROTOCOL_MISMATCH' && err.dispatched !== true && err.message.includes(missing),
      );
      assert.equal(t.client.state, 'dead');
      assert.equal(t.readLog().filter((msg) => msg.rt === 'welcome').length, 0, missing + ' 缺失时不得完成握手');
    } finally {
      await cleanup(t.client, t.dir);
    }
  }
});

test('生产默认 heartbeatTimeoutMs 非零；测试可显式设 0 关闭监控', async () => {
  const productionDefault = await setup({}, { heartbeatTimeoutMs: undefined });
  try {
    assert.ok(productionDefault.client.heartbeatTimeoutMs > 0, '生产默认必须真的监测心跳，不能默认关闭');
  } finally {
    await cleanup(productionDefault.client, productionDefault.dir);
  }
  const deterministic = await setup();
  try {
    assert.equal(deterministic.client.heartbeatTimeoutMs, 0);
  } finally {
    await cleanup(deterministic.client, deterministic.dir);
  }
});

test('九命令客户端方法保留真实 JSON camelCase 与结构化 target/skill/authorization', async () => {
  const t = await setup();
  const target = { kind: 'hil', targetId: 'target-A', window: { processId: 42, hwnd: 7 } };
  const skill = { name: 'camera-ready', version: '1.2.3', parameters: { settleMs: 20 } };
  const authorization = { granted: true, targetId: 'target-A', leaseId: 'lease-A', expiresAtMs: 999999 };
  const cases = [
    ['run', { runId: 'run-client-methods', sessionId: 'session-A', mode: 'shadow', target, skill, deadlineMs: 12345, authorization }],
    ['status', { runId: 'run-client-methods', sessionId: 'session-A' }],
    ['stop', { runId: 'run-client-methods', sessionId: 'session-A', reason: 'operatorStop' }],
    ['snapshot', { runId: 'run-client-methods', sessionId: 'session-A', reason: 'cameraReady' }],
    ['replay', { runId: 'run-client-methods', sessionId: 'session-A', mode: 'replay', tracePath: 'D:\\traces\\run.jsonl', deadlineMs: 23456 }],
    ['trace_read', { tracePath: 'D:\\traces\\run.jsonl', offset: 2, limit: 3 }],
    ['targets', { sessionId: 'session-A', includeBusy: true }],
    ['skill_validate', { skill, target, mode: 'shadow' }],
    ['calibrate', { target, skill, sampleCount: 2, deadlineMs: 34567, authorization }],
  ];
  try {
    for (const [method, args] of cases) {
      const result = await t.client[method](args, { timeoutMs: 2_000 });
      assert.equal(result.cmd, method);
      assert.deepEqual(result.echo, args, method + ' 不得改名、丢字段或把结构化值字符串化');
    }
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('stop 不被挂起的普通 status 饿死；停止响应先于普通请求结算', async () => {
  const t = await setup({ behaviors: { status: { hang: true } } });
  try {
    const ordinary = t.client.status({ runId: 'run-stop-priority', sessionId: 'session-A' }, { timeoutMs: 10_000 }).then(
      () => assert.fail('挂起的 status 不应成功'),
      (err) => err,
    );
    await waitFor(() => t.client.stats.dispatched === 1, { label: '普通 status 已派发' });
    const stopped = await t.client.stop(
      { runId: 'run-stop-priority', sessionId: 'session-A', reason: 'operatorStop' },
      { timeoutMs: 1_000, safety: false },
    );
    assert.equal(stopped.cmd, 'stop');
    assert.equal(stopped.stopped, true);
    const commands = t.readLog().filter((msg) => msg.rt === 'req').map((msg) => msg.cmd);
    assert.deepEqual(commands, ['status', 'stop']);
    assert.equal(t.client.stats.dispatched, 2, 'stop 必须立即写出，不能排在普通队列后');
    t.client.dispose();
    assert.equal((await ordinary).code, 'DISPOSED');
  } finally {
    await cleanup(t.client, t.dir);
  }
});

test('真实 Rt.Worker spawn：dotnet 子进程完成九命令+heartbeat 版本握手', { timeout: 30_000 }, async () => {
  const workerDll = process.env.RT_WORKER_DLL || fileURLToPath(new URL('../native/win-x64/worker/Rt.Worker.dll', import.meta.url));
  assert.ok(existsSync(workerDll), '真实 Worker 尚未发布，请先运行 npm run build:native：' + workerDll);
  const client = createWorkerClient({
    command: process.env.DOTNET_EXE || 'dotnet',
    args: [workerDll, '--stdio'],
    helloTimeoutMs: 20_000,
    requestTimeoutMs: 5_000,
  });
  try {
    const info = await client.start();
    assert.equal(info.protocol, RT_PROTOCOL_VERSION);
    assert.equal(info.pid > 0, true);
    for (const capability of REQUIRED_CAPABILITIES) {
      assert.ok(info.capabilities.includes(capability), '真实 Worker 缺少能力 ' + capability);
    }
    assert.ok(client.heartbeatTimeoutMs > 0, '真实生产握手不得隐式关闭心跳监控');
    assert.equal(client.stats.spawns, 1);
  } finally {
    client.dispose();
    await waitFor(() => client.stats.exits === 1, { timeoutMs: 5_000, label: '真实 Worker 退出' });
  }
});

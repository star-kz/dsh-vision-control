/**
 * realtime/worker-client.mjs — JSONL/stdio 传输层（Task 5）。
 *
 * 职责仅有一件事：与真实 Worker 子进程说同一种线协议。
 *   - 版本握手：worker 先发 hello（带协议号与能力表），host 校验后回 welcome；
 *     协议号不符 → PROTOCOL_MISMATCH 并杀掉子进程；等不到 hello → START_TIMEOUT。
 *   - 消息是逐行 JSON（rt:req / rt:res / rt:event），应答按 id 关联（允许乱序到达），
 *     事件（含心跳）推给 onEvent 订阅者。数据面（帧、轨迹字节）不经过这里——
 *     单行超过 RT_MAX_CONTROL_LINE_BYTES 直接拒收计数，不解析。
 *   - 诚实性约定：每个错误都带 dispatched 布尔——true 表示请求已经写给 worker
 *     （结局未知，绝不能自动盲重试）；false 表示什么都没发生（可以安全拒绝）。
 *   - 心跳丢失 → unhealthy：在途请求以 HEARTBEAT_LOST 失败（dispatched=true），
 *     新的普通请求拒发；但 stop 用的 safety 通道在 worker 仍活着时可写。
 *   - 本层**从不自动重启** worker：换代必须由上层显式调用 start()。
 */
import { spawn } from 'node:child_process';
import {
  RT_PROTOCOL_VERSION,
  RT_MAX_CONTROL_LINE_BYTES,
  validateHello,
  validateResponseEnvelope,
} from './contracts.mjs';

const REQUIRED_WORKER_CAPABILITIES = Object.freeze([
  'run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'targets', 'skill_validate', 'calibrate', 'heartbeat',
]);
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

function rtError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * 建一个 worker 客户端（尚未 spawn，调 start() 才握手）。
 * @param {{command: string, args?: string[], helloTimeoutMs?: number,
 *          heartbeatTimeoutMs?: number, requestTimeoutMs?: number}} options
 */
export function createWorkerClient(options = {}) {
  const {
    command,
    args = [],
    spawnProcess = spawn,
    helloTimeoutMs = 5_000,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    requestTimeoutMs = 30_000,
  } = options;

  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('createWorkerClient requires a command string');
  }

  let child = null;
  let state = 'idle'; // idle | ready | unhealthy | dead | disposed
  let info = null;
  let nextId = 0;
  let lineBuf = '';
  let lastBeatAt = 0;
  let heartbeatTimer = null;
  let helloTimer = null;
  let disposed = false;
  let startPromise = null;
  let currentStart = null; // { resolve, reject, settled }
  const pending = new Map(); // id -> { resolve, reject, timer, signal, onAbort }
  const stats = { spawns: 0, dispatched: 0, responses: 0, orphans: 0, badLines: 0, oversized: 0, exits: 0 };
  let eventHandler = null;
  const eventQueue = [];
  const exitListeners = [];
  const healthListeners = [];

  function setState(next) { state = next; }

  function emitHealth(healthy) {
    for (const cb of healthListeners) { try { cb(healthy); } catch { /* 订阅者异常不进传输层 */ } }
  }

  function deliverEvent(msg) {
    if (eventHandler) {
      try { eventHandler(msg); } catch { /* 同上 */ }
    } else if (eventQueue.length < 1_000) {
      eventQueue.push(msg); // onEvent 注册后统一补投
    }
  }

  function failPending(code, message, dispatched) {
    for (const [id, entry] of Array.from(pending)) {
      pending.delete(id);
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      const err = rtError(code, message);
      if (dispatched !== undefined) err.dispatched = dispatched;
      entry.reject(err);
    }
  }

  function killChild() {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* already dying */ }
    }
  }

  function stopHeartbeatMonitor() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function startHeartbeatMonitor() {
    stopHeartbeatMonitor();
    if (heartbeatTimeoutMs <= 0 || !info || !info.capabilities.includes('heartbeat')) return;
    lastBeatAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (state !== 'ready' && state !== 'unhealthy') { stopHeartbeatMonitor(); return; }
      if (Date.now() - lastBeatAt > heartbeatTimeoutMs) {
        stopHeartbeatMonitor();
        if (state === 'ready') { setState('unhealthy'); emitHealth(false); }
        failPending('HEARTBEAT_LOST', `worker heartbeat lost after ${heartbeatTimeoutMs}ms; pending request outcomes are unknown`, true);
      }
    }, Math.max(20, Math.min(100, Math.floor(heartbeatTimeoutMs / 4))));
  }

  function settleStart(err, value) {
    if (!currentStart || currentStart.settled) return;
    currentStart.settled = true;
    clearTimeout(helloTimer);
    helloTimer = null;
    if (err) currentStart.reject(err);
    else currentStart.resolve(value);
  }

  function handleHello(msg) {
    if (disposed) return; // dispose 后迟到的 hello 不得复活状态机
    const v = validateHello(msg);
    if (!v.ok) {
      setState('dead');
      killChild();
      settleStart(rtError('PROTOCOL_MISMATCH', 'worker sent a malformed hello envelope'));
      return;
    }
    if (v.protocol !== RT_PROTOCOL_VERSION) {
      setState('dead');
      killChild();
      settleStart(rtError('PROTOCOL_MISMATCH', `worker speaks protocol ${v.protocol}, control plane expects ${RT_PROTOCOL_VERSION}`));
      return;
    }
    const missingCapabilities = REQUIRED_WORKER_CAPABILITIES.filter((name) => !v.capabilities.includes(name));
    if (missingCapabilities.length > 0) {
      setState('dead');
      killChild();
      settleStart(rtError('PROTOCOL_MISMATCH', `worker hello is missing required capabilities: ${missingCapabilities.join(', ')}`, { dispatched: false }));
      return;
    }
    info = { pid: child.pid, protocol: RT_PROTOCOL_VERSION, worker: v.worker, capabilities: v.capabilities };
    try {
      child.stdin.write(JSON.stringify({ rt: 'welcome', protocol: RT_PROTOCOL_VERSION }) + '\n');
    } catch (err) {
      setState('dead');
      settleStart(rtError('WRITE_FAILED', `failed to write welcome: ${err.message}`));
      return;
    }
    setState('ready');
    emitHealth(true);
    settleStart(null, info);
    startHeartbeatMonitor();
  }

  function handleLine(line) {
    if (Buffer.byteLength(line, 'utf8') > RT_MAX_CONTROL_LINE_BYTES) { stats.oversized += 1; return; }
    let msg;
    try { msg = JSON.parse(line); } catch { stats.badLines += 1; return; }
    if (!msg || typeof msg !== 'object') { stats.badLines += 1; return; }
    if (msg.rt === 'hello') { handleHello(msg); return; }
    if (msg.rt === 'res') {
      const env = validateResponseEnvelope(msg);
      if (!env.ok) { stats.badLines += 1; return; }
      const entry = pending.get(msg.id);
      if (!entry) { stats.orphans += 1; return; }
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      stats.responses += 1;
      if (msg.ok) entry.resolve(msg.result);
      else {
        const code = (msg.error && typeof msg.error.code === 'string') ? msg.error.code : 'WORKER_ERROR';
        const message = (msg.error && typeof msg.error.message === 'string') ? msg.error.message : 'worker reported an error';
        // 收到负应答本身就证明请求已抵达 worker；结局归因不得写成预派发失败。
        entry.reject(rtError(code, message, { workerError: msg.error, dispatched: true }));
      }
      return;
    }
    if (msg.rt === 'event') {
      if (msg.event === 'heartbeat') lastBeatAt = Date.now();
      deliverEvent(msg);
      return;
    }
    stats.orphans += 1;
  }

  function attachChild(c) {
    lineBuf = ''; // 换代重置：新进程的 stdout 不继承上一代的残留半行
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      lineBuf += chunk;
      // 没有换行的超长滞留数据（攻击面防御）：整段丢弃并计数
      if (Buffer.byteLength(lineBuf, 'utf8') > RT_MAX_CONTROL_LINE_BYTES * 2 && lineBuf.indexOf('\n') < 0) {
        stats.oversized += 1;
        lineBuf = '';
        return;
      }
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.trim().length > 0) handleLine(line);
      }
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', () => { /* worker 诊断信息不进控制面，仅排空防阻塞 */ });
    c.stdin.on('error', (err) => {
      // 写入侧管道故障：通道已不可信 → dead + kill + 在途请求以 WRITE_FAILED 失败。
      // 在途请求都已成功写出过（write 回调为 null），此刻结局未知 → dispatched=true。
      // 各请求自己的 write 回调错误同样保守记 dispatched=true（可能已部分送达）。
      if (state === 'disposed') return;
      setState('dead');
      killChild();
      failPending('WRITE_FAILED', `worker stdin pipe failed: ${(err && err.message) || err}; pending request outcomes are unknown`, true);
    });
    c.on('error', (err) => {
      // spawn 失败（如命令不存在）
      setState('dead');
      if (currentStart && !currentStart.settled) {
        settleStart(rtError('SPAWN_FAILED', `failed to spawn worker: ${err.message}`));
      } else {
        failPending('WORKER_EXITED', `worker process failed: ${err.message}`, true);
      }
    });
    c.on('exit', (code, signal) => {
      stats.exits += 1;
      stopHeartbeatMonitor();
      if (state !== 'disposed') setState('dead');
      failPending('WORKER_EXITED', `worker exited (code=${code}, signal=${signal}) before responding; outcome is unknown`, true);
      for (const cb of exitListeners) { try { cb({ code, signal, pid: c.pid }); } catch { /* 订阅者异常不进传输层 */ } }
    });
  }

  function spawnOnce() {
    return new Promise((resolve, reject) => {
      stats.spawns += 1;
      currentStart = { resolve, reject, settled: false };
      let c;
      try {
        c = spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        currentStart = null;
        reject(rtError('SPAWN_FAILED', `failed to spawn worker: ${err.message}`));
        return;
      }
      child = c;
      attachChild(c);
      helloTimer = setTimeout(() => {
        setState('dead');
        killChild();
        settleStart(rtError('START_TIMEOUT', `worker did not send hello within ${helloTimeoutMs}ms`));
      }, helloTimeoutMs);
    });
  }

  /**
   * 启动或换代握手。ready/unhealthy 时直接返回现有 info；dead 时显式重启
   * （换代必须是调用方的决定——本层从不替上层自动重启重发）。
   * @returns {Promise<{pid:number, protocol:number, worker:object, capabilities:string[]}>}
   */
  async function start() {
    if (disposed) throw rtError('DISPOSED', 'worker client is disposed');
    if (state === 'ready' || state === 'unhealthy') return info;
    if (startPromise) return startPromise;
    startPromise = spawnOnce();
    const clear = () => { startPromise = null; };
    startPromise.then(clear, clear);
    return startPromise;
  }

  /**
   * 发一条控制面请求。
   * @param {string} cmd
   * @param {object} argsJSON
   * @param {{timeoutMs?: number, signal?: AbortSignal, safety?: boolean}} [opts]
   *   safety:true 表示走安全通道（stop/estop）：unhealthy 时也允许写。
   * @returns {Promise<object>} worker 应答的 result
   * @throws 错误带 code 与 dispatched（true=已写出、结局未知；false=什么都没发生）
   */
  function request(cmd, argsJSON = {}, opts = {}) {
    const { timeoutMs = requestTimeoutMs, signal = null, safety = false } = opts;
    if (disposed) return Promise.reject(rtError('DISPOSED', 'worker client is disposed'));
    if (state === 'idle') return Promise.reject(rtError('NOT_STARTED', 'worker client has not been started; request was not dispatched', { dispatched: false }));
    if (state === 'dead') return Promise.reject(rtError('WORKER_EXITED', 'worker is not running; request was not dispatched', { dispatched: false }));
    if (state === 'unhealthy' && !safety) {
      return Promise.reject(rtError('HEARTBEAT_LOST', 'worker heartbeat lost; non-safety requests are refused (nothing dispatched)', { dispatched: false }));
    }
    if (signal && signal.aborted) {
      return Promise.reject(rtError('ABORTED', 'aborted before dispatch; nothing was sent', { dispatched: false }));
    }
    const id = `r-${(nextId += 1)}`;
    const line = JSON.stringify({ rt: 'req', id, cmd, args: argsJSON }) + '\n';
    if (Buffer.byteLength(line, 'utf8') > RT_MAX_CONTROL_LINE_BYTES) {
      return Promise.reject(rtError('BAD_REQUEST', `request '${cmd}' exceeds control-plane line limit of ${RT_MAX_CONTROL_LINE_BYTES} bytes; the data plane does not pass through Node`, { dispatched: false }));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, signal, onAbort: null };
      const onWriteError = (err) => {
        if (pending.has(id)) { pending.delete(id); clearTimeout(entry.timer); }
        if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
        // write 已进入 OS/流层，报错也不能证明零字节送达；一律保守记 dispatched=true。
        setState('dead');
        killChild(); // 管道已断，保住"不再有任何写出"的不变量
        reject(rtError('WRITE_FAILED', `failed to write request '${cmd}' to worker stdin: ${(err && err.message) || err}; request outcome is unknown`, { dispatched: true }));
      };
      const onWriteOk = () => {
        stats.dispatched += 1;
        entry.timer = setTimeout(() => {
          pending.delete(id);
          if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
          reject(rtError('TIMEOUT', `no response to '${cmd}' within ${timeoutMs}ms; request was dispatched, outcome is unknown`, { dispatched: true }));
        }, timeoutMs);
        if (signal) {
          entry.onAbort = () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            clearTimeout(entry.timer);
            reject(rtError('ABORTED', 'abort cancelled the wait only; request outcome is unknown and may still execute', { dispatched: true }));
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        pending.set(id, entry);
      };
      try {
        child.stdin.write(line, (err) => { if (err) onWriteError(err); else onWriteOk(); });
      } catch (err) {
        onWriteError(err);
      }
    });
  }

  // 九个公开命令的薄封装：参数对象原样进入 JSON，不做 snake/camel 或结构化值转换。
  // request 本身不排队，因此 stop 不会被普通在途请求饿死；safety 只允许 stop 自行开启。
  function run(args = {}, opts = {}) { return request('run', args, opts); }
  function status(args = {}, opts = {}) { return request('status', args, opts); }
  function stop(args = {}, opts = {}) { return request('stop', args, { ...opts, safety: true }); }
  function snapshot(args = {}, opts = {}) { return request('snapshot', args, opts); }
  function replay(args = {}, opts = {}) { return request('replay', args, opts); }
  function trace_read(args = {}, opts = {}) { return request('trace_read', args, opts); }
  function targets(args = {}, opts = {}) { return request('targets', args, opts); }
  function skill_validate(args = {}, opts = {}) { return request('skill_validate', args, opts); }
  function calibrate(args = {}, opts = {}) { return request('calibrate', args, opts); }

  /**
   * 注册事件回调（worker 的 rt:event 行，含心跳）。注册前的已到事件会被缓存并补投。
   * @returns {() => void} 取消订阅
   */
  function onEvent(cb) {
    if (typeof cb !== 'function') throw new TypeError('onEvent requires a function');
    eventHandler = cb;
    while (eventQueue.length > 0) cb(eventQueue.shift());
    return () => { if (eventHandler === cb) eventHandler = null; };
  }

  /** 注册 worker 退出回调（含被 kill / 崩溃 / 断管清理）。 */
  function onExit(cb) { exitListeners.push(cb); return () => { const i = exitListeners.indexOf(cb); if (i >= 0) exitListeners.splice(i, 1); }; }

  /** 注册健康状态回调：参数 true=ready，false=心跳丢失。 */
  function onHealthChange(cb) { healthListeners.push(cb); return () => { const i = healthListeners.indexOf(cb); if (i >= 0) healthListeners.splice(i, 1); }; }

  /** 杀掉 worker（不清理订阅者）。换代用 start()。 */
  function kill() { killChild(); }

  /** 永久关闭：杀 worker、以 DISPOSED 失败所有在途请求、拒绝后续一切请求。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    setState('disposed');
    stopHeartbeatMonitor();
    // hello 握手也是一个必须 settle 的等待者，否则 dispose 后 start() 会永久悬挂。
    settleStart(rtError('DISPOSED', 'worker client disposed during hello handshake', { dispatched: false }));
    clearTimeout(helloTimer);
    helloTimer = null;
    failPending('DISPOSED', 'worker client disposed; pending request outcomes are unknown', true);
    killChild();
  }

  return {
    start,
    request,
    run,
    status,
    stop,
    snapshot,
    replay,
    trace_read,
    targets,
    skill_validate,
    calibrate,
    kill,
    dispose,
    onEvent,
    onExit,
    onHealthChange,
    get state() { return state; },
    get info() { return info; },
    get heartbeatTimeoutMs() { return heartbeatTimeoutMs; },
    get stats() { return stats; },
  };
}

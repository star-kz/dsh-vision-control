/**
 * realtime/controller.mjs — 控制面编排层（Task 5）。
 *
 * 职责：在传输层（worker-client）之上组织 run 的生命周期与诚实性不变量。
 *
 * 核心不变量（测试全部钉死）：
 *   1. 每条应答都验证 runId / sourceEpoch——过期回包与过期事件一律拒绝并计数，不落账。
 *   2. dispatch 之后的失败（TIMEOUT/WORKER_EXITED/HEARTBEAT_LOST/abort-after-write）一律记为
 *      unknown 结局，**绝不自动重试**：同一 run 只有一个 dispatch。
 *   3. stop 只报告真实证据：estopSent/estopAcked/leaseRevoked/releaseConfirmed/released/
 *      releaseToolUsed/releaseError——任何一个字段不撒谎。停止确认不确定时状态是
 *      'stopped-unknown'，不是 'stopped'。
 *   4. active run 的租约在 worker 掉线（退出/心跳丢失）时由宿主通过**独立的 release 工具**
 *      释放（控制器自己不能既当运动员又当裁判），stop 只复用这次释放结果。
 *   5. AbortSignal 只取消等待；不伪造"已停止"。
 *   6. shadow 是默认模式；active 必须显式授权描述符 + 目标验证器放行（本阶段默认验证器
 *      永不放行）。replay 离线回放，永不注入真实输入。
 */
import { randomUUID } from 'node:crypto';
import {
  validateRunSpec,
  validateActiveAuthorization,
  validateReplaySpec,
  makeRunRecord,
  makeStopRecord,
  isStaleRunResult,
  isStaleEpoch,
  isStaleEventSeq,
  defaultVerifyHilTarget,
} from './contracts.mjs';

const LIVE_STATES = new Set(['starting', 'running', 'stopping', 'unknown']);
/** 控制面终态：事件不再推进（stop/失败/unknown 的裁决权在控制面）。 */
const TERMINAL_STATES = new Set(['stopped', 'stopped-unknown', 'failed', 'unknown']);

function rtError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * 建控制面。client 是 createWorkerClient 的返回值（传输层）。
 * @param {{client: object, requestTimeoutMs?: number, estopTimeoutMs?: number,
 *          releaseTool?: null|((record: object) => Promise<{released: boolean, detail?: string}>),
 *          verifyHilTarget?: (target: object) => Promise<{ok: boolean, reason?: string}>}} options
 *   releaseTool：宿主提供的独立释放工具（如释放写租约的独立进程/命令）。active run 掉线时
 *   由控制器调用；它不能复用 worker 本身——worker 已不可信。
 */
export function createRealtimeController(options = {}) {
  const {
    client,
    requestTimeoutMs = 30_000,
    estopTimeoutMs = 10_000,
    releaseTool = null,
    verifyHilTarget = defaultVerifyHilTarget,
    sessionId = 'default',
    heartbeatIntervalMs = 1_000,
    heartbeatRequestTimeoutMs = 2_000,
  } = options;
  if (!client || typeof client.request !== 'function') {
    throw new TypeError('createRealtimeController requires a worker client');
  }

  const runs = new Map();
  const stats = { runs: 0, stops: 0, staleRunEvents: 0, staleEpochEvents: 0, staleEventSeqEvents: 0, invalidTerminalEvents: 0, autoReleases: 0 };
  let disposed = false;

  function newRunId() {
    return `${sessionId}-${randomUUID()}`;
  }

  function stopHeartbeat(record) {
    if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
    record.heartbeatTimer = null;
  }

  // Native active runs freeze after five seconds without a session renewal. The
  // server's heartbeat event only proves the transport is alive; it does not
  // renew an active run. Keep a separate, non-overlapping request heartbeat.
  function startHeartbeat(record) {
    if (record.mode !== 'active' || record.dispatched !== true || !record.lease.held) return;
    stopHeartbeat(record);
    const beat = async () => {
      if (disposed || record.heartbeatInFlight) return;
      if (!['starting', 'running'].includes(record.state) || !record.lease.held) {
        stopHeartbeat(record);
        return;
      }
      record.heartbeatInFlight = true;
      try {
        await client.request('heartbeat', { sessionId: record.sessionId },
          { timeoutMs: Math.min(heartbeatRequestTimeoutMs, requestTimeoutMs) });
        record.lastHeartbeatAckAtMs = Date.now();
        record.heartbeatError = null;
      } catch (err) {
        record.heartbeatError = { code: err.code, message: err.message, dispatched: err.dispatched === true };
        stopHeartbeat(record);
        handleWorkerLoss(record);
      } finally {
        record.heartbeatInFlight = false;
      }
    };
    record.heartbeatTimer = setInterval(beat, Math.max(10, heartbeatIntervalMs));
    record.heartbeatTimer.unref?.();
  }

  // ---- worker 事件管线：旧 runId 与回落 sourceEpoch 一律拒收 ----
  client.onEvent((msg) => {
    if (!msg || msg.rt !== 'event') return;
    if (msg.event === 'heartbeat') return; // 心跳已由传输层消费
    const record = runs.get(msg.runId);
    if (!record) { stats.staleRunEvents += 1; return; }
    // sourceEpoch 只允许相等或前进；真正的事件顺序由每 run 严格递增的 eventSeq 决定。
    if (isStaleEpoch(record.sourceEpochMax, msg.sourceEpoch)) { stats.staleEpochEvents += 1; return; }
    if (isStaleEventSeq(record.eventSeqMax, msg.eventSeq)) { stats.staleEventSeqEvents += 1; return; }
    record.sourceEpochMax = msg.sourceEpoch;
    record.eventSeqMax = msg.eventSeq;
    record.lastEventAtMs = Date.now();
    if (msg.event === 'terminal') {
      const terminal = msg.payload && typeof msg.payload === 'object' ? msg.payload : msg;
      const stopped = terminal.state === 'stopped';
      if (terminal.released === true && !stopped) {
        stats.invalidTerminalEvents += 1;
        return; // Released-only evidence can never unlock a still-running target.
      }
      const released = stopped && terminal.released === true;
      record.nativeTerminal = {
        stopped, released,
        state: stopped && (record.mode !== 'active' || released) ? 'stopped' : 'stopped-unknown',
      };
      record.state = record.nativeTerminal.state;
      record.workerStopped = stopped;
      if (released) {
        record.workerReleased = true;
        record.lease.held = false;
      }
      stopHeartbeat(record);
      return;
    }
    if (msg.event === 'state' && typeof msg.state === 'string') {
      // 未终结时接受链式推进（s2→s5→…）；终态由控制面裁决，事件不再推进
      if (!TERMINAL_STATES.has(record.state)) record.state = msg.state;
    }
  });

  // ---- worker 掉线：active 租约必须由独立 release 工具释放 ----
  function autoReleaseIfNeeded(record) {
    // 只有已派发的 active 才可能真的持有宿主机写租约；预派发拒绝绝不触发释放工具。
    if (record.mode !== 'active' || record.dispatched !== true || !record.lease.held) return null;
    if (record.autoReleasePromise) return record.autoReleasePromise;
    record.autoReleasePromise = (async () => {
      stats.autoReleases += 1;
      let outcome;
      if (!releaseTool) {
        outcome = { released: false, usedTool: false, error: 'no independent release tool configured; write lease status is unknown' };
      } else {
        try {
          const r = await releaseTool(record);
          outcome = { released: r && r.released === true, usedTool: true, detail: r && r.detail };
        } catch (err) {
          outcome = { released: false, usedTool: true, error: `release tool failed: ${(err && err.message) || err}` };
        }
      }
      record.autoRelease = outcome; // stop 会复用这份结论，绝不二次调用
      if (outcome.released === true) record.lease.held = false;
      return outcome;
    })();
    return record.autoReleasePromise;
  }

  function handleWorkerLoss(record, { exited = false } = {}) {
    stopHeartbeat(record);
    if (record.dispatched !== true) return; // 还在授权/验证/启动阶段，没有远端结局可收尾
    if (exited) record.workerExitObserved = true;
    if (LIVE_STATES.has(record.state)) record.state = 'unknown';
    autoReleaseIfNeeded(record);
  }

  client.onExit(() => {
    for (const record of runs.values()) handleWorkerLoss(record, { exited: true });
  });
  if (typeof client.onHealthChange === 'function') {
    client.onHealthChange((healthy) => {
      if (healthy) return;
      // run() 已经返回不代表生命周期结束：之后丢心跳同样要收尾。
      for (const record of runs.values()) handleWorkerLoss(record);
    });
  }

  /** worker 不在（未启动/已死）时显式换代启动；失败原样上抛（code 透传）。 */
  async function ensureWorker() {
    const st = client.state;
    if (st === 'ready' || st === 'unhealthy') return;
    if (st === 'disposed') throw rtError('DISPOSED', 'worker client is disposed');
    await client.start();
  }

  async function dispatchRequest(cmd, args, record, { timeoutMs, signal } = {}) {
    try {
      const res = await client.request(cmd, args, { timeoutMs: timeoutMs ?? requestTimeoutMs, signal });
      if (isStaleRunResult(record.runId, res)) {
        // 这里只负责识别错包；run/replay 的统一 catch 按 dispatched=true 记 unknown。
        // status/snapshot 直接上抛，观察失败不改写 run 自身状态。
        throw rtError('STALE_RUN', `worker response for '${cmd}' named runId ${JSON.stringify(res.runId)}, expected ${JSON.stringify(record.runId)}`, { runId: record.runId, dispatched: true });
      }
      return res;
    } catch (err) {
      if (err.code === 'STALE_RUN') throw err;
      err.runId = record.runId;
      throw err;
    }
  }

  /** run 失败后的统一收尾：记录结局 +（active+掉线时）触发独立释放。 */
  function recordDispatchFailure(record, err) {
    record.dispatched = err.dispatched === true;
    record.error = { code: err.code, message: err.message, dispatched: err.dispatched };
    if (record.dispatched) {
      record.state = 'unknown'; // 写出去了：结局未知，绝不自动重试
    } else {
      record.state = 'failed';
      record.lease.held = false; // 预派发拒绝从未取得真实写租约
    }
    if (record.lease.held && (err.code === 'HEARTBEAT_LOST' || err.code === 'WORKER_EXITED')) {
      autoReleaseIfNeeded(record);
    }
  }

  /**
   * 发起一次 run。
   * @param {{mode?: 'shadow'|'active'|'replay', skill: string, target: object,
   *          deadlineMs?: number|null, authorization?: object,
   *          timeoutMs?: number, signal?: AbortSignal}} spec
   * @returns {Promise<object>} run 记录（含 runId/state/lease/deadline）
   */
  async function run(spec) {
    if (disposed) throw rtError('DISPOSED', 'controller is disposed');
    const v = validateRunSpec(spec);
    const runId = newRunId();
    if (!v.ok) {
      // 校验失败：连 runId 都不占账——请求从未成形，直接拒绝
      throw rtError(v.code, v.message, { dispatched: false });
    }
    const record = makeRunRecord({ runId, mode: v.mode, skill: v.skill, target: v.target, sessionId, deadlineMs: v.deadlineMs });
    runs.set(runId, record);
    stats.runs += 1;

    try {
      // active 三重闸门：显式授权 → 目标验证 → 同目标互斥
      const auth = validateActiveAuthorization({ mode: v.mode, target: v.target, authorization: v.authorization });
      if (!auth.ok) {
        record.state = 'failed';
        throw rtError(auth.code, auth.message, { runId, dispatched: false });
      }
      if (v.mode === 'active') {
        const verdict = await verifyHilTarget(v.target);
        if (!verdict || verdict.ok !== true) {
          const reason = (verdict && verdict.reason) || 'target verification failed';
          record.state = 'failed';
          throw rtError('NOT_AUTHORIZED', `active target refused: ${reason}`, { runId, dispatched: false });
        }
      }
      if (spec.signal && spec.signal.aborted) {
        record.state = 'failed';
        throw rtError('ABORTED', 'aborted before dispatch; nothing was sent', { runId, dispatched: false });
      }

      await ensureWorker();
      // 互斥依据是“已派发且尚无真实释放证据”，不是 stopped-unknown 等表面状态。
      // 放在 ensureWorker 之后、dispatch 之前，也封住两个并发 run 同过验证的竞态。
      if (v.mode === 'active') {
        for (const other of runs.values()) {
          if (other !== record && other.mode === 'active' && other.target.id === v.target.id && other.dispatched === true && other.lease.held) {
            throw rtError('TARGET_BUSY', `target ${JSON.stringify(v.target.id)} is busy with active run ${JSON.stringify(other.runId)}`, { runId, dispatched: false });
          }
        }
      }
      record.dispatched = true; // 必须先于任何异步结果/健康回调落账
      const res = await dispatchRequest('run', {
        runId, mode: v.mode, skill: v.skill, target: v.target,
        sessionId: record.sessionId, deadlineMs: v.deadlineMs, authorization: v.authorization,
      }, record, { timeoutMs: spec.timeoutMs, signal: spec.signal });
      record.dispatched = true;
      // run 应答与事件可能挤在同一批 stdout 里：事件先推进过的状态不被应答回写覆盖
      if (record.state === 'starting') {
        record.state = (res && typeof res.state === 'string') ? res.state : 'running';
      }
      startHeartbeat(record);
      return record;
    } catch (err) {
      // 包括 STALE_RUN 在内统一归因：false=failed，true=unknown（绝不盲重试）。
      recordDispatchFailure(record, err);
      err.runId = err.runId || runId;
      throw err;
    }
  }

  /**
   * 查询 run 状态。worker 应答回落（旧 runId）→ 拒绝；传输不可用 → 降级返回
   * {record, live:null, liveError}（本地记录仍然可读，不假装 worker 活着）。
   */
  async function status(runId) {
    if (disposed) throw rtError('DISPOSED', 'controller is disposed');
    const record = runs.get(runId);
    if (!record) throw rtError('STALE_RUN', `no such run: ${JSON.stringify(runId)}`, { runId, dispatched: false });
    if (record.nativeTerminal) {
      // Native terminal evidence outlives Worker registry removal. Do not turn a known,
      // reconciled terminal run into STALE_RUN by asking the already-removed host again.
      return { record, live: null, nativeTerminal: record.nativeTerminal };
    }
    try {
      const live = await dispatchRequest('status', { runId, sessionId: record.sessionId }, record);
      return { record, live };
    } catch (err) {
      if (err.code === 'STALE_RUN') throw err;
      // 传输层不可用（心跳丢失/worker 死亡）：降级，不臆造 live 数据
      return { record, live: null, liveError: { code: err.code, message: err.message } };
    }
  }

  /**
   * 快照。未知 run 一律预派发拒绝（stats.dispatched 不动）。应答回落旧 runId → STALE_RUN。
   */
  async function snapshot(runId) {
    if (disposed) throw rtError('DISPOSED', 'controller is disposed');
    const record = runs.get(runId);
    if (!record) throw rtError('STALE_RUN', `no such run: ${JSON.stringify(runId)}`, { runId, dispatched: false });
    const res = await dispatchRequest('snapshot', { runId, sessionId: record.sessionId }, record);
    return res;
  }

  /**
   * 离线回放轨迹。回放 run 不持租约、不注入真实输入；mode 恒为 'replay'。
   */
  async function replay(spec) {
    if (disposed) throw rtError('DISPOSED', 'controller is disposed');
    const v = validateReplaySpec(spec);
    if (!v.ok) throw rtError(v.code, v.message, { dispatched: false });
    const runId = newRunId();
    const record = makeRunRecord({ runId, mode: 'replay', skill: 'replay', target: { id: v.tracePath, kind: 'trace' }, sessionId });
    runs.set(runId, record);
    stats.runs += 1;
    try {
      await ensureWorker();
      record.dispatched = true;
      const res = await dispatchRequest('replay', { runId, tracePath: v.tracePath, mode: 'replay', sessionId: record.sessionId }, record);
      if (record.state === 'starting') {
        record.state = (res && typeof res.state === 'string') ? res.state : 'running';
      }
      return Object.assign({}, res, { mode: 'replay', runId });
    } catch (err) {
      recordDispatchFailure(record, err);
      err.runId = err.runId || runId;
      throw err;
    }
  }

  /**
   * 停止一个 run。estop → (lease 回收) → 独立释放确认——顺序执行、逐项记账。
   * 并发 stop 合并成一次（后到者收 duplicate:true）。
   * @returns {Promise<object>} stop 记录（estopSent/estopAcked/leaseRevoked/releaseConfirmed/
   *          released/releaseError/releaseToolUsed/state/duplicate）
   */
  async function stop(runId) {
    if (disposed) throw rtError('DISPOSED', 'controller is disposed');
    const record = runs.get(runId);
    if (!record) throw rtError('STALE_RUN', `no such run: ${JSON.stringify(runId)}`, { runId, dispatched: false });
    if (record.stop) return Object.assign({}, record.stop, { duplicate: true });
    if (record.stopInFlight) {
      await record.stopInFlight;
      return Object.assign({}, record.stop, { duplicate: true });
    }
    if (record.state === 'failed' && record.dispatched === false) {
      throw rtError('NOT_DISPATCHED', `run ${JSON.stringify(runId)} never dispatched; nothing to stop`, { runId, dispatched: false });
    }
    stats.stops += 1;
    stopHeartbeat(record);
    const stopRecord = makeStopRecord(runId, Date.now());
    record.stopInFlight = (async () => {
      // A native deadline may have stopped and removed the run before the caller asks for
      // stop. Its validated terminal event is the stop/release evidence; do not replace it
      // with the Worker’s idempotent “unknown run” response or an unrelated release tool.
      if (record.nativeTerminal?.stopped && (record.mode !== 'active' || record.nativeTerminal.released)) {
        stopRecord.workerReleased = record.nativeTerminal.released;
        stopRecord.leaseRevoked = record.mode === 'active' && record.nativeTerminal.released;
        stopRecord.released = true;
        stopRecord.detail = 'native terminal event reported the run stopped and released';
        stopRecord.state = 'stopped';
        record.stop = stopRecord;
        record.state = 'stopped';
        return stopRecord;
      }
      const st = client.state;

      // ---- 1) estop：只在 worker 仍可能活着时尝试（safety 通道）----
      if (st === 'ready' || st === 'unhealthy') {
        try {
          const stopArgs = { runId, sessionId: record.sessionId };
          const res = typeof client.stop === 'function'
            ? await client.stop(stopArgs, { timeoutMs: estopTimeoutMs })
            : await client.request('stop', stopArgs, { safety: true, timeoutMs: estopTimeoutMs });
          if (isStaleRunResult(runId, res)) {
            // 回包点名了别的 run：按未确认处理，绝不记 estopAcked
            stopRecord.estopSent = true;
            stopRecord.estopError = 'stop response named a different runId; treating as unacknowledged';
          } else {
            stopRecord.estopSent = true;
            stopRecord.estopAcked = true;
            stopRecord.workerReleased = res && res.released === true;
            stopRecord.leaseRevoked = record.mode === 'active' && stopRecord.workerReleased;
            if (stopRecord.workerReleased) record.lease.held = false;
          }
        } catch (err) {
          stopRecord.estopSent = err.dispatched !== false; // 只有确实写过才记 true
          stopRecord.estopError = `${err.code}: ${err.message}`;
        }
      }

      // ---- 2) 释放记账：分三档，绝不虚构 ----
      if (record.mode !== 'active') {
        stopRecord.released = true;
        stopRecord.releaseConfirmed = false;
        stopRecord.detail = 'never held the write lease; released by construction';
      } else if (stopRecord.estopAcked && stopRecord.workerReleased) {
        // worker 明确报告已释放：released=true（worker 侧声明），releaseConfirmed 仍为 false——
        // 确认要来自独立观察，不能来自被停止方自己的回话
        stopRecord.released = true;
        stopRecord.detail = 'worker reported the write lease released';
      } else {
        // 掉线/未确认：独立释放通道。复用 autoRelease 的结论（一次释放，绝不二次调用）；
        // 没触发过 autoRelease 就现在补一次。
        const outcome = record.autoReleasePromise
          ? await record.autoReleasePromise
          : await (autoReleaseIfNeeded(record) || Promise.resolve({ released: false, usedTool: false, error: 'no independent release tool configured' }));
        applyReleaseOutcome(record, stopRecord, outcome);
      }

      // “没有租约”只证明无需释放，不证明 worker 已停止；两类证据都具备才是 stopped。
      const workerStopped = stopRecord.estopAcked || record.workerStopped === true || record.workerExitObserved === true;
      const releaseSettled = stopRecord.released || stopRecord.releaseConfirmed;
      stopRecord.state = workerStopped && releaseSettled ? 'stopped' : 'stopped-unknown';
      record.stop = stopRecord;
      record.state = stopRecord.state;
      return stopRecord;
    })();
    const result = await record.stopInFlight;
    record.stopInFlight = null;
    return result;
  }

  function applyReleaseOutcome(record, stopRecord, outcome) {
    stopRecord.releaseToolUsed = outcome && outcome.usedTool === true;
    if (outcome && outcome.released === true) {
      record.lease.held = false;
      stopRecord.released = true;
      stopRecord.releaseConfirmed = true;
      stopRecord.detail = (outcome && outcome.detail) || 'independent release tool reported the lease released';
    } else {
      stopRecord.releaseError = (outcome && (outcome.error || outcome.detail)) || 'independent release failed; lease status unknown';
    }
  }

  /** 关闭控制器（不动 worker 生命周期——那是 client 的职责）。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const record of runs.values()) stopHeartbeat(record);
  }

  return { run, status, stop, snapshot, replay, dispose, get stats() { return stats; } };
}

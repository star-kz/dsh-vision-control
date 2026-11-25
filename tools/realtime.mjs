/**
 * Public realtime tools and their host-lifecycle adapter.
 *
 * The frozen controller owns protocol/run evidence. This module adds only host concerns:
 * exact tool registration, per-session Worker construction, global active/slow-write
 * exclusion, and stop/dispose fan-out. It never routes frames through the PowerShell call
 * path and never treats the legacy computer chip as HIL target authorization.
 */
import { RT_TOOL_NAMES } from '../realtime/contracts.mjs';
import { createRealtimeController } from '../realtime/controller.mjs';
import { createWorkerClient } from '../realtime/worker-client.mjs';
import { REALTIME_TOOL_CONTRACTS } from '../internal/tool-contracts.mjs';
import { resolveWorkerLaunch } from './native-runtime.mjs';
import { createNativeHilTargetVerifier } from '../realtime/hil-target-verifier.mjs';

const text = (value) => String(value ?? '');
const sessionOf = (exec) => text(exec?.agent?.session?.id);
const rtError = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { code });

function publicRecord(record) {
  if (!record) return null;
  const { stopInFlight: _stop, autoReleasePromise: _release, heartbeatTimer: _heartbeatTimer, ...value } = record;
  return value;
}

// Controller sequence numbers are local to each session Worker. Namespace the public
// identity so two controllers created in the same millisecond can never alias in the
// host-wide run map. Worker/event wire traffic keeps the original local runId.
const scopedRunId = (sessionId, localRunId) => `${text(sessionId) || 'default'}:${text(localRunId)}`;

function exposeRecord(record, runId) {
  const value = publicRecord(record);
  if (!value) return null;
  return {
    ...value,
    runId,
    ...(value.stop ? { stop: { ...value.stop, runId } } : {}),
  };
}

function numericTargetKey(value) {
  const id = text(value).trim().replace(/^window:/i, '');
  try {
    if (/^0x[0-9a-f]+$/i.test(id) || /^[0-9]+$/.test(id)) return BigInt(id).toString(10);
  } catch { /* An invalid handle stays unknown and therefore conflicts conservatively. */ }
  return null;
}

function targetKey(target) {
  let id = target?.id;
  if (id === undefined || id === null || id === '') return null;
  id = text(id).trim();
  if (text(target?.kind).trim().toLowerCase() === 'hil') {
    // WorkerTargetCatalog emits hil-${hwnd:x}; legacy computer tools carry numeric HWND.
    // They are the same physical input target, not independent ownership domains.
    const match = /^hil-([0-9a-f]+)$/i.exec(id);
    const idKey = match ? numericTargetKey(`0x${match[1]}`) : numericTargetKey(id);
    const rawHandle = target?.handle ?? target?.hwnd;
    const hasHandle = rawHandle !== undefined && rawHandle !== null && rawHandle !== '' && rawHandle !== 0 && rawHandle !== '0';
    const handleKey = hasHandle ? numericTargetKey(rawHandle) : null;
    if ((hasHandle && handleKey === null) || (idKey !== null && handleKey !== null && idKey !== handleKey)) return null;
    return handleKey ?? idKey;
  }
  return numericTargetKey(id) ?? id.replace(/^window:/i, '');
}

function slowTargetKey(args) {
  const direct = args?.hwnd ?? args?.into_hwnd ?? args?.state?.hwnd ?? args?.window?.hwnd;
  const step = Array.isArray(args?.steps)
    ? args.steps.find((candidate) => candidate?.hwnd !== undefined || candidate?.into_hwnd !== undefined)
    : null;
  const value = direct ?? step?.hwnd ?? step?.into_hwnd;
  return value === undefined || value === null ? null : targetKey({ id: value });
}

function sameTarget(a, b) {
  // An unknown target is conservatively global: refusing a write is cheaper than
  // allowing two unknown owners to hold the same physical input device.
  return a === null || b === null || a === b;
}

function asParameters(schema) {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [
    name,
    { ...value, ...(required.has(name) ? { required: true } : {}) },
  ]));
}

export function createRealtimeHost(options = {}) {
  const config = options.config ?? {};
  const env = options.env ?? process.env;
  const injectedFactory = options.clientFactory ?? config.clientFactory ?? config.workerFactory;
  const launch = resolveWorkerLaunch({
    explicitPath: config.workerPath ?? config.worker?.path ?? env.DSH_RT_WORKER_PATH,
    workerArgs: config.workerArgs ?? config.worker?.args,
    packageRoot: options.packageRoot,
    exists: options.fileExists,
    hasClientFactory: typeof injectedFactory === 'function',
    includeBundled: config.bundled !== false && config.worker?.bundled !== false,
  });
  const { workerPath, workerArgs, configured } = launch;
  const nativeVerifyHilTarget = options.nativeHilTargetVerifier ?? createNativeHilTargetVerifier({
    harnessPath: config.harnessPath ?? config.harness?.path ?? env.DSH_RT_HARNESS_PATH,
    packageRoot: options.packageRoot,
    exists: options.fileExists,
    exec: options.nativeExec,
  });
  const verifyHilTarget = options.verifyHilTarget ?? config.verifyHilTarget ?? nativeVerifyHilTarget;
  const runtimes = new Map();
  const runs = new Map();
  const reservations = new Map();
  const slowWrites = new Set();
  const revokedSessions = new Set();
  let disposed = false;
  let reservationSequence = 0;

  const degraded = (code, message, extra = {}) => ({ degraded: true, code, message, ...extra });

  function workerUnavailable() {
    return degraded(
      'RT_WORKER_NOT_CONFIGURED',
      'Realtime Worker is not configured; publish the bundled runtime with npm run build:native, set realtime.workerPath, or set DSH_RT_WORKER_PATH. Shadow and active runs remain unavailable until a real Worker is supplied.',
    );
  }

  function unresolvedRun(record) {
    if (!record) return false;
    return (record.stop?.state ?? record.state) !== 'stopped';
  }

  function unresolvedRuntime(runtime) {
    if (runtime.disposalErrors.length > 0) return true;
    return [...runtime.runIds].some((runId) => unresolvedRun(runs.get(runId)?.record));
  }

  function makeRuntime(sessionId) {
    if (disposed) throw rtError('DISPOSED', 'realtime host is disposed');
    if (revokedSessions.has(sessionId)) throw rtError('SESSION_REVOKED', 'realtime session was revoked; explicit user re-enable is required');
    const existing = runtimes.get(sessionId);
    if (existing && !existing.disposed) return existing;
    if (existing && unresolvedRuntime(existing)) {
      throw rtError('RT_STOP_UNRESOLVED', 'previous realtime Worker still has unresolved stop/release evidence; retry stop before starting a new generation');
    }
    if (!configured) throw rtError('RT_WORKER_NOT_CONFIGURED', 'no realtime Worker path or clientFactory was configured');

    const runtime = {
      sessionId,
      client: null,
      controller: null,
      runIds: new Set(),
      pendingRuns: new Set(),
      stopping: false,
      stopPromise: null,
      disposalErrors: [],
      disposed: false,
    };
    let client;
    try {
      client = typeof injectedFactory === 'function'
        ? injectedFactory({ sessionId, config, env })
        : createWorkerClient({
          command: workerPath,
          args: Array.isArray(workerArgs) ? workerArgs : [],
          ...(config.workerOptions ?? {}),
        });
    } catch (error) {
      throw rtError('RT_WORKER_FACTORY_FAILED', `Realtime Worker factory failed: ${error?.message ?? error}`);
    }
    if (!client || typeof client.request !== 'function') {
      throw rtError('RT_WORKER_FACTORY_FAILED', 'Realtime Worker factory did not return a client with request()');
    }
    runtime.client = client;

    // Bind the real host session at construction; the compatibility wrapper also
    // covers direct client commands such as targets and trace_read.
    const sessionClient = {
      get state() { return client.state; },
      start: (...args) => client.start(...args),
      request: (cmd, args = {}, requestOptions) => client.request(
        cmd,
        args && typeof args === 'object' ? { ...args, sessionId } : args,
        requestOptions,
      ),
      onEvent: (cb) => client.onEvent(cb),
      onExit: (cb) => client.onExit(cb),
      onHealthChange: (cb) => client.onHealthChange(cb),
    };
    const controllerOptions = {
      ...(config.controllerOptions ?? {}),
      // Host identity and safety dependencies are pinned after optional tuning.
      client: sessionClient,
      sessionId,
      verifyHilTarget,
      ...(typeof options.releaseTool === 'function'
        ? { releaseTool: (record) => options.releaseTool({ ...record, sessionId }, { sessionId }) }
        : {}),
    };
    runtime.controller = typeof options.controllerFactory === 'function'
      ? options.controllerFactory(controllerOptions, { sessionId, client })
      : createRealtimeController(controllerOptions);
    runtimes.set(sessionId, runtime);
    return runtime;
  }

  function runtimeForCall(sessionId) {
    try {
      return { runtime: makeRuntime(sessionId) };
    } catch (error) {
      if (error?.code === 'RT_WORKER_NOT_CONFIGURED') return { failure: workerUnavailable() };
      if (error?.code === 'RT_WORKER_FACTORY_FAILED') {
        return { failure: degraded(error.code, error.message) };
      }
      throw error;
    }
  }

  async function requestWorker(runtime, cmd, args) {
    if (runtime.client.state !== 'ready' && runtime.client.state !== 'unhealthy') await runtime.client.start();
    return runtime.client.request(cmd, { ...(args ?? {}), sessionId: runtime.sessionId });
  }

  function knownRun(runId, sessionId) {
    const known = runs.get(runId);
    if (known) {
      if (known.runtime.sessionId !== sessionId) {
        return { failure: { degraded: false, code: 'STALE_RUN', message: 'run is not owned by this session' } };
      }
      return known;
    }
    const { runtime, failure } = runtimeForCall(sessionId);
    if (failure) return { failure };
    return {
      runtime,
      record: null,
      localRunId: runId,
      publicRunId: runId,
    };
  }

  function assertNotRevoked(sessionId) {
    if (disposed) throw rtError('DISPOSED', 'realtime host is disposed');
    if (revokedSessions.has(sessionId)) {
      throw rtError('SESSION_REVOKED', 'realtime session was revoked; explicit user re-enable is required');
    }
  }

  function reservationHolds(reservation) {
    if (!reservation.record) return true;
    if (reservation.record.stop?.released === true || reservation.record.stop?.releaseConfirmed === true) return false;
    return reservation.record.dispatched === true && reservation.record.lease?.held === true;
  }

  function reserveActive(sessionId, target) {
    const key = targetKey(target);
    for (const reservation of reservations.values()) {
      if (!reservationHolds(reservation)) continue;
      if (sameTarget(key, reservation.targetKey) && (reservation.sessionId !== sessionId || key === reservation.targetKey || key === null || reservation.targetKey === null)) {
        throw rtError('TARGET_BUSY', `active target ${text(target?.id)} is already owned by session ${reservation.sessionId}`);
      }
    }
    for (const write of slowWrites) {
      if (sameTarget(key, write.targetKey)) {
        throw rtError('SLOW_WRITE_BUSY', `active target ${text(target?.id)} conflicts with an executing legacy desktop write`);
      }
    }
    const token = `pending-${++reservationSequence}`;
    const reservation = { token, sessionId, targetKey: key, record: null, runId: null };
    reservations.set(token, reservation);
    return reservation;
  }

  async function targets(args, exec) {
    const { runtime, failure } = runtimeForCall(sessionOf(exec));
    if (failure) return { ...failure, targets: [] };
    const result = await requestWorker(runtime, 'targets', args);
    return { degraded: false, ...result, targets: Array.isArray(result?.targets) ? result.targets : [] };
  }

  async function skillValidate(args, exec) {
    const { runtime, failure } = runtimeForCall(sessionOf(exec));
    if (failure) return { ...failure, result: null };
    const result = await requestWorker(runtime, 'skill_validate', args);
    return { degraded: false, result };
  }

  async function calibrate(args, exec) {
    const { runtime, failure } = runtimeForCall(sessionOf(exec));
    if (failure) return { ...failure, result: null };
    const result = await requestWorker(runtime, 'calibrate', args);
    return { degraded: false, result };
  }

  async function run(args, exec) {
    const sessionId = sessionOf(exec);
    assertNotRevoked(sessionId);
    if (!configured) return { ...workerUnavailable(), state: 'degraded' };
    const { runtime, failure } = runtimeForCall(sessionId);
    if (failure) return { ...failure, state: 'degraded' };
    if (runtime.stopping) throw rtError('RT_STOP_IN_PROGRESS', 'realtime session is stopping; no new run mutation may be dispatched');
    const active = args?.mode === 'active';
    const reservation = active ? reserveActive(sessionId, args.target) : null;
    let finishPending;
    const pending = new Promise((resolve) => { finishPending = resolve; });
    // Register before slow-controller claiming and controller.run(): the latter allocates
    // its local id and dispatches input before its promise (and therefore our runId) settles.
    runtime.pendingRuns.add(pending);
    try {
      if (active && typeof options.claimSlowController === 'function') {
        await options.claimSlowController(sessionId, args.target);
      }
      const record = await runtime.controller.run({ ...(args ?? {}), signal: exec?.signal });
      record.sessionId = sessionId;
      const publicRunId = scopedRunId(sessionId, record.runId);
      runtime.runIds.add(publicRunId);
      runs.set(publicRunId, { runtime, record, localRunId: record.runId, publicRunId });
      if (reservation) {
        reservation.record = record;
        reservation.runId = publicRunId;
      }
      return { degraded: false, ...exposeRecord(record, publicRunId) };
    } catch (error) {
      if (error?.runId && error?.dispatched === true) {
        // The frozen controller has the authoritative record, but its local id is not
        // host-unique. Track a conservative unknown projection immediately so revoke,
        // dispose and target exclusion still cover a dispatched run with a bad/lost ack.
        const localRunId = text(error.runId);
        const publicRunId = scopedRunId(sessionId, localRunId);
        const record = {
          runId: localRunId,
          sessionId,
          mode: active ? 'active' : 'shadow',
          skill: args?.skill,
          target: args?.target,
          state: 'unknown',
          dispatched: true,
          lease: { held: active },
          stop: null,
          error: { code: error.code, message: error.message, dispatched: true },
        };
        runtime.runIds.add(publicRunId);
        runs.set(publicRunId, { runtime, record, localRunId, publicRunId });
        if (reservation) {
          reservation.record = record;
          reservation.runId = publicRunId;
        }
        error.runId = publicRunId;
      }
      if (reservation && !reservation.record) reservations.delete(reservation.token);
      throw error;
    } finally {
      runtime.pendingRuns.delete(pending);
      finishPending();
    }
  }

  async function status(args, exec) {
    const known = knownRun(args?.runId, sessionOf(exec));
    if (known.failure) return { ...known.failure, runId: args?.runId, record: null, live: null };
    if (known.runtime.disposed && known.record) {
      return { degraded: false, runId: known.publicRunId, record: exposeRecord(known.record, known.publicRunId), live: null, liveError: { code: 'DISPOSED', message: 'runtime disposed' } };
    }
    const result = await known.runtime.controller.status(known.localRunId);
    if (result.record) result.record.sessionId = known.runtime.sessionId;
    if (known.record && result.record) Object.assign(known.record, result.record);
    return {
      degraded: false,
      runId: known.publicRunId,
      record: exposeRecord(result.record, known.publicRunId),
      live: result.live ? { ...result.live, runId: known.publicRunId } : null,
      ...(result.liveError ? { liveError: result.liveError } : {}),
    };
  }

  function publicStop(known, result, duplicate = false) {
    return {
      degraded: false,
      ...result,
      runId: known.publicRunId,
      stopped: result.state === 'stopped',
      ...(duplicate ? { duplicate: true } : {}),
    };
  }

  function unknownStop(known, error = null) {
    const record = known.record;
    const active = record?.mode === 'active';
    const result = {
      runId: known.localRunId,
      state: 'stopped-unknown',
      estopSent: error?.dispatched === true,
      estopAcked: false,
      released: !active,
      releaseConfirmed: false,
      ...(active ? {} : { detail: 'never held the write lease; released by construction' }),
      ...(error ? { estopError: `${error.code ?? 'STOP_FAILED'}: ${error.message ?? error}` } : {}),
    };
    if (record) {
      record.stop = result;
      record.state = result.state;
    }
    return result;
  }

  async function retryIndependentRelease(known, result) {
    const record = known.record;
    if (!record || typeof options.releaseTool !== 'function') return result;
    if (record.mode !== 'active' || record.dispatched !== true || record.lease?.held !== true) return result;
    if (result.state === 'stopped' || result.released === true || result.releaseConfirmed === true) return result;

    // controller.stop() caches an unsuccessful autoReleasePromise. Once that attempt is
    // settled, retry only the independent release channel; never dispatch run or another
    // non-idempotent input sequence. Worker stop evidence is retained separately.
    const next = { ...result, releaseToolUsed: true, duplicate: true };
    let outcome;
    try {
      outcome = await options.releaseTool(
        { ...record, sessionId: record.sessionId ?? known.runtime.sessionId },
        { sessionId: known.runtime.sessionId },
      );
    } catch (error) {
      next.state = 'stopped-unknown';
      next.releaseError = `independent release retry failed: ${error?.message ?? error}`;
      record.stop = next;
      record.state = next.state;
      return next;
    }
    if (outcome?.released === true) {
      record.lease.held = false;
      next.released = true;
      next.releaseConfirmed = true;
      next.detail = outcome.detail || 'independent release tool reported the lease released';
      delete next.releaseError;
      const workerStopped = next.estopAcked === true || record.workerStopped === true || record.workerExitObserved === true;
      next.state = workerStopped ? 'stopped' : 'stopped-unknown';
    } else {
      next.state = 'stopped-unknown';
      next.releaseError = outcome?.error || outcome?.detail || 'independent release failed; lease status unknown';
    }
    record.stop = next;
    record.state = next.state;
    return next;
  }

  async function stop(args, exec) {
    const known = knownRun(args?.runId, sessionOf(exec));
    if (known.failure) return { ...known.failure, runId: args?.runId, stopped: false };
    if (known.runtime.disposed && known.record) {
      const current = known.record.stop ?? unknownStop(known);
      const result = await retryIndependentRelease(known, current);
      return publicStop(known, result, true);
    }
    let result = await known.runtime.controller.stop(known.localRunId);
    if (known.record) {
      known.record.stop = result;
      known.record.state = result.state;
      if (result.duplicate === true && result.state !== 'stopped') {
        result = await retryIndependentRelease(known, result);
      }
    }
    return publicStop(known, result);
  }

  async function snapshot(args, exec) {
    const known = knownRun(args?.runId, sessionOf(exec));
    if (known.failure) return { ...known.failure, runId: args?.runId, snapshot: null };
    const result = await known.runtime.controller.snapshot(known.localRunId);
    const { runId: _runId, ...snapshot } = result ?? {};
    return { degraded: false, runId: known.publicRunId, snapshot };
  }

  async function replay(args, exec) {
    const sessionId = sessionOf(exec);
    assertNotRevoked(sessionId);
    if (!configured) return { ...workerUnavailable(), mode: 'replay', result: null };
    const { runtime, failure } = runtimeForCall(sessionId);
    if (failure) return { ...failure, mode: 'replay', result: null };
    const result = await runtime.controller.replay(args ?? {});
    const record = {
      runId: result.runId, mode: 'replay', skill: 'replay', target: { id: args.tracePath, kind: 'trace' },
      sessionId, state: result.state ?? 'running', dispatched: true, lease: { held: false }, stop: null,
    };
    const publicRunId = scopedRunId(sessionId, result.runId);
    runtime.runIds.add(publicRunId);
    runs.set(publicRunId, { runtime, record, localRunId: result.runId, publicRunId });
    const { runId: _localRunId, mode, ...rest } = result;
    return { degraded: false, runId: publicRunId, mode, result: rest };
  }

  async function traceRead(args, exec) {
    const { runtime, failure } = runtimeForCall(sessionOf(exec));
    if (failure) return { ...failure, result: null };
    const result = await requestWorker(runtime, 'trace_read', args);
    return { degraded: false, result };
  }

  function resumeSession(sessionId) {
    if (disposed) throw rtError('DISPOSED', 'realtime host is disposed');
    // Only the explicit user state route calls this. Model-facing stop/run tools cannot
    // clear a revocation on their own; the next run creates a fresh Worker generation.
    revokedSessions.delete(text(sessionId));
    return { ok: true };
  }

  async function stopSession(sessionId, { revoke = false, reason = 'host stop' } = {}) {
    sessionId = text(sessionId);
    if (revoke) revokedSessions.add(sessionId);
    const runtime = runtimes.get(sessionId);
    if (!runtime) {
      return { ok: true, stopped: 0, unknown: 0, errors: [], results: [], error: '', reason };
    }
    if (runtime.stopPromise) return runtime.stopPromise;
    if (runtime.disposed && !unresolvedRuntime(runtime)) {
      return { ok: true, stopped: 0, unknown: 0, errors: [], results: [], error: '', reason };
    }
    runtime.stopping = true;
    const operation = (async () => {
      // run() registers this always-resolving promise before controller.run() can dispatch.
      // No new run can enter after stopping=true, so one snapshot is the complete mutation set.
      const pending = [...runtime.pendingRuns];
      if (pending.length > 0) await Promise.all(pending);

      const results = [];
      const errors = [];
      const candidates = [...runtime.runIds].filter((runId) => (
        !runtime.disposed || unresolvedRun(runs.get(runId)?.record)
      ));
      for (const runId of candidates) {
        try {
          const result = await stop({ runId }, { agent: { session: { id: sessionId } } });
          results.push(result);
          if (result.state !== 'stopped') errors.push(`${runId}: ${result.state ?? 'unknown'} ${result.releaseError ?? result.estopError ?? ''}`.trim());
        } catch (error) {
          errors.push(`${runId}: ${error?.message ?? error}`);
          const known = runs.get(runId);
          if (known?.record?.dispatched === true) {
            // A failed stop call is itself unresolved evidence. Keep a public record so a
            // later stop/disabled transition can retry only the independent release channel.
            const current = known.record.stop ?? unknownStop(known, error);
            const settled = await retryIndependentRelease(known, current);
            results.push(publicStop(known, settled, true));
          }
        }
      }
      if (!runtime.disposed) {
        runtime.disposed = true;
        try { runtime.controller.dispose(); } catch (error) {
          runtime.disposalErrors.push(`controller dispose: ${error?.message ?? error}`);
        }
        try { await runtime.client.dispose(); } catch (error) {
          runtime.disposalErrors.push(`worker dispose: ${error?.message ?? error}`);
        }
      }
      errors.push(...runtime.disposalErrors);
      const unknown = results.filter((result) => result.state !== 'stopped').length;
      return {
        ok: errors.length === 0,
        stopped: results.length - unknown,
        unknown,
        errors,
        results,
        error: errors.join('; '),
        reason,
      };
    })();
    runtime.stopPromise = operation;
    try {
      return await operation;
    } finally {
      if (runtime.stopPromise === operation) runtime.stopPromise = null;
    }
  }

  async function stopAll({ reason = 'host stop', revokeSessionId = null } = {}) {
    const results = [];
    const sessions = [];
    const errors = [];
    let stopped = 0;
    let unknown = 0;
    for (const sessionId of [...runtimes.keys()]) {
      const result = await stopSession(sessionId, {
        revoke: revokeSessionId !== null && text(revokeSessionId) === sessionId,
        reason,
      });
      sessions.push({ sessionId, ...result });
      results.push(...result.results);
      stopped += result.stopped;
      unknown += result.unknown;
      if (result.error) errors.push(`${sessionId}: ${result.error}`);
    }
    return { ok: errors.length === 0, stopped, unknown, errors, results, sessions, error: errors.join('; '), reason };
  }

  async function dispose() {
    // Disposal is repeatable for unresolved leases: stopSession retains the records and
    // safely retries independent release instead of turning a later dispose into fake success.
    disposed = true;
    const results = [];
    const errors = [];
    let stopped = 0;
    let unknown = 0;
    for (const sessionId of runtimes.keys()) {
      const result = await stopSession(sessionId, { revoke: false, reason: 'plugin dispose' });
      results.push(result);
      stopped += result.stopped;
      unknown += result.unknown;
      if (result.error) errors.push(`${sessionId}: ${result.error}`);
    }
    return { ok: errors.length === 0, stopped, unknown, errors, results, error: errors.join('; ') };
  }

  function beginSlowWrite(sessionId, args = {}) {
    sessionId = text(sessionId);
    const key = slowTargetKey(args);
    for (const reservation of reservations.values()) {
      if (!reservationHolds(reservation)) continue;
      if (sameTarget(key, reservation.targetKey)) {
        throw rtError('RT_TARGET_BUSY', `legacy desktop write conflicts with active realtime run ${reservation.runId ?? reservation.token}`);
      }
    }
    const token = { sessionId, targetKey: key };
    slowWrites.add(token);
    return token;
  }

  function endSlowWrite(token) {
    if (token) slowWrites.delete(token);
  }

  return {
    targets, skillValidate, calibrate, run, status, stop, snapshot, replay, traceRead,
    resumeSession, stopSession, stopAll, dispose, beginSlowWrite, endSlowWrite,
    get configured() { return configured; },
    get stats() { return { sessions: runtimes.size, runs: runs.size, slowWrites: slowWrites.size, disposed }; },
  };
}

/** Register each frozen name independently; one bad schema cannot remove legacy or sibling RT tools. */
export function registerRealtimeTools(env = {}) {
  const host = env.host ?? createRealtimeHost({
    config: env.config ?? {},
    env: env.env,
    clientFactory: env.clientFactory,
    controllerFactory: env.controllerFactory,
    verifyHilTarget: env.verifyHilTarget,
    releaseTool: env.releaseTool,
    claimSlowController: env.claimSlowController,
  });
  const methods = {
    realtime_targets: host.targets,
    realtime_skill_validate: host.skillValidate,
    realtime_calibrate: host.calibrate,
    realtime_run: host.run,
    realtime_status: host.status,
    realtime_stop: host.stop,
    realtime_snapshot: host.snapshot,
    realtime_replay: host.replay,
    realtime_trace_read: host.traceRead,
  };
  const registrations = [];
  for (const name of RT_TOOL_NAMES) {
    try {
      const contract = REALTIME_TOOL_CONTRACTS[name];
      const definition = env.defineTracedTool({
        name,
        description: `Realtime control-plane tool ${name}. Watch mode permits observation, shadow and replay only. Active input additionally requires control mode, explicit target authorization and an independently verified dedicated HIL target.`,
        parameters: asParameters(contract.parameters),
        output: contract.output,
        execute: (args, exec) => {
          env.requireRealtime?.(exec, name, args ?? {});
          return methods[name](args ?? {}, exec);
        },
      });
      env.safeRegister(definition);
      registrations.push(name);
    } catch (error) {
      env.logger?.error?.('realtime: isolated registration failure for %s: %s', name, error?.message ?? error);
    }
  }
  host.registrations = registrations;
  return host;
}

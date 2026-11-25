/**
 * realtime/contracts.mjs — 控制面契约层（Task 5）。
 *
 * 钉死 Node 控制面与 Worker 之间 JSONL/stdio 协议的公开形状：
 *   - 协议版本与握手包络（hello/welcome）；
 *   - 控制面单行字节上限（数据面——帧与轨迹——永远不经过 Node）；
 *   - 公开工具名清单（一次定型，见 plan Task 5）；
 *   - run/replay 请求校验、active 显式授权规则、stop 记录的诚实初值；
 *   - 旧 runId / 回落 sourceEpoch 判定（拒绝过期回包与过期事件）。
 *
 * 本模块是纯数据层：不 spawn 进程、不碰 IO，供 worker-client.mjs（传输层）与
 * controller.mjs（控制面）共同依赖，也可被上层工具注册直接复用。
 */

/** 控制面协议版本。hello/welcome 两侧必须一致，否则 PROTOCOL_MISMATCH。 */
export const RT_PROTOCOL_VERSION = 1;

/**
 * 控制面单行（一条 JSONL）的最大字节数。控制面只承载命令、状态、事件与路径引用，
 * 永远不是帧通道——超限行直接拒收并计数（oversized），不尝试解析。
 */
export const RT_MAX_CONTROL_LINE_BYTES = 256 * 1024;

/**
 * Task 5 公开工具名，一次定型。后续任务把这份清单注册进 tool-contracts；
 * 本模块冻结它，防止运行期被悄悄扩充。
 */
export const RT_TOOL_NAMES = Object.freeze([
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

/** run 的三种模式：shadow（默认只读观察）、active（真实输入，需显式授权）、replay（离线回放）。 */
export const RUN_MODES = Object.freeze(['shadow', 'active', 'replay']);

/**
 * 控制面自身推进的 run 状态。Worker 事件可以带来更细的状态字符串（如 'calibrating'），
 * 这份枚举只钉死控制面语义上有区分度的状态：unknown/stopped-unknown 用于"结局未知"，
 * 绝不与 stopped 混用。
 */
export const RUN_STATES = Object.freeze([
  'starting', 'running', 'stopping', 'stopped', 'stopped-unknown', 'unknown', 'failed',
]);

/** 传输层与控制面共用的错误码。error.dispatched 标志"请求是否已写给 worker"。 */
export const RT_ERROR_CODES = Object.freeze([
  'PROTOCOL_MISMATCH', 'START_TIMEOUT', 'SPAWN_FAILED', 'WRITE_FAILED', 'WORKER_EXITED',
  'HEARTBEAT_LOST', 'TIMEOUT', 'ABORTED', 'DISPOSED', 'NOT_STARTED',
  'STALE_RUN', 'NOT_AUTHORIZED', 'NOT_DISPATCHED', 'TARGET_BUSY', 'BAD_REQUEST', 'WORKER_ERROR',
]);

/** active 模式唯一允许的目标类型：宿主自建的 HIL（human-in-the-loop）目标。 */
export const HIL_TARGET_KIND = 'hil';

function bad(message) {
  return { ok: false, code: 'BAD_REQUEST', message };
}

/** 入口边界取得深拷贝并深冻结，调用方之后不能再借异步窗口改写授权/派发对象。 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/**
 * 校验 worker 的 hello 包络。协议号只要是整数就放行（版本比对由调用方做，
 * 这样版本不符可以报出具体的 PROTOCOL_MISMATCH 信息）。
 * @returns {{ok: boolean, protocol?: number, capabilities?: string[], worker?: object, pid?: number}}
 */
export function validateHello(msg) {
  if (!msg || typeof msg !== 'object' || msg.rt !== 'hello') return { ok: false };
  if (!Number.isInteger(msg.protocol)) return { ok: false };
  const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((c) => typeof c === 'string') : [];
  return { ok: true, protocol: msg.protocol, capabilities, worker: msg.worker ?? null, pid: msg.pid ?? null };
}

/**
 * 校验一条应答包络（rt:'res'）。只验形状：id 必须是非空字符串，ok 必须是布尔，
 * ok:false 必须携带 error 对象。id 是否属于某个在途请求由传输层判断（不属于则计 orphan）。
 * @returns {{ok: boolean}} 形状合法返回 {ok:true,...原始字段}
 */
export function validateResponseEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || msg.rt !== 'res') return { ok: false };
  if (typeof msg.id !== 'string' || msg.id.length === 0) return { ok: false };
  if (typeof msg.ok !== 'boolean') return { ok: false };
  if (msg.ok === false && (!msg.error || typeof msg.error !== 'object')) return { ok: false };
  return { ...msg, ok: true };
}

/**
 * 校验一次 run 请求。不写 mode 默认 shadow（默认安全：不注入任何真实输入）。
 * @returns {{ok: true, mode: string, skill: string, target: object, deadlineMs: number|null}}
 *          或 {{ok: false, code: 'BAD_REQUEST', message}}
 */
export function validateRunSpec(spec) {
  if (!spec || typeof spec !== 'object') return bad('run spec must be an object');
  if (typeof spec.skill !== 'string' || spec.skill.trim().length === 0) return bad('run spec requires a non-empty skill');
  if (!spec.target || typeof spec.target !== 'object') return bad('run spec requires a target object');
  if (typeof spec.target.id !== 'string' || spec.target.id.length === 0) return bad('run target requires a non-empty id');
  if (typeof spec.target.kind !== 'string' || spec.target.kind.length === 0) return bad('run target requires a kind');
  const mode = spec.mode === undefined || spec.mode === null ? 'shadow' : spec.mode;
  if (!RUN_MODES.includes(mode)) return bad(`unknown run mode ${JSON.stringify(mode)}; expected one of ${RUN_MODES.join('/')}`);
  let deadlineMs = null;
  if (spec.deadlineMs !== undefined && spec.deadlineMs !== null) {
    if (!Number.isSafeInteger(spec.deadlineMs) || spec.deadlineMs < 1 || spec.deadlineMs > 86_400_000) {
      return bad('deadlineMs must be an integer in the native range [1, 86400000] milliseconds');
    }
    deadlineMs = spec.deadlineMs;
  }
  let target;
  let authorization;
  try {
    target = deepFreeze(structuredClone(spec.target));
    authorization = spec.authorization == null
      ? spec.authorization
      : deepFreeze(structuredClone(spec.authorization));
  } catch {
    return bad('run target and authorization must be structured-cloneable and deeply freezable');
  }
  return { ok: true, mode, skill: spec.skill, target, deadlineMs, authorization };
}

/**
 * active 模式的显式授权检查。授权是"描述符"不是凭证：必须点名本次 run 的 targetId 且
 * granted===true。授权不可跨目标转移——点了别的目标的授权在这里就是拒绝。
 * @returns {{ok: true}} 或 {{ok: false, code: 'NOT_AUTHORIZED', message}}
 */
export function validateActiveAuthorization({ mode, target, authorization }) {
  if (mode !== 'active') return { ok: true };
  if (!authorization || typeof authorization !== 'object' || authorization.granted !== true) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'active mode requires an explicit authorization descriptor with granted=true' };
  }
  if (typeof authorization.targetId !== 'string' || authorization.targetId !== target.id) {
    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: `authorization does not transfer: grant names target ${JSON.stringify(authorization.targetId)} but run targets ${JSON.stringify(target.id)}`,
    };
  }
  const hasQpc = authorization.expiresQpc !== undefined;
  const hasMs = authorization.expiresAtMs !== undefined;
  if (hasQpc === hasMs) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'active authorization requires exactly one of expiresQpc or expiresAtMs' };
  }
  if (hasQpc && (!Number.isSafeInteger(authorization.expiresQpc) || authorization.expiresQpc <= 0)) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'authorization.expiresQpc must be a positive safe integer' };
  }
  if (hasMs && (!Number.isSafeInteger(authorization.expiresAtMs) || authorization.expiresAtMs <= Date.now())) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'authorization.expiresAtMs must be a future Unix millisecond timestamp' };
  }
  if (authorization.leaseId !== undefined && (typeof authorization.leaseId !== 'string' || authorization.leaseId.trim().length === 0)) {
    return { ok: false, code: 'NOT_AUTHORIZED', message: 'authorization.leaseId must be a nonempty string when supplied' };
  }
  return { ok: true };
}

/**
 * 校验回放请求。回放是纯离线动作：tracePath 必填，mode 只能是 replay（缺省即 replay）。
 * mode:'active' 直接拒绝——回放永不注入真实输入。
 * @returns {{ok: true, tracePath: string, mode: 'replay'}} 或 BAD_REQUEST
 */
export function validateReplaySpec(spec) {
  if (!spec || typeof spec !== 'object') return bad('replay spec must be an object');
  if (typeof spec.tracePath !== 'string' || spec.tracePath.trim().length === 0) {
    return bad('replay spec requires a non-empty tracePath');
  }
  const mode = spec.mode === undefined || spec.mode === null ? 'replay' : spec.mode;
  if (mode === 'active') {
    return bad('replay never injects real input; mode "active" is not permitted for offline replay');
  }
  if (mode !== 'replay') return bad(`unknown replay mode ${JSON.stringify(mode)}`);
  return { ok: true, tracePath: spec.tracePath, mode: 'replay' };
}

/**
 * stop 记录初值：所有"确认类"字段一律 false/null。停止是一个证据收集过程，
 * 任何字段只有在真实证据到位后才被置真——绝不允许初值撒谎。
 */
export function makeStopRecord(runId, requestedAtMs) {
  return {
    runId,
    requestedAtMs,
    estopSent: false,
    estopAcked: false,
    leaseRevoked: false,
    releaseConfirmed: false,
    released: false,
    releaseError: null,
    releaseToolUsed: false,
    state: null,
    duplicate: false,
    detail: null,
    estopError: null,
    workerReleased: false,
  };
}

/**
 * 建 run 记录。只有 active 持写租约（lease.held）；deadline 是元数据——
 * native deadline 的执行在 worker 侧，Node 只记录、不代为执行。
 * @param {{runId: string, mode: string, skill: string, target: object,
 *          sessionId?: string, deadlineMs?: number|null, now?: () => number}} input
 */
export function makeRunRecord({ runId, mode, skill, target, sessionId = 'default', deadlineMs = null, now = Date.now }) {
  const t = now();
  return {
    runId,
    mode,
    skill,
    target,
    sessionId,
    createdAtMs: t,
    state: 'starting',
    dispatched: false,
    lease: { held: mode === 'active', acquiredAtMs: t },
    deadline: deadlineMs != null ? { deadlineMs, setAtMs: t } : null,
    sourceEpochMax: null,
    eventSeqMax: null,
    lastEventAtMs: null,
    stop: null,
    stopInFlight: null,
    autoRelease: null,
    autoReleasePromise: null,
    error: null,
  };
}

/**
 * 结果是否携带了**别的** run 的 runId（旧/错位回包）。结果没有 runId 字段（非 run 作用域
 * 的应答）不算 stale——只有"点名了且点错了"才拒绝。
 */
export function isStaleRunResult(expectedRunId, result) {
  if (!result || typeof result !== 'object') return false;
  if (result.runId === undefined || result.runId === null) return false;
  return result.runId !== expectedRunId;
}

/**
 * 事件 sourceEpoch 是否应拒收：必须是 safe nonnegative integer，且不得小于当前最大值。
 * 同一个 native epoch 可以产生多条事件，由 eventSeq 区分；只有缺失/畸形/回退才 stale。
 */
export function isStaleEpoch(currentEpoch, eventEpoch) {
  if (!Number.isSafeInteger(eventEpoch) || eventEpoch < 0) return true;
  if (currentEpoch === null || currentEpoch === undefined) return false;
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0) return true;
  return eventEpoch < currentEpoch;
}

/** 每个 run 的 eventSeq 必须严格递增；重复、回退与畸形序号都 fail-closed。 */
export function isStaleEventSeq(currentSeq, eventSeq) {
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) return true;
  if (currentSeq === null || currentSeq === undefined) return false;
  if (!Number.isSafeInteger(currentSeq) || currentSeq < 0) return true;
  return eventSeq <= currentSeq;
}

/**
 * 默认 HIL 目标验证器。本阶段没有接任何真实 HIL 窗口验证，因此**永不放行** active：
 * 类型不对拒绝，类型对也诚实拒绝（"未接线"），而不是静默放行。
 * 上层接好真实验证器后注入替换。
 */
export async function defaultVerifyHilTarget(target) {
  if (!target || target.kind !== HIL_TARGET_KIND) {
    return { ok: false, reason: `refusing active input for non-HIL target kind ${JSON.stringify(target?.kind)}: only self-built HIL targets may receive active input` };
  }
  return { ok: false, reason: 'HIL target verification is not wired in this phase; active input injection is unavailable until a real verifier is injected' };
}

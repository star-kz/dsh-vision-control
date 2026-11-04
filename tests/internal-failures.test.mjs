/**
 * 表征测试：internal/failures.mjs —— 失败分类契约。
 *
 * 任务书核心：FAILURE_RULES 样本串断言（方案「共识 16 的测试期载体」）。
 * 每条规则配一句**命中本规则、且不命中任何更早规则**的样本串
 * （FAILURE_RULES 顺序即优先级，第一条命中即用——样本串因此同时钉住正则与顺序）。
 *
 * 本快照表征的是 2026-11-04 12:15 的版本：彼时另一代理（dev-failures）已合入
 * 优-P1-10/11——统一头格式 `[CODE · retry=X]`、HELPER_UNAVAILABLE 拆两态、
 * 新增 DEADLINE_EXHAUSTED / PARTIAL_INPUT、IDEMPOTENT_COMMANDS 删去 'wait'、
 * WORKER_EXITED 按 "did not start" 分两态。若此后规则表再变，本文件的红灯即契约变更信号。
 *
 * 另覆盖：decorateFailure 的格式 / 幂等守卫 / 未命中透传、TIMEOUT 与第二条
 * HELPER_UNAVAILABLE 的 idempotent 分叉、backendMessage 分支、isIdempotentCall 判定表、
 * withOutcomeNote 未知结局前缀、STEP_ACTION_LIST / UIA_ACTION_LIST 逐字契约（顺序即契约）。
 *
 * 本文件独立可跑：node --test tests/internal-failures.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILURE_RULES, decorateFailure, backendMessage, withOutcomeNote,
  isIdempotentCall, READ_ONLY_ACTIONS, READ_ONLY_STEPS,
  IDEMPOTENT_STEP_ACTIONS, IDEMPOTENT_COMMANDS,
  STEP_ACTION_LIST, UIA_ACTION_LIST,
} from '../internal/failures.mjs';
import { ComputerUseBackendError } from '../backend/bridge.js';

/**
 * 与 FAILURE_RULES 定义顺序一一对应：[code, retry, 样本串, 可选的 hint 必含片段]。
 * 样本串的挑选约束：命中本规则、且不命中任何排在它前面的规则。
 */
const RULE_SAMPLES = [
  ['BACKEND_BLOCKED_BY_AV', 'never', 'ScriptContainedMaliciousContent'],
  ['FRONT_NOT_TARGET', 'never', 'the chord was aimed at hwnd 1234 but the foreground is 5678'],
  ['FOREGROUND_REQUIRED', 'never', 'no window holds the foreground'],
  ['POINTER_NOT_SETTLED', 'retry', '[POINTER_NOT_SETTLED] the pointer was moved to 100,200 and is still at 150,200'],
  ['SEND_INPUT_BLOCKED', 'never', 'SendInput delivered no events to the desktop'],
  ['SCREEN_LOCKED', 'never', 'the workstation is locked'],
  ['OUT_OF_BOUNDS', 'reobserve', 'point (5000, 300) is outside the virtual desktop'],
  ['EXPIRED_FRAME', 'reobserve', "frame 'f3' is not in this worker"],
  ['FRAME_STALE', 'reobserve', 'the window moved 25px since frame f1 was captured'],
  ['FRAME_CONTENT_CHANGED', 'reobserve', '[FRAME_CONTENT_CHANGED] the list refreshed itself'],
  ['TARGET_OCCLUDED', 'reobserve', '[TARGET_OCCLUDED] another window covers the point'],
  ['COORDINATE_MAPPING_UNKNOWN', 'reobserve', '[COORDINATE_MAPPING_UNKNOWN] missing encoded size'],
  ['CONDITION_TIMEOUT', 'reobserve', '[CONDITION_TIMEOUT] condX did not hold'],
  ['FRAME_REGION_OUTSIDE_WINDOW', 'never', 'the region is not inside the captured window'],
  ['STALE_REF', 'reobserve', "ref 'r12' retired when older observations were dropped"],
  ['TARGET_CHANGED', 'reobserve', 'the handle has been recycled by the OS'],
  ['REOBSERVE_REQUIRED', 'reobserve', 'the window in front changed during this batch'],
  ['ELEMENT_UNAVAILABLE', 'reobserve', 'no UI Automation element matched the selector'],
  ['AMBIGUOUS_APP', 'never', "[AMBIGUOUS_MATCH] 'notepad' matches 3 applications"],
  ['AMBIGUOUS_MATCH', 'reobserve', 'index 5 is out of range (3 matches)'],
  ['TEXT_RANGE_SPLITS_SURROGATE_PAIR', 'never', 'the prefix is outside the Basic Multilingual Plane'],
  ['NOT_SELECTABLE', 'never', "the text 'abc' was not found in this element"],
  ['CARET_UNAVAILABLE', 'never', 'needs TextPattern2, which the managed UI Automation wrapper does not expose'],
  ['ACTION_UNAVAILABLE', 'never', 'the element does not support Invoke'],
  ['TREE_UNAVAILABLE', 'reobserve', 'could not resolve a UI Automation root for hwnd 99'],
  ['CLIPBOARD_BUSY', 'retry', 'the clipboard is held open by another process'],
  ['RESTORE_UNSUPPORTED', 'never', '[RESTORE_UNSUPPORTED] clipboard holds a file list'],
  ['LAUNCH_FAILED', 'never', 'could not start the target'],
  ['CAPTURE_TOO_LARGE', 'never', 'a capture region may be at most 16384 pixels'],
  ['DISPLAY_UNKNOWN', 'never', 'display 7 is out of range'],
  ['CAPTURE_SURFACE_UNAVAILABLE', 'reobserve', 'the capture came back with no contrast at all'],
  ['WINDOW_MINIMIZED', 'never', 'the window is minimized: what it would render is the placeholder image'],
  ['WINDOW_GONE', 'reobserve', 'hwnd 0x12ab is not a window any more'],
  ['DISPLAY_TOPOLOGY_CHANGED', 'reobserve', 'the display layout changed since frame f9'],
  ['DPI_CHANGED', 'reobserve', '[DPI_CHANGED] scale is now 144'],
  ['BAD_REQUEST', 'never', 'unknown command "frob"'],
  ['TIMEOUT', 'retry', 'the worker did not answer within 20000 ms'],
  ['CANCELLED', 'never', '[CANCELED] the user pressed stop'],
  ['DEADLINE_EXHAUSTED', 'reobserve', '[DEADLINE_EXHAUSTED] budget used up at step 3'],
  ['PARTIAL_INPUT', 'reobserve', '[PARTIAL_INPUT] only half the keys landed'],
  ['UNKNOWN_OUTCOME', 'reobserve', '[UNKNOWN_OUTCOME] click may or may not have happened'],
  ['HELPER_UNAVAILABLE', 'retry', 'the worker could not be started at all', '从未起来'],
  ['HELPER_UNAVAILABLE', 'retry', 'backend process exited unexpectedly', '之前在服务'],
];

test('FAILURE_RULES 样本串：每条规则命中自己的 code，头格式 [CODE · retry=X]，附「下一步：」', () => {
  assert.deepEqual(
    FAILURE_RULES.map((r) => `${r.code}|${r.retry}`),
    RULE_SAMPLES.map(([code, retry]) => `${code}|${retry}`),
    '规则表（code/顺序/retry）与本测试快照不一致——契约变了，样本表需同步',
  );
  RULE_SAMPLES.forEach(([code, retry, sample, hintPart], i) => {
    const out = decorateFailure(sample);
    assert.ok(
      out.startsWith(`[${code} · retry=${retry}] ${sample}`),
      `#${i} ${code} 未命中自己的样本串：${out.slice(0, 100)}`,
    );
    assert.ok(out.includes('\n下一步：'), `${code} 缺少下一步提示`);
    if (hintPart) assert.ok(out.includes(hintPart), `${code} 提示未含「${hintPart}」`);
  });
});

test('decorateFailure 幂等守卫：已带新格式头的文本原样放行，不叠头', () => {
  const once = decorateFailure('the worker did not answer within 20000 ms');
  assert.equal(decorateFailure(once), once);
  // 守卫匹配任意全大写 CODE 的新格式头
  assert.equal(decorateFailure('[FROBnicator · retry=never] x'), '[FROBnicator · retry=never] x');
});

test('FAILURE_RULES 顺序即优先级：AMSI 字样 + backend/worker 字样 → 安全拦截而不是 HELPER_UNAVAILABLE', () => {
  const out = decorateFailure('AMSI blocked this backend worker script');
  assert.ok(out.startsWith('[BACKEND_BLOCKED_BY_AV · retry=never] '));
});

test('decorateFailure：未命中任何规则时原文透传、不加前缀', () => {
  const msg = 'totally novel failure xyzzy';
  assert.equal(decorateFailure(msg), msg);
});

test('TIMEOUT 与第二条 HELPER_UNAVAILABLE 的提示按 idempotent 分叉', () => {
  const timeout = 'the worker did not answer within 20000 ms';
  assert.ok(decorateFailure(timeout, { idempotent: true }).includes('直接重试即可'));
  assert.ok(decorateFailure(timeout, { idempotent: false }).includes('不要直接重发'));
  // 表征：context 缺省（idempotent undefined）走只读分支
  assert.ok(decorateFailure(timeout).includes('直接重试即可'));
  const helper = 'backend process exited unexpectedly';
  assert.ok(decorateFailure(helper, { idempotent: false }).includes('结果未知'));
  assert.ok(decorateFailure(helper, { idempotent: true }).includes('直接重试即可'));
});

test('backendMessage：NO_WORKER_SCRIPT / 启动失败 / WORKER_EXITED 两态 / 释放确认 / 安全软件 / 普通错误', () => {
  assert.equal(
    backendMessage(new ComputerUseBackendError('worker.ps1 missing', 'NO_WORKER_SCRIPT')),
    '电脑操作后端脚本缺失：worker.ps1 missing',
  );
  const started = new ComputerUseBackendError('timed out', 'START_TIMEOUT');
  started.releaseConfirmed = true;
  started.released = ['MouseLeft'];
  assert.equal(
    backendMessage(started),
    '电脑操作后端无法启动：timed out；被按住不放的输入已由独立进程释放（MouseLeft）',
  );
  // WORKER_EXITED 两态（优-P1-10）：消息带 "did not start" → 从未起来
  assert.equal(
    backendMessage(new ComputerUseBackendError('worker did not start', 'WORKER_EXITED')),
    '电脑操作后端无法启动：worker did not start',
  );
  // 否则 → 服务中退出（带释放失败句）
  const midDeath = new ComputerUseBackendError('crashed mid-request', 'WORKER_EXITED');
  midDeath.releaseConfirmed = false;
  midDeath.releaseError = 'pipe gone';
  const midOut = backendMessage(midDeath);
  assert.ok(midOut.startsWith('电脑操作后端进程退出了（它之前在正常服务，这次调用可能正攥在它手里）：crashed mid-request'));
  assert.ok(midOut.includes('**释放被按住的输入失败**（pipe gone）'));
  // ComputerUseBackendError 构造默认 dispatched = false（withOutcomeNote 依赖这个字段）
  assert.equal(new ComputerUseBackendError('x', 'Y').dispatched, false);
  // 安全软件拦截优先于一切 code 分支
  const av = backendMessage(new ComputerUseBackendError('X ScriptContainedMaliciousContent Y', 'SPAWN_FAILED'));
  assert.ok(av.startsWith('电脑操作后端被安全软件阻止（Windows Defender / AMSI：ScriptContainedMaliciousContent）。'));
  // 非后端错误透传
  assert.equal(backendMessage(new Error('plain')), 'plain');
  assert.equal(backendMessage('raw string'), 'raw string');
  assert.equal(backendMessage(42), '42');
  // 未识别 code：message + 释放句
  assert.equal(backendMessage(new ComputerUseBackendError('mystery', 'SOMETHING')), 'mystery');
});

test('isIdempotentCall：命令与参数的组合判定表（削-2 后 wait 已不在命令表）', () => {
  assert.equal(isIdempotentCall('ping'), true);
  assert.equal(isIdempotentCall('screenshot'), true);
  assert.equal(isIdempotentCall('frameproject'), true);
  assert.equal(isIdempotentCall('wait'), false);   // 削-2：wait 命令已删（批内 wait 步骤仍在）
  assert.equal(isIdempotentCall('click'), false);
  assert.equal(isIdempotentCall('frob'), false);
  assert.equal(isIdempotentCall('clipboard', { op: 'get' }), true);
  assert.equal(isIdempotentCall('clipboard', {}), true);          // op 缺省即 get
  assert.equal(isIdempotentCall('clipboard', { op: 'set' }), false);
  assert.equal(isIdempotentCall('uiact', { action: 'get_value' }), true);
  assert.equal(isIdempotentCall('uiact', { action: 'GET_VALUE' }), true);
  assert.equal(isIdempotentCall('uiact', { action: 'invoke' }), false);
  assert.equal(isIdempotentCall('batch', { steps: [{ action: 'wait' }, { action: 'screenshot' }] }), true);
  assert.equal(isIdempotentCall('batch', { steps: [{ action: 'wait' }, { action: 'click' }] }), false);
  assert.equal(isIdempotentCall('batch', { steps: [{ action: 'clipboard', op: 'get' }] }), true);
  assert.equal(isIdempotentCall('batch', { steps: [{ action: 'clipboard', op: 'set' }] }), false);
  // 表征：steps 缺失/非数组 → 空批 → every 成立 → 可重发
  assert.equal(isIdempotentCall('batch', {}), true);
});

test('withOutcomeNote：已派发且不可重发 → 加 [UNKNOWN_OUTCOME · retry=reobserve] 前缀；其余情形原样', () => {
  const msg = 'the worker did not answer within 20000 ms';
  // 未派发 → 原样
  assert.equal(withOutcomeNote(msg, new Error('x'), 'click', {}), msg);
  // 已派发 + 不可重发 → 前缀
  const dispatched = new Error('x'); dispatched.dispatched = true;
  const out = withOutcomeNote(msg, dispatched, 'click', {});
  assert.ok(out.startsWith('[UNKNOWN_OUTCOME · retry=reobserve] click had already been sent to the backend'));
  assert.ok(out.includes(msg));
  // canceled 同样算已派发
  const canceled = new Error('x'); canceled.canceled = true;
  assert.ok(withOutcomeNote(msg, canceled, 'click', {}).startsWith('[UNKNOWN_OUTCOME · retry=reobserve]'));
  // 已派发但只读 → 原样
  assert.equal(withOutcomeNote(msg, dispatched, 'screenshot', {}), msg);
  // 旧格式字面量 [BAD_REQUEST] → 原样（参数被拒 = 什么都没发生）
  assert.equal(withOutcomeNote('[BAD_REQUEST] unknown command', dispatched, 'click', {}), '[BAD_REQUEST] unknown command');
  // 表征：新格式头 [BAD_REQUEST · retry=never] 不匹配 /\[BAD_REQUEST\]/ 守卫 → 仍被加前缀（见报告）
  assert.ok(
    withOutcomeNote('[BAD_REQUEST · retry=never] unknown command', dispatched, 'click', {})
      .startsWith('[UNKNOWN_OUTCOME · retry=reobserve]'),
  );
  // worker 自述 action_sent=false → 原样
  assert.equal(withOutcomeNote('refused action_sent=false', dispatched, 'click', {}), 'refused action_sent=false');
});

test('共享清单逐字契约：READ_ONLY_*、IDEMPOTENT_COMMANDS、STEP/UIA_ACTION_LIST（顺序是契约）', () => {
  assert.deepEqual([...READ_ONLY_ACTIONS], ['get_value', 'get_text', 'locate_text', 'get_caret']);
  assert.deepEqual([...READ_ONLY_STEPS], ['get_value', 'get_text', 'locate_text', 'get_caret', 'wait', 'screenshot']);
  assert.deepEqual([...IDEMPOTENT_STEP_ACTIONS], [...READ_ONLY_STEPS]);
  // 削-2：'wait' 已从命令表删除（failures.mjs:183-184 注释）
  assert.deepEqual(
    [...IDEMPOTENT_COMMANDS],
    ['ping', 'health', 'screenshot', 'windows', 'cursor', 'digest', 'uitree', 'release', 'frameproject', 'frameattach'],
  );
  assert.deepEqual(STEP_ACTION_LIST, [
    'click', 'move', 'drag', 'scroll', 'type', 'key', 'wait', 'wait_for', 'screenshot', 'paste', 'focus', 'clipboard',
    'invoke', 'set_value', 'get_value', 'get_text', 'select_text', 'scroll_into_view',
    'toggle', 'select', 'expand', 'collapse',
    'close', 'minimize', 'maximize', 'restore', 'legacy_action',
    'click_text', 'locate_text', 'get_caret',
  ]);
  assert.deepEqual(UIA_ACTION_LIST, [
    'invoke', 'set_value', 'get_value', 'get_text', 'select_text', 'scroll_into_view', 'focus',
    'toggle', 'select', 'expand', 'collapse',
    'close', 'minimize', 'maximize', 'restore', 'legacy_action',
    'click_text', 'locate_text', 'get_caret',
  ]);
});

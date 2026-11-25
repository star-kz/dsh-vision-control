import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES,
  MODE_OPTIONS,
  WATCH_TOOL_NAMES,
  CONTROL_ONLY_TOOL_NAMES,
  ALL_MANAGED_TOOL_NAMES,
  normalizeMode,
  deniedToolsForMode,
  buildModePrompt,
} from '../internal/modes.mjs';
import { createSessions } from '../internal/sessions.mjs';

const LEGACY = [
  'computer_screenshot', 'computer_actions', 'computer_click', 'computer_drag', 'computer_scroll',
  'computer_type', 'computer_key', 'computer_windows', 'computer_ui', 'computer_ui_action',
  'computer_clipboard', 'computer_paste', 'computer_launch', 'computer_stop', 'computer_watch',
  'browser_state', 'browser_actions',
];
const REALTIME = [
  'realtime_targets', 'realtime_skill_validate', 'realtime_calibrate', 'realtime_run',
  'realtime_status', 'realtime_stop', 'realtime_snapshot', 'realtime_replay', 'realtime_trace_read',
];
const WATCH = [
  'browser_state', 'computer_screenshot', 'computer_windows', 'computer_digest', 'computer_ui',
  'computer_clipboard', 'computer_watch', 'computer_stop', 'app_env_audit', ...REALTIME,
];
const CONTROL_ONLY = [
  'computer_actions', 'browser_actions', 'computer_click', 'computer_drag', 'computer_scroll',
  'computer_type', 'computer_key', 'computer_ui_action', 'computer_paste', 'computer_launch',
  'app_launch',
];

test('mode constants and options expose the exact three-mode contract', () => {
  assert.deepEqual(MODES, ['disabled', 'watch', 'control']);
  assert.deepEqual(MODE_OPTIONS, [
    { id: 'disabled', icon: 'forbidden', label: '禁用功能' },
    { id: 'watch', icon: 'eye', label: '仅观看' },
    { id: 'control', icon: 'monitor', label: '观看+操作' },
  ]);
  assert.ok(Object.isFrozen(MODES));
  assert.ok(Object.isFrozen(MODE_OPTIONS));
  for (const option of MODE_OPTIONS) assert.ok(Object.isFrozen(option));
});

test('managed tools are the old 17 plus digest/launch/audit and all nine realtime tools', () => {
  assert.deepEqual(ALL_MANAGED_TOOL_NAMES, [
    ...LEGACY, 'computer_digest', 'app_launch', 'app_env_audit', ...REALTIME,
  ]);
  assert.equal(ALL_MANAGED_TOOL_NAMES.length, 29);
  assert.equal(new Set(ALL_MANAGED_TOOL_NAMES).size, 29);
  assert.deepEqual(WATCH_TOOL_NAMES, WATCH);
  assert.deepEqual(CONTROL_ONLY_TOOL_NAMES, CONTROL_ONLY);
  assert.deepEqual([...WATCH_TOOL_NAMES, ...CONTROL_ONLY_TOOL_NAMES].sort(), [...ALL_MANAGED_TOOL_NAMES].sort());
  assert.equal(WATCH_TOOL_NAMES.filter((name) => CONTROL_ONLY_TOOL_NAMES.includes(name)).length, 0);
});

test('normalizeMode is strict and falls back safely', () => {
  for (const mode of MODES) assert.equal(normalizeMode(mode), mode);
  for (const bad of [undefined, null, '', 'WATCH', ' watch ', 'enabled', true, 1, {}, ['watch']]) {
    assert.equal(normalizeMode(bad), 'disabled');
    assert.equal(normalizeMode(bad, 'watch'), 'watch');
    assert.equal(normalizeMode(bad, 'control'), 'control');
  }
  assert.equal(normalizeMode('invalid', 'also-invalid'), 'disabled');
});

test('deniedToolsForMode partitions visibility without leaking mutable constants', () => {
  assert.deepEqual(deniedToolsForMode('disabled'), ALL_MANAGED_TOOL_NAMES);
  assert.deepEqual(deniedToolsForMode('watch'), CONTROL_ONLY_TOOL_NAMES);
  assert.deepEqual(deniedToolsForMode('control'), []);
  assert.deepEqual(deniedToolsForMode('unexpected'), ALL_MANAGED_TOOL_NAMES);
  const denied = deniedToolsForMode('watch');
  denied.length = 0;
  assert.deepEqual(deniedToolsForMode('watch'), CONTROL_ONLY_TOOL_NAMES);
});

test('mode prompts distinguish disabled, observation-only, and full control', () => {
  assert.equal(buildModePrompt('disabled'), '');
  assert.equal(buildModePrompt('invalid'), '');
  const watch = buildModePrompt('watch');
  assert.match(watch, /仅观看模式/);
  assert.match(watch, /只读|仅观看/);
  assert.match(watch, /不得|不能|禁止/);
  assert.match(watch, /realtime/);
  const control = buildModePrompt('control');
  assert.match(control, /观看\+操作模式/);
  assert.match(control, /观看.*操作|操作.*观看/);
});

test('createSessions defaults to control and maps the legacy boolean API', () => {
  const sessions = createSessions();
  assert.equal(sessions.defaultEnabled, true);
  assert.equal(sessions.getMode('new'), 'control');
  assert.equal(sessions.canObserve('new'), true);
  assert.equal(sessions.canControl('new'), true);
  assert.equal(sessions.isEnabled('new'), true);

  assert.equal(sessions.setMode('new', 'watch'), 'watch');
  assert.equal(sessions.canObserve('new'), true);
  assert.equal(sessions.canControl('new'), false);
  assert.equal(sessions.isEnabled('new'), false);
  assert.equal(sessions.grant('new'), 'control');
  assert.equal(sessions.getMode('new'), 'control');
  assert.equal(sessions.revoke('new'), 'disabled');
  assert.equal(sessions.canObserve('new'), false);
  assert.throws(() => sessions.setMode('new', 'WATCH'), RangeError);

  const disabled = createSessions({ defaultEnabled: false });
  assert.equal(disabled.getMode('new'), 'disabled');
  assert.equal(disabled.canObserve('new'), false);
});

test('session changes emit the session id and mode; onChange can unsubscribe', () => {
  const sessions = createSessions({ defaultEnabled: false });
  const events = [];
  const off = sessions.onChange((sessionId, mode) => events.push([sessionId, mode]));
  sessions.setMode('s', 'watch');
  sessions.grant('s');
  sessions.revoke('s');
  sessions.emit('s');
  assert.deepEqual(events, [['s', 'watch'], ['s', 'control'], ['s', 'disabled'], ['s', 'disabled']]);
  off();
  sessions.setMode('s', 'control');
  assert.equal(events.length, 4);
});

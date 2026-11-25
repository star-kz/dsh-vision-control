import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModeAccess } from '../internal/mode-access.mjs';

function fixture(mode = 'watch') {
  const denied = [];
  const access = createModeAccess({
    getMode: () => mode,
    onDenied: (exec) => denied.push(exec),
  });
  const exec = { agent: { session: { id: 's' } } };
  return { access, exec, denied };
}

test('disabled rejects observation and control before dispatch', () => {
  const { access, exec, denied } = fixture('disabled');
  assert.throws(() => access.requireObservation(exec), /\[NOT_AUTHORIZED\]/);
  assert.throws(() => access.requireControl(exec), /\[NOT_AUTHORIZED\]/);
  assert.equal(denied.length, 2);
});

test('watch permits reads but refuses mouse, clipboard writes and active realtime', () => {
  const { access, exec } = fixture('watch');
  access.requireObservation(exec);
  access.requireCommand(exec, 'screenshot', {});
  access.requireCommand(exec, 'clipboard', { op: 'get' });
  access.requireCommand(exec, 'batch', { dryRun: true, steps: [{ action: 'click', x: 1, y: 2 }] });
  access.requireRealtime(exec, 'realtime_run', { mode: 'shadow' });
  assert.throws(() => access.requireControl(exec), /\[CONTROL_REQUIRED\]/);
  assert.throws(() => access.requireCommand(exec, 'click', {}), /\[CONTROL_REQUIRED\]/);
  assert.throws(() => access.requireCommand(exec, 'clipboard', { op: 'set' }), /\[CONTROL_REQUIRED\]/);
  assert.throws(() => access.requireCommand(exec, 'batch', { steps: [{ action: 'key', keys: 'a' }] }), /\[CONTROL_REQUIRED\]/);
  assert.throws(() => access.requireRealtime(exec, 'realtime_run', { mode: 'active' }), /\[CONTROL_REQUIRED\]/);
});

test('control permits reads and writes', () => {
  const { access, exec } = fixture('control');
  access.requireObservation(exec);
  access.requireControl(exec);
  access.requireCommand(exec, 'click', { x: 1, y: 2 });
  access.requireRealtime(exec, 'realtime_run', { mode: 'active' });
});

test('subagents and unsupported platforms remain fail closed in every mode', () => {
  const sub = createModeAccess({ getMode: () => 'control', isSubagent: () => true });
  assert.throws(() => sub.requireObservation({}), /\[SUBAGENT_COMPUTER_USE_UNAVAILABLE\]/);
  const unsupported = createModeAccess({ getMode: () => 'control', supported: false });
  assert.throws(() => unsupported.requireObservation({}), /\[UNSUPPORTED_PLATFORM\]/);
});

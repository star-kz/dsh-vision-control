import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerModePrompt } from '../internal/mode-prompt.mjs';

test('mode prompt uses the host dynamic context API and is empty while disabled', () => {
  let definition;
  const registrations = [];
  const ctx = { systemPrompt: { context(value) { definition = value; registrations.push(value); return () => {}; } } };
  let mode = 'disabled';
  const dispose = registerModePrompt(ctx, { getMode: () => mode, isSubagent: () => false });
  assert.equal(registrations.length, 1);
  assert.equal(definition.name, 'computer-use:mode');
  assert.equal(definition.interpolate, false);
  assert.equal(definition.required, true);
  const context = { session: { id: 'main' }, agent: { session: { id: 'main' } } };
  assert.equal(definition.text(context), '');
  assert.equal(definition.text({}), '', 'no session means no injected desktop instructions');
  mode = 'watch';
  const watch = definition.text(context);
  assert.match(watch, /仅观看/);
  assert.doesNotMatch(watch, /computer_click|computer_type|computer_actions/);
  mode = 'control';
  assert.ok(definition.text(context).includes('观看+操作'));
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('subagents never inherit the desktop mode prompt', () => {
  let definition;
  const ctx = { systemPrompt: { context(value) { definition = value; } } };
  registerModePrompt(ctx, { getMode: () => 'control', isSubagent: () => true });
  assert.equal(definition.text({ session: { id: 'sub' }, agent: { session: { id: 'sub' } } }), '');
});

test('a missing prompt service fails closed without breaking tool permission checks', () => {
  assert.equal(registerModePrompt({}, { getMode: () => 'control' }), undefined);
});

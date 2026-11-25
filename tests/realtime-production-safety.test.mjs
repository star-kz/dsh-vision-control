import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateActiveAuthorization, validateRunSpec } from '../realtime/contracts.mjs';

const target = { id: 'hil-1', kind: 'hil' };

test('production RT never treats the legacy PowerShell release as native release evidence', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const match = source.match(/realtimeHost\s*=\s*registerRealtimeTools\(\{([\s\S]*?)\n\s*\}\);/);
  assert.ok(match, 'locate production realtime registration');
  assert.doesNotMatch(match[1], /request\(['"]release['"]|ensureBackend\s*\(/,
    'legacy backend release only covers PowerShell-owned input, not Rt.Worker native keys');
  assert.match(match[1], /releaseTool:\s*null/,
    'without native-specific independent evidence the reservation must remain unknown');
});

test('Node and native active authorization require exactly one valid expiry', () => {
  const base = { granted: true, targetId: target.id };
  assert.equal(validateActiveAuthorization({ mode: 'active', target, authorization: base }).ok, false);
  assert.equal(validateActiveAuthorization({ mode: 'active', target, authorization: { ...base, expiresQpc: 100, expiresAtMs: Date.now() + 10000 } }).ok, false);
  assert.equal(validateActiveAuthorization({ mode: 'active', target, authorization: { ...base, expiresAtMs: Date.now() - 1 } }).ok, false);
  assert.equal(validateActiveAuthorization({ mode: 'active', target, authorization: { ...base, expiresQpc: 0 } }).ok, false);
  assert.equal(validateActiveAuthorization({ mode: 'active', target, authorization: { ...base, expiresQpc: 1 } }).ok, true);
  assert.equal(validateActiveAuthorization({ mode: 'active', target, authorization: { ...base, expiresAtMs: Date.now() + 10000 } }).ok, true);
});

test('Node deadlineMs matches the native integer range before dispatch', () => {
  const run = (deadlineMs) => validateRunSpec({ skill: 's', target, deadlineMs });
  assert.equal(run(0.5).ok, false);
  assert.equal(run(86_400_001).ok, false);
  assert.equal(run(1).ok, true);
  assert.equal(run(86_400_000).ok, true);
});

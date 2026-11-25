import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeHilTargetVerifier } from '../realtime/hil-target-verifier.mjs';

const target = Object.freeze({
  kind: 'hil', id: 'synth-1', hwnd: '1234', processId: 456,
  title: 'RT-SYNTH-HIL-9D27C4|primary',
});

test('native HIL verifier rejects malformed targets without launching a process', async () => {
  let calls = 0;
  const verify = createNativeHilTargetVerifier({ exec: () => { calls += 1; } });
  for (const candidate of [null, {}, { ...target, kind: 'window' }, { ...target, hwnd: '0' },
    { ...target, processId: 0 }, { ...target, title: 'not-the-magic' }]) {
    const result = await verify(candidate);
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test('native HIL verifier launches the inert read-only Harness command without a shell', async () => {
  const calls = [];
  const facts = { hwnd: '1234', processId: 456, processName: 'Rt.SynthWindow', title: target.title,
    bounds: { x: 10, y: 20, width: 800, height: 600 }, isVisible: true, isMinimized: false };
  const verify = createNativeHilTargetVerifier({
    harnessPath: 'C:\\bundle\\Rt.Harness.exe',
    exists: () => true,
    exec: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0, stdout: JSON.stringify({ ok: true, reason: null, facts }), stderr: '' };
    },
  });
  const result = await verify(target);
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, facts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\bundle\\Rt.Harness.exe');
  assert.deepEqual(calls[0].args, ['verify-target', '--hwnd', '1234', '--process-id', '456', '--title', target.title]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('native HIL verifier fails closed on nonzero, malformed, oversized, false, timeout, and spawn failures', async () => {
  const outcomes = [
    { result: { status: 3, stdout: JSON.stringify({ ok: false, reason: 'wrong process' }), stderr: '' } },
    { result: { status: 0, stdout: '{bad json', stderr: '' } },
    { result: { status: 0, stdout: 'x'.repeat(65_537), stderr: '' } },
    { result: { status: 0, stdout: JSON.stringify({ ok: true, facts: { processName: 'not-synth' } }), stderr: '' } },
    { result: { error: new Error('timeout'), stdout: '', stderr: '' } },
    { throw: new Error('spawn failed') },
  ];
  for (const outcome of outcomes) {
    let calls = 0;
    const verify = createNativeHilTargetVerifier({
      harnessPath: 'C:\\bundle\\Rt.Harness.exe',
      exists: () => true,
      exec: () => { calls += 1; if (outcome.throw) throw outcome.throw; return outcome.result; },
    });
    const result = await verify(target);
    assert.equal(calls, 1, 'the failure case must actually reach the Harness execution branch');
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
});

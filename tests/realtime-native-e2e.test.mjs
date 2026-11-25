import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRealtimeHost } from '../tools/realtime.mjs';

const descriptorFor = (targetId) => JSON.stringify({
  categories: [{ name: 'noteHead', color: { b: 0, g: 255, r: 255, tolerance: 4 }, minArea: 4, minWidth: 1, minHeight: 1, expectedArea: 16, minFill: 0.1 }],
  regions: [{ id: 'lane0', roi: { x: 0, y: 0, width: 64, height: 64 }, arrivalLineY: 32, control: 'key.a' }],
  tracking: { maxSamples: 8, maxGapQpc: 100000, maxAssociationDistancePixels: 20, minVelocityPixelsPerSecond: 1, maxVelocityPixelsPerSecond: 10000 },
  policy: { targetId, minimumConfidence: 0.5, planningHorizonQpc: 1000000, lateToleranceQpc: 1000, tapDurationQpc: 1000, maximumHoldQpc: 10000, planExpiryAfterQpc: 100000, maxConcurrent: 2, outputOffsetQpc: 0 },
});

async function waitFor(predicate, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for native runtime evidence');
}

test('opt-in real Node → published Worker → WGC/DXGI shadow → PNG/trace/stop', {
  skip: process.env.RT_LIVE_CAPTURE !== '1' ? 'set RT_LIVE_CAPTURE=1 after npm run build:native' : false,
  timeout: 60000,
}, async (t) => {
  const host = createRealtimeHost({ env: {} });
  const exec = { agent: { session: { id: 'real-native-e2e' } } };
  t.after(async () => { await host.dispose(); });

  const listing = await host.targets({}, exec);
  assert.equal(listing.degraded, false);
  const target = listing.targets.find((candidate) => candidate.kind === 'monitor');
  assert.ok(target, 'a physical monitor target must come from the native catalog');
  const skill = descriptorFor(target.id);

  const validated = await host.skillValidate({ skill, target }, exec);
  assert.equal(validated.result.valid, true);
  const calibrated = await host.calibrate({ skill, target }, exec);
  assert.equal(calibrated.result.calibrated, true);
  assert.ok(calibrated.result.observedFrames > 0);
  assert.equal(calibrated.result.recognitionAccuracy, null);

  const run = await host.run({ skill, target, mode: 'shadow', deadlineMs: 30000 }, exec);
  assert.equal(run.mode, 'shadow');
  assert.ok(run.runId);
  const live = await waitFor(async () => {
    const status = await host.status({ runId: run.runId }, exec);
    return status.live?.frame?.published > 0 ? status.live : null;
  });
  assert.equal(live.mode, 'shadow');
  assert.ok(['WindowsGraphicsCapture', 'DxgiDesktopDuplication'].includes(live.backend), live.backend);

  const snapshot = await host.snapshot({ runId: run.runId }, exec);
  assert.ok(snapshot.snapshot.width > 0);
  assert.ok(snapshot.snapshot.height > 0);
  assert.equal(snapshot.snapshot.inlinePixels, false);
  assert.ok(existsSync(snapshot.snapshot.path));

  const trace = await waitFor(async () => {
    const page = await host.traceRead({ tracePath: live.trace.path, offset: 0, limit: 16 }, exec);
    return page.result.records.length > 0 ? page : null;
  });
  assert.ok(trace.result.records.some((record) => record.kind === 'Frame'));

  const stopped = await host.stop({ runId: run.runId }, exec);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.releaseConfirmed, false, 'shadow never claims an active-input release');
});

test('opt-in real native deadline emits terminal and closes Node lifecycle without a second estop', {
  skip: process.env.RT_LIVE_CAPTURE !== '1' ? 'set RT_LIVE_CAPTURE=1 after npm run build:native' : false,
  timeout: 60000,
}, async (t) => {
  const host = createRealtimeHost({ env: {} });
  const exec = { agent: { session: { id: 'real-native-deadline-e2e' } } };
  t.after(async () => { await host.dispose(); });
  const listing = await host.targets({}, exec);
  const target = listing.targets.find((candidate) => candidate.kind === 'monitor');
  assert.ok(target);
  const run = await host.run({ skill: descriptorFor(target.id), target, mode: 'shadow', deadlineMs: 400 }, exec);
  const record = await waitFor(async () => {
    const status = await host.status({ runId: run.runId }, exec);
    return status.record.nativeTerminal?.state === 'stopped' ? status.record : null;
  });
  assert.equal(record.nativeTerminal.released, true);
  assert.equal(record.state, 'stopped');
  assert.equal(record.lease.held, false);
  const stopped = await host.stop({ runId: run.runId }, exec);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.estopSent, false, 'native terminal is sufficient; no duplicate stop should be dispatched');
});

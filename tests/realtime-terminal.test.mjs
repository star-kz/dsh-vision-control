import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeController } from '../realtime/controller.mjs';

const target = { id: 'hil-1', kind: 'hil' };
const authorization = { granted: true, targetId: 'hil-1', expiresAtMs: Date.now() + 60_000 };

function fixture() {
  let onEvent;
  const calls = [];
  const client = {
    state: 'ready',
    onEvent(fn) { onEvent = fn; },
    onExit() {}, onHealthChange() {},
    async request(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'run') return { runId: args.runId, state: 'running' };
      if (cmd === 'stop') return { runId: args.runId, state: 'stopped', released: true };
      if (cmd === 'heartbeat') return { heartbeat: true };
      return { runId: args.runId, state: 'running' };
    },
  };
  const controller = createRealtimeController({
    client, verifyHilTarget: async () => ({ ok: true }),
    heartbeatIntervalMs: 10, heartbeatRequestTimeoutMs: 100,
  });
  return {
    controller, calls,
    emit(runId, payload, eventSeq = 1) {
      onEvent({ rt: 'event', event: 'terminal', runId, sourceEpoch: 1, eventSeq, payload });
    },
  };
}

test('native stopped+released terminal clears lease and post-terminal stop needs no second estop', async () => {
  const f = fixture();
  try {
    const rec = await f.controller.run({ skill: 's', mode: 'active', target, authorization });
    f.emit(rec.runId, { state: 'stopped', released: true });
    assert.equal(rec.state, 'stopped');
    assert.equal(rec.lease.held, false);
    const stopped = await f.controller.stop(rec.runId);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.released, true);
    assert.equal(stopped.estopSent, false);
    assert.equal(f.calls.filter((x) => x.cmd === 'stop').length, 0);
  } finally { f.controller.dispose(); }
});

test('released-only and unknown terminal evidence never release the active target', async () => {
  const f = fixture();
  try {
    const rec = await f.controller.run({ skill: 's', mode: 'active', target, authorization });
    f.emit(rec.runId, { state: 'running', released: true });
    assert.equal(rec.state, 'running');
    assert.equal(rec.lease.held, true);
    assert.equal(f.controller.stats.invalidTerminalEvents, 1);
    await assert.rejects(f.controller.run({ skill: 's', mode: 'active', target, authorization }),
      (err) => err.code === 'TARGET_BUSY');
    f.emit(rec.runId, { state: 'stopped-unknown', released: false }, 2);
    assert.equal(rec.state, 'stopped-unknown');
    assert.equal(rec.lease.held, true);
    await assert.rejects(f.controller.run({ skill: 's', mode: 'active', target, authorization }),
      (err) => err.code === 'TARGET_BUSY');
  } finally { f.controller.dispose(); }
});

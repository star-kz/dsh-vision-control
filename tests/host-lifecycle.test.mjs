/**
 * Task 0B (test-only): behavior freeze for the host-side lifecycle halves:
 * internal/execution.mjs (in-flight tracking, merged abort signals, deadline) and
 * internal/sessions.mjs (explicit grant vs explicit revoke vs absence).
 *
 * These are the pieces that make "撤销" (revoke) an ordered operation:
 *   1. the grant flips off (sessions),
 *   2. in-flight calls are aborted (execution registry + merged signal),
 *   3. the transport drops un-dispatched writes and the worker stops at a step boundary,
 *   4. files owned by the session are released (covered in capture.test.mjs).
 * The full index.js apply() wiring (backend cancelAll + release-input on top of these)
 * needs a booted plugin instance and a live worker — that end-to-end ordering is
 * exercised by tests/bridge-fake-child.test.mjs instead. What is frozen here is each
 * stage's own contract, plus the compose-order test at the bottom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineSignals, describeCall, createExecutionRegistry } from "../internal/execution.mjs";
import { createSessions, sessionKey } from "../internal/sessions.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- combineSignals

test("combineSignals: no usable signals → undefined", () => {
  assert.equal(combineSignals(), undefined);
  assert.equal(combineSignals(undefined, null, undefined), undefined);
});

test("combineSignals: a single signal is handed back as-is (same object)", () => {
  const c = new AbortController();
  assert.equal(combineSignals(c.signal, null), c.signal);
});

test("combineSignals: the merged signal aborts when either input aborts, carrying the reason", () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = combineSignals(a.signal, b.signal);
  assert.equal(merged.aborted, false);
  const reason = new Error("the session was revoked");
  a.abort(reason);
  assert.equal(merged.aborted, true);
  assert.equal(merged.reason, reason);
  // late second abort does not overwrite the first reason
  b.abort(new Error("too late"));
  assert.equal(merged.reason, reason);
});

test("combineSignals: an already-aborted input aborts the merged signal immediately", () => {
  const dead = new AbortController();
  const reason = new Error("already gone");
  dead.abort(reason);
  const merged = combineSignals(dead.signal, new AbortController().signal);
  assert.equal(merged.aborted, true);
  assert.equal(merged.reason, reason);
});

// ---------------------------------------------------------------- describeCall

test("describeCall: one short phrase per command, numbers from the arguments", () => {
  assert.equal(describeCall("batch", { steps: [1, 2, 3] }), "3 step(s)");
  assert.equal(describeCall("batch", {}), "0 step(s)");
  assert.equal(describeCall("click", { x: 10, y: 20 }), "click (10,20)");
  assert.equal(describeCall("drag", { fromX: 1, fromY: 2, toX: 3, toY: 4 }), "drag (1,2)->(3,4)");
  assert.equal(describeCall("type", { text: "abc" }), "type 3 char(s)");
  assert.equal(describeCall("paste", {}), "paste 0 char(s)");
  assert.equal(describeCall("key", { keys: "ctrl+c" }), "key ctrl+c");
  assert.equal(describeCall("scroll", { direction: "down" }), "scroll down");
  assert.equal(describeCall("focus", { hwnd: 7 }), "focus hwnd=7");
  assert.equal(describeCall("launch", { target: "x.exe" }), "launch x.exe");
  assert.equal(describeCall("uiact", { action: "toggle" }), "uiact toggle");
  assert.equal(describeCall("clipboard", {}), "clipboard get");
  assert.equal(describeCall("clipboard", { op: "set" }), "clipboard set");
  assert.equal(describeCall("uitree", {}), "uitree");
});

// ------------------------------------------------------------ execution registry

test("track/count: in-flight calls are counted per session; anonymous count is the machine total", () => {
  const reg = createExecutionRegistry();
  const a1 = new AbortController();
  const a2 = new AbortController();
  const b1 = new AbortController();
  const un1 = reg.track("s-a", a1);
  reg.track("s-a", a2);
  reg.track("s-b", b1);
  assert.equal(reg.count("s-a"), 2);
  assert.equal(reg.count("s-b"), 1);
  assert.equal(reg.count(""), 3, "empty session key asks how busy the whole machine is");
  assert.equal(reg.count("unknown"), 0);
  un1();
  assert.equal(reg.count("s-a"), 1);
  assert.equal(reg.count(""), 2);
});

test("track: session ids are normalized — 5 and '5' land in the same bucket", () => {
  const reg = createExecutionRegistry();
  reg.track(5, new AbortController());
  assert.equal(reg.count("5"), 1);
});

test("abort: aborts only the named session in-flight calls, with the reason, returns the count", () => {
  const reg = createExecutionRegistry();
  const a1 = new AbortController();
  const a2 = new AbortController();
  const b1 = new AbortController();
  reg.track("s-a", a1);
  reg.track("s-a", a2);
  reg.track("s-b", b1);
  const aborted = reg.abort("s-a", "the session was revoked");
  assert.equal(aborted, 2);
  assert.equal(a1.signal.aborted, true);
  assert.equal(a2.signal.aborted, true);
  assert.ok(a1.signal.reason instanceof Error);
  assert.equal(a1.signal.reason.message, "the session was revoked");
  assert.equal(b1.signal.aborted, false, "other sessions are untouched");
  // abort() only fires the controllers — removal stays the body's job (the finally
  // untrack), so a hung body keeps its slot until runSessionCall's own deadline clears it.
  assert.equal(reg.count("s-a"), 2, "abort does not silently erase the in-flight records");
  // re-abort is a counted no-op: the controllers are still registered, aborting them again changes nothing
  assert.equal(reg.abort("s-a", "again"), 2);
});

test("isStopping/beginStop/endStop: the stopping flag is per session and explicit", () => {
  const reg = createExecutionRegistry();
  assert.equal(reg.isStopping("s"), false);
  reg.beginStop("s");
  assert.equal(reg.isStopping("s"), true);
  assert.equal(reg.isStopping("other"), false);
  reg.endStop("s");
  assert.equal(reg.isStopping("s"), false);
});

// ------------------------------------------------------------- runSessionCall

test("runSessionCall: body gets a merged signal and a deadline; the call is tracked while running", async () => {
  const reg = createExecutionRegistry();
  const outer = new AbortController();
  const exec = { agent: { session: { id: "s-1" } }, signal: outer.signal };
  let seenCount;
  const out = await reg.runSessionCall(exec, { timeoutMs: 5000, label: "probe" }, async ({ signal, deadline }) => {
    seenCount = reg.count("s-1");
    assert.equal(signal.aborted, false);
    assert.ok(deadline > Date.now(), "the deadline is in the future");
    return "done";
  });
  assert.equal(out, "done");
  assert.equal(seenCount, 1, "the call is in-flight for the duration of the body");
  assert.equal(reg.count("s-1"), 0, "and only for that long");
});

test("runSessionCall: aborting the caller signal aborts the body's merged signal", async () => {
  const reg = createExecutionRegistry();
  const outer = new AbortController();
  const exec = { agent: { session: { id: "s-2" } }, signal: outer.signal };
  const promise = reg.runSessionCall(exec, { timeoutMs: 5000 }, async ({ signal }) => {
    await sleep(400);
    return signal.aborted ? "stopped" : "ran";
  });
  await sleep(20);
  outer.abort(new Error("the tool call itself was cancelled"));
  assert.equal(await promise, "stopped");
  assert.equal(reg.count("s-2"), 0);
});

test("runSessionCall: the deadline aborts a hung body with the label and the budget in the reason", async () => {
  const reg = createExecutionRegistry();
  const exec = { agent: { session: { id: "s-3" } } };
  const out = await reg.runSessionCall(exec, { timeoutMs: 25, label: "the browser call" }, async ({ signal }) => {
    await sleep(300).then(() => "never");
    // emulate a body that reacts to the abort instead of hanging forever
    if (signal.aborted) return { aborted: true, reason: String(signal.reason?.message ?? "") };
    return { aborted: false };
  });
  assert.deepEqual(out, { aborted: true, reason: "the browser call exceeded its 25 ms deadline" });
  assert.equal(reg.count("s-3"), 0, "the finally untrack runs even when the budget fires");
});

test("runSessionCall: an unusable timeoutMs falls back to the 60s default budget", async () => {
  const reg = createExecutionRegistry();
  for (const bad of [undefined, 0, -5, Number.NaN]) {
    const start = Date.now();
    await reg.runSessionCall({}, { timeoutMs: bad }, async ({ deadline }) => {
      const remaining = deadline - start;
      assert.ok(remaining >= 59_000 && remaining <= 61_000, `fallback budget ${remaining} ms for timeoutMs=${bad}`);
    });
  }
});

// ---------------------------------------------------------------------- sessions

test("sessionKey: nullish collapses to the anonymous key, everything else to String", () => {
  assert.equal(sessionKey(undefined), "");
  assert.equal(sessionKey(null), "");
  assert.equal(sessionKey(5), "5");
  assert.equal(sessionKey("s"), "s");
});

test("sessions: default closed — grant opens, revoke is explicit-off, forget returns to the default", () => {
  const sessions = createSessions({ defaultEnabled: false });
  assert.equal(sessions.isEnabled("s"), false, "default closed");
  assert.equal(sessions.hasExplicit("s"), false);
  sessions.grant("s");
  assert.equal(sessions.isEnabled("s"), true);
  assert.equal(sessions.hasExplicit("s"), true);
  sessions.revoke("s");
  assert.equal(sessions.isEnabled("s"), false);
  assert.equal(sessions.hasExplicit("s"), true, "revoked is a record, not an absence — the chip can tell stopped apart from never-opened");
  sessions.forget("s");
  assert.equal(sessions.isEnabled("s"), false, "back to the deployment default");
  assert.equal(sessions.hasExplicit("s"), false);
});

test("sessions: with default open, absence is enabled but an explicit revoke still wins", () => {
  const sessions = createSessions({ defaultEnabled: true });
  assert.equal(sessions.isEnabled("fresh"), true);
  sessions.revoke("fresh");
  assert.equal(sessions.isEnabled("fresh"), false, "explicit off beats the default");
  sessions.forget("fresh");
  assert.equal(sessions.isEnabled("fresh"), true);
});

test("sessions: instances keep separate grant tables", () => {
  const a = createSessions({ defaultEnabled: false });
  const b = createSessions({ defaultEnabled: false });
  a.grant("s");
  assert.equal(a.isEnabled("s"), true);
  assert.equal(b.isEnabled("s"), false);
});

// ------------------------------------------------- composed revoke ordering

test("composed revoke: grant flips off, in-flight call is aborted, then the machine is quiet", async () => {
  const sessions = createSessions({ defaultEnabled: false });
  const reg = createExecutionRegistry();
  sessions.grant("s-9");
  assert.equal(sessions.isEnabled("s-9"), true);
  reg.beginStop("s-9");
  assert.equal(reg.isStopping("s-9"), true);
  // a long-running non-worker call in flight for that session
  const exec = { agent: { session: { id: "s-9" } } };
  const promise = reg.runSessionCall(exec, { timeoutMs: 10_000, label: "browser sequence" }, async ({ signal }) => {
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", resolve, { once: true });
      setTimeout(resolve, 5_000);
    });
    return signal.aborted ? "aborted" : "completed";
  });
  // revoke order: flip the grant first, then abort what is running
  sessions.revoke("s-9");
  assert.equal(sessions.isEnabled("s-9"), false);
  const abortedCount = reg.abort("s-9", "the session was revoked");
  assert.equal(abortedCount, 1);
  assert.equal(await promise, "aborted");
  reg.endStop("s-9");
  assert.equal(reg.isStopping("s-9"), false);
  assert.equal(reg.count(""), 0, "nothing is left in flight — the file-release stage sees a quiet machine");
});

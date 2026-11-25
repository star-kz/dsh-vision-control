/**
 * Task 0B (test-only): the fake-child transport contract tests for backend/bridge.js.
 *
 * The worker is faked by a small PowerShell script speaking the JSONL protocol
 * (ready line, one response per request id, cancel-flag polling, deliberate deaths),
 * so every transport behavior below is exercised against a real spawned child
 * without ever touching the real worker or the real desktop.
 *
 * Protocol facts frozen here (docs/worker-protocol.md):
 *   - the ready handshake carries info verbatim; the host compares the worker's
 *     action list against STEP_ACTION_LIST (order is part of the contract);
 *   - responses pair by id; unknown ids and non-JSON lines are noise;
 *   - ok:false becomes ComputerUseBackendError (CANCELLED when canceled, else
 *     WORKER_ERROR) with "<cmd> failed: <error>" text and dispatched=true;
 *   - a death after dispatch keeps dispatched=true (never a blind retry);
 *   - startup-phase failures are dispatched=false;
 *   - the timeout path force-kills, runs the independent release-input process
 *     BEFORE the kill, and attaches releaseConfirmed/released/releaseError.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PowerShellBackend, ComputerUseBackendError, resolvePowerShell } from "../backend/bridge.js";
import { backendMessage, withOutcomeNote, STEP_ACTION_LIST } from "../internal/failures.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 15_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const TMP = mkdtempSync(join(tmpdir(), "dsh-bridge-fake-"));
let seq = 0;
// every backend ever created is disposed after the run, so no fake worker with
// open stdio pipes can outlive the suite and wedge the test runner
const ALL_BACKENDS = [];
after(async () => {
  for (const backend of ALL_BACKENDS) {
    try { backend.cancelAll("suite teardown"); } catch { /* already settled */ }
    try { backend.dispose(); } catch { /* already disposed */ }
  }
  await sleep(300);
  rmSync(TMP, { recursive: true, force: true });
});

/** A fake worker speaking the JSONL protocol. Driven entirely by cmd names. */
function makeWorkerScript() {
  const stepList = STEP_ACTION_LIST.map((a) => `'${a}'`).join(",");
  const ps1 = `
$ErrorActionPreference = 'Stop'
$ready = @{
  ready = $true
  info = @{
    pid = $PID
    protocol = 2
    generation = 1
    version = 'fake'
    actions = @(${stepList})
    capabilities = @('frames', 'uia')
    cancelFile = $env:DSH_COMPUTER_USE_CANCEL_FILE
  }
}
$ready | ConvertTo-Json -Compress -Depth 6 | Write-Output
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $cmd = [string]$req.cmd
  $id = $req.id
  if ($cmd -eq 'shutdown') { break }
  elseif ($cmd -eq 'echo') {
    @{ id = $id; ok = $true; result = @{ seen = $cmd; marker = [string]$req.args.marker } } | ConvertTo-Json -Compress -Depth 6 | Write-Output
  }
  elseif ($cmd -eq 'slow') {
    Start-Sleep -Milliseconds 400
    @{ id = $id; ok = $true; result = @{ seen = $cmd; marker = [string]$req.args.marker } } | ConvertTo-Json -Compress -Depth 6 | Write-Output
  }
  elseif ($cmd -eq 'noise') {
    '{"id":9999,"ok":true,"result":{"junk":true}}' | Write-Output
    @{ id = $id; ok = $true; result = @{ seen = $cmd } } | ConvertTo-Json -Compress -Depth 6 | Write-Output
  }
  elseif ($cmd -eq 'fail') {
    @{ id = $id; ok = $false; error = '[BAD_REQUEST] the point is outside the frame' } | ConvertTo-Json -Compress -Depth 6 | Write-Output
  }
  elseif ($cmd -eq 'failsoft') {
    @{ id = $id; ok = $false; error = 'the window vanished mid-click' } | ConvertTo-Json -Compress -Depth 6 | Write-Output
  }
  elseif ($cmd -eq 'failcanceled') {
    @{ id = $id; ok = $false; error = '[CANCELED] stopped at a step boundary'; canceled = $true; performed = $false; actionSent = $false; partial = $false } | ConvertTo-Json -Compress -Depth 6 | Write-Output
  }
  elseif ($cmd -eq 'dieafter') {
    [Console]::Error.WriteLine('fake worker died mid-service')
    exit 3
  }
  elseif ($cmd -eq 'hang') {
    while ($true) { Start-Sleep -Milliseconds 200 }
  }
  elseif ($cmd -eq 'hangwatch') {
    $cancelFile = $env:DSH_COMPUTER_USE_CANCEL_FILE
    $proof = "$cancelFile.saw-$id"
    while ($true) {
      $saw = $false
      try {
        if ((Test-Path $cancelFile) -and ((Get-Content $cancelFile -Raw).Trim() -eq [string]$id)) { $saw = $true }
      } catch {}
      if ($saw) {
        Set-Content -Path $proof -Value "cancelled $id"
        @{ id = $id; ok = $false; error = '[CANCELED] stopped at a step boundary'; canceled = $true } | ConvertTo-Json -Compress -Depth 6 | Write-Output
        break
      }
      Start-Sleep -Milliseconds 40
    }
  }
}
`;
  const path = join(TMP, `fake-worker-${seq += 1}.ps1`);
  writeFileSync(path, ps1, "utf8");
  return path;
}

function makeBackend(scriptPath, options = {}) {
  seq += 1;
  const backend = new PowerShellBackend({
    scriptPath,
    powerShell: resolvePowerShell(),
    timeoutMs: 8_000,
    startTimeoutMs: 8_000,
    cancelGraceMs: 2_500,
    cancelFilePath: join(TMP, `cancel-${seq}.flag`),
    ...options,
  });
  ALL_BACKENDS.push(backend);
  return backend;
}

async function cleanup(backend) {
  // settle anything still outstanding first, so its rejection has a handler
  // before dispose fails it — a dangling rejection would be attributed to the test
  try { backend.cancelAll("test cleanup"); } catch { /* already settled */ }
  try { backend.dispose(); } catch { /* already gone */ }
  await sleep(250);
}

// ---------------------------------------------------------------------- TODO 1

test("handshake: ready line passes info through; the worker action list matches STEP_ACTION_LIST verbatim", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const info = await backend.start();
    assert.equal(backend.state, "ready");
    assert.equal(backend.alive, true);
    assert.equal(info.protocol, 2);
    assert.equal(typeof info.pid, "number");
    assert.equal(info.pid, backend.info.pid, "info is the ready payload, kept on the backend");
    // the order of the action list is part of the contract (index.js compares joined lists)
    assert.deepEqual(info.actions, STEP_ACTION_LIST);
    assert.equal(
      Array.isArray(info.actions) ? info.actions.map(String).join(",") : String(info.actions),
      STEP_ACTION_LIST.join(","),
      "the worker's joined action list equals the host's, action for action",
    );
  } finally {
    await cleanup(backend);
  }
});

// ---------------------------------------------------------------------- TODO 2

test("id pairing: two concurrent requests each resolve with their own answer; the queued one pays queue time", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const slow = backend.request("slow", { marker: "A" });
    const quick = backend.request("echo", { marker: "B" });
    const [a, b] = await Promise.all([slow, quick]);
    assert.equal(a.seen, "slow");
    assert.equal(a.marker, "A");
    assert.equal(b.seen, "echo");
    assert.equal(b.marker, "B");
    const stats = backend.stats;
    assert.equal(stats.requests, 2);
    assert.equal(stats.dispatched, 2, "both were written (the second only after the first answered)");
    assert.ok(stats.queuedMs > 0, "the queued request waited behind the running one");
    // the timing payload rides along non-enumerably, so it survives an additionalProperties:false schema
    const descriptor = Object.getOwnPropertyDescriptor(b, "__bridgeTiming");
    assert.ok(descriptor, "the echo result carries __bridgeTiming");
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.value.cmd, "echo");
    assert.ok(descriptor.value.workerMs >= 0);
  } finally {
    await cleanup(backend);
  }
});

test("noise: a response naming an unknown id is ignored, not mistaken for this request's answer", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const out = await backend.request("noise", {});
    assert.equal(out.seen, "noise");
    assert.equal(backend.outstanding, 0);
  } finally {
    await cleanup(backend);
  }
});

// ---------------------------------------------------------------------- TODO 3

test("error envelope: ok:false becomes WORKER_ERROR with code, <cmd> failed text, and dispatched=true", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const err = await backend.request("fail", {}).then(() => null, (e) => e);
    assert.ok(err instanceof ComputerUseBackendError);
    assert.equal(err.name, "ComputerUseBackendError");
    assert.equal(err.code, "WORKER_ERROR");
    assert.equal(err.message, "fail failed: [BAD_REQUEST] the point is outside the frame");
    assert.equal(err.dispatched, true, "the worker had the request when it failed");
    // the host text branch for a plain backend failure is the message itself
    assert.equal(backendMessage(err), "fail failed: [BAD_REQUEST] the point is outside the frame");
  } finally {
    await cleanup(backend);
  }
});

test("error envelope: canceled=true maps to CANCELLED and carries the worker's step facts", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const err = await backend.request("failcanceled", {}).then(() => null, (e) => e);
    assert.equal(err.code, "CANCELLED");
    assert.equal(err.message, "failcanceled failed: [CANCELED] stopped at a step boundary");
    assert.equal(err.canceled, true);
    assert.equal(err.performed, false);
    assert.equal(err.actionSent, false);
    assert.equal(err.partial, false);
    assert.equal(err.dispatched, true);
  } finally {
    await cleanup(backend);
  }
});

test("withOutcomeNote: a dispatched failure without an [CODE] header gets the UNKNOWN_OUTCOME prefix", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const err = await backend.request("failsoft", {}).then(() => null, (e) => e);
    const text = withOutcomeNote(backendMessage(err), err, "failsoft", {});
    assert.ok(text.startsWith("[UNKNOWN_OUTCOME · retry=reobserve] failsoft had already been sent to the backend when this failed"), text);
    // an idempotent command is retry-safe and stays unprefixed
    const idempotent = withOutcomeNote(backendMessage(err), err, "ping", {});
    assert.equal(idempotent, backendMessage(err));
  } finally {
    await cleanup(backend);
  }
});

// ---------------------------------------------------------------------- TODO 4

test("dispatched=true on a mid-request death: the worker dies after receiving the request", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const err = await backend.request("dieafter", {}).then(() => null, (e) => e);
    assert.ok(err instanceof ComputerUseBackendError);
    assert.equal(err.code, "WORKER_EXITED");
    assert.equal(err.dispatched, true, "the request was in the worker's hands when it died");
    assert.ok(err.message.startsWith("the computer-use worker exited (code 3)"), err.message);
    assert.ok(err.message.includes("fake worker died mid-service"), "the worker's stderr is quoted in the failure");
    assert.equal(backend.alive, false);
    assert.equal(backend.state, "idle", "a dead worker is discarded, so the next call respawns");
    // the caller is never told an unknown outcome is a failed one (no blind retry)
    const text = withOutcomeNote(backendMessage(err), err, "dieafter", {});
    assert.ok(text.startsWith("[UNKNOWN_OUTCOME · retry=reobserve]"));
  } finally {
    await cleanup(backend);
  }
});

// ---------------------------------------------------------------------- TODO 5

test("undispatched failures: NO_WORKER_SCRIPT / SPAWN_FAILED / startup exit all keep dispatched=false", async () => {
  // missing script → thrown synchronously by start()
  const missing = makeBackend(join(TMP, "no-such-worker.ps1"));
  const scriptErr = await missing.start().then(() => null, (e) => e);
  assert.ok(scriptErr instanceof ComputerUseBackendError);
  assert.equal(scriptErr.code, "NO_WORKER_SCRIPT");
  assert.equal(scriptErr.dispatched, false);
  assert.ok(scriptErr.message.includes("computer-use worker script not found"));

  // missing executable → the spawn error event
  const unspawnable = new PowerShellBackend({
    scriptPath: makeWorkerScript(),
    powerShell: "Z:\\definitely\\missing\\pwsh.exe",
    startTimeoutMs: 5_000,
  });
  const spawnErr = await unspawnable.start().then(() => null, (e) => e);
  assert.ok(spawnErr instanceof ComputerUseBackendError);
  assert.equal(spawnErr.code, "SPAWN_FAILED");
  assert.equal(spawnErr.dispatched, false);
  assert.ok(spawnErr.message.includes("could not spawn"));

  // a script that exits before its ready line: nothing was ever dispatched
  const dying = join(TMP, "dying-worker.ps1");
  writeFileSync(dying, "[Console]::Error.WriteLine('startup explosion')\nexit 1\n", "utf8");
  const startup = makeBackend(dying);
  const exitErr = await startup.start().then(() => null, (e) => e);
  assert.ok(exitErr instanceof ComputerUseBackendError);
  assert.equal(exitErr.code, "WORKER_EXITED");
  assert.equal(exitErr.dispatched, false);
  assert.ok(exitErr.message.includes("the computer-use worker exited (code 1)"));
  assert.ok(exitErr.message.includes("startup explosion"));
  await cleanup(startup);
});

// ---------------------------------------------------------------------- TODO 6

test("WORKER_EXITED two faces: 'did not start' vs mid-service, through backendMessage", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const err = await backend.request("dieafter", {}).then(() => null, (e) => e);
    // mid-service death: the backend was serving normally
    const midService = backendMessage(err);
    assert.ok(midService.includes("电脑操作后端进程退出了"), midService);
    assert.ok(midService.includes("它之前在正常服务"), "the caller is warned the call may still be held by the dying worker");
    // startup-phase wording: exactly the error the start-timeout path fails outstanding requests with
    const startupPhase = backendMessage(new ComputerUseBackendError("the computer-use worker did not start", "WORKER_EXITED"));
    assert.ok(startupPhase.includes("电脑操作后端无法启动"), startupPhase);
  } finally {
    await cleanup(backend);
  }
});

// --------------------------------------------------------------------- TODO 7+8

test("TIMEOUT: a hung worker is killed, reported, and the next call gets a fresh worker", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const firstPid = (await backend.start()).pid;
    const err = await backend.request("hang", {}, { timeoutMs: 400 }).then(() => null, (e) => e);
    assert.equal(err.code, "TIMEOUT");
    assert.equal(err.message, "hang did not answer within 400 ms; the backend was restarted");
    assert.equal(err.dispatched, true);
    assert.equal(backend.stats.timeouts, 1);
    await waitFor(() => backend.state === "idle", { label: "the killed worker to be torn down" });
    const out = await backend.request("echo", { marker: "back" });
    assert.equal(out.marker, "back");
    assert.equal(backend.stats.spawns, 2, "the next call paid the respawn");
    assert.notEqual(backend.info.pid, firstPid, "it is a genuinely new worker process");
    assert.equal(backend.state, "ready");
  } finally {
    await cleanup(backend);
  }
});

test("START_TIMEOUT: a worker that never says ready fails the start and the capability recovers", async () => {
  const neverReady = join(TMP, "never-ready.ps1");
  writeFileSync(neverReady, "while ($true) { Start-Sleep -Milliseconds 200 }\n", "utf8");
  const backend = makeBackend(neverReady, { startTimeoutMs: 600 });
  try {
    const err = await backend.start().then(() => null, (e) => e);
    assert.ok(err instanceof ComputerUseBackendError);
    assert.equal(err.code, "START_TIMEOUT");
    assert.ok(err.message.includes("the computer-use worker did not start within 600 ms"), err.message);
    assert.equal(err.dispatched, false);
    assert.equal(backend.state, "stopping", "a readiness rejection is not process death; the old generation must finish stopping");
    // the retry is a genuinely fresh start attempt, not a cached rejection:
    // with a still-broken script it fails again, but from a NEW spawn
    const second = await backend.request("echo", { marker: "again" }).then(() => null, (e2) => e2);
    assert.ok(second instanceof ComputerUseBackendError);
    assert.equal(second.code, "START_TIMEOUT", "a still-broken worker still fails — the backend never serves a lie");
    assert.equal(backend.stats.spawns, 2, "the second call paid a new spawn instead of reusing the dead one");
    await waitFor(() => backend.state === "idle", { label: "the second failed worker to finish stopping" });
    // and the capability itself is intact: a working worker answers on a fresh backend
    const fresh = makeBackend(makeWorkerScript());
    const recovered = await fresh.request("echo", { marker: "recovered" });
    assert.equal(recovered.marker, "recovered");
    assert.equal(fresh.state, "ready");
  } finally {
    await cleanup(backend);
    await rmSync(neverReady, { force: true });
  }
});

// ---------------------------------------------------------------------- TODO 8

test("cancel split: a queued request is dropped (dispatched=false), a running one is cancelled in the worker", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const running = backend.request("slow", { marker: "R" });
    const queued = backend.request("echo", { marker: "Q" });
    // the slow one must be written (dispatched 1) and the echo one still queued
    // (2 outstanding) before we cancel — a fixed sleep races the worker start
    await waitFor(
      () => backend.stats.dispatched === 1 && backend.outstanding === 2,
      { label: "the slow request written and the echo request still queued" },
    );
    const cancelled = backend.cancelAll("the session was revoked");
    assert.equal(cancelled, 2);
    const [runErr, queueErr] = await Promise.all([
      running.then(() => null, (e) => e),
      queued.then(() => null, (e) => e),
    ]);
    // queued: never written, never will be
    assert.equal(queueErr.code, "ABORTED");
    assert.equal(queueErr.dispatched, false);
    assert.equal(queueErr.message, "the session was revoked; the request was dropped before dispatch, so nothing was sent to the desktop");
    // running: already dispatched, told to stop at the next step boundary
    assert.equal(runErr.code, "CANCELLED");
    assert.equal(runErr.dispatched, true);
    assert.equal(runErr.message, "the session was revoked; slow had already been dispatched, so the worker was told to stop at the next step boundary");
    assert.equal(backend.stats.cancelled, 1, "only the dispatched one counts as a worker cancellation");
    // the worker's late answer for the settled request is ignored — and frees the run slot
    await sleep(500);
    const after = await backend.request("echo", { marker: "after" });
    assert.equal(after.marker, "after");
  } finally {
    await cleanup(backend);
  }
});

test("session cancel: revoking one session never cancels another session's running or queued calls", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const otherRunning = backend.request("slow", { marker: "other-running" }, { sessionKey: "other" });
    const targetQueued = backend.request("echo", { marker: "target" }, { sessionKey: "target" });
    const otherQueued = backend.request("echo", { marker: "other-queued" }, { sessionKey: "other" });
    // Keep red runs free of unhandled rejections when cleanup uses the legacy global cancel.
    void otherRunning.catch(() => {});
    void targetQueued.catch(() => {});
    void otherQueued.catch(() => {});
    let otherRunningSettled = false;
    void otherRunning.finally(() => { otherRunningSettled = true; });
    await waitFor(
      () => backend.stats.dispatched === 1 && backend.outstanding === 3,
      { label: "one running request and two queued requests with session identities" },
    );
    assert.equal(backend.cancelSession("target", "target session revoked"), 1);
    const targetError = await targetQueued.then(() => null, (error) => error);
    assert.equal(targetError.code, "ABORTED");
    assert.equal(targetError.dispatched, false);
    assert.equal(otherRunningSettled, false, "the other session's running call must remain untouched");
    assert.equal((await otherRunning).marker, "other-running");
    assert.equal((await otherQueued).marker, "other-queued");
  } finally {
    await cleanup(backend);
  }
});

test("cancel flag file: the host writes the id; the worker sees it and stops at its step boundary", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const pending = backend.request("hangwatch", {});
    // the request must be written and the worker polling the flag file
    await waitFor(
      () => backend.stats.dispatched === 1 && backend.outstanding === 1,
      { label: "the hangwatch request written and the worker polling" },
    );
    const err = await Promise.all([
      pending.then(() => null, (e) => e),
      (async () => { await sleep(30); return backend.cancelAll("revoked"); })(),
    ]).then(([e]) => e);
    assert.equal(err.code, "CANCELLED");
    assert.equal(err.dispatched, true);
    // proof the cancel channel reached the fake worker: it records the id it saw
    const proofPath = `${backend.cancelFilePath}.saw-1`;
    await waitFor(() => existsSync(proofPath), { label: "the worker to observe the cancel flag" });
    // and it answered the cancellation, so the run slot freed without a kill
    assert.equal(backend.alive, true);
    const after = await backend.request("echo", { marker: "post-cancel" });
    assert.equal(after.marker, "post-cancel");
  } finally {
    await cleanup(backend);
  }
});

test("abort before dispatch: an already-aborted signal never reaches the worker", async () => {
  const backend = makeBackend(makeWorkerScript());
  try {
    const controller = new AbortController();
    controller.abort(new Error("the tool call was cancelled"));
    const err = await backend.request("echo", {}, { signal: controller.signal }).then(() => null, (e) => e);
    assert.equal(err.code, "ABORTED");
    assert.equal(err.dispatched, false);
    assert.equal(err.message, "the call was cancelled before it was dispatched; nothing was sent to the desktop");
    assert.equal(backend.stats.requests, 0, "aborted calls are not even counted as requests");
    assert.equal(backend.outstanding, 0);
  } finally {
    await cleanup(backend);
  }
});

// -------------------------------------------------------------------- TODO 9+10

test("§6 item 4: a force-kill releases held input first; an empty record confirms the release", async () => {
  const heldFile = join(TMP, `held-empty-${seq += 1}.json`);
  writeFileSync(heldFile, JSON.stringify({ keys: [], buttons: [] }), "utf8");
  const backend = makeBackend(makeWorkerScript(), { heldFilePath: heldFile });
  try {
    const err = await backend.request("hang", {}, { timeoutMs: 400 }).then(() => null, (e) => e);
    assert.equal(err.code, "TIMEOUT");
    // the release ran before the kill and its outcome rides on the error
    assert.equal(err.releaseConfirmed, true);
    assert.deepEqual(err.released, []);
    assert.equal(err.releaseError, undefined);
    const text = backendMessage(err);
    assert.ok(text.includes("hang did not answer within 400 ms; the backend was restarted"), text);
    assert.ok(text.includes("；被按住不放的输入已由独立进程释放"), "the caller is told the held input was released");
    // the backend keeps the same fact for diagnostics
    assert.equal(backend.lastRelease.releaseConfirmed, true);
    assert.equal(backend.lastRelease.how, "independent-process");
  } finally {
    await cleanup(backend);
  }
});

test("release three states, end to end: an unreadable record fails loudly; no held file configured says nothing", async () => {
  // state 2: the release process itself reports failure
  const badHeld = join(TMP, `held-bad-${seq += 1}.json`);
  writeFileSync(badHeld, "this is not json{", "utf8");
  const badBackend = makeBackend(makeWorkerScript(), { heldFilePath: badHeld });
  try {
    const err = await badBackend.request("hang", {}, { timeoutMs: 400 }).then(() => null, (e) => e);
    assert.equal(err.code, "TIMEOUT");
    assert.equal(err.releaseConfirmed, false);
    assert.ok(err.releaseError.includes("the held-input record could not be read"), err.releaseError);
    const text = backendMessage(err);
    assert.ok(text.includes("**释放被按住的输入失败**"), text);
    assert.ok(text.includes(err.releaseError));
    assert.ok(text.includes("请先手动按一下对应的键再继续"), "the caller is told to fix the desktop by hand");
  } finally {
    await cleanup(badBackend);
  }

  // state 3: no held file wired at all → the release was never attempted, and the text says nothing about it
  const noHeld = makeBackend(makeWorkerScript(), { heldFilePath: "" });
  try {
    const err = await noHeld.request("hang", {}, { timeoutMs: 400 }).then(() => null, (e) => e);
    assert.equal(err.code, "TIMEOUT");
    assert.equal(err.releaseConfirmed, undefined);
    assert.equal(err.released, undefined);
    assert.equal(err.releaseError, undefined);
    const text = backendMessage(err);
    assert.ok(!text.includes("释放"), "with no release attempted, no release claim is made either way");
  } finally {
    await cleanup(noHeld);
  }
});

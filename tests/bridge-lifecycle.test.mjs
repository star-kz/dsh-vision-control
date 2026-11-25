/**
 * backend/bridge.js 生命周期回归：child 代际、停止等待与错误路径（方案 Task 0）。
 *
 * 这里钉住的是一条真实的竞态（9.txt §5.12 的半修复状态）：`#exited()` 曾经把
 * `wait.finally(...)` 的**返回值**存进 `#exitPromise`，却用内部的 `wait` 去比较，
 * 于是清理分支永远不成立，第一次 stop 结算后的 Promise 一直留在字段里。第二次 stop
 * 直接复用这个**已结算**的 Promise，`start()` 便在第二个 worker 还没退出时就绑定了
 * 第三代进程——正是这个等待逻辑要避免的事。
 *
 * 测试用真实子进程：一个按 JSONL 协议应答的假 worker（`fake-worker.ps1`，走
 * `scriptPath` 注入口，不碰真 worker.ps1），加上**延迟执行**的 `child.kill()`
 * 来模拟"进程要过一会儿才真的消失"。这不是 mock 掉退出事件：进程确实被 kill，
 * `exit` 事件也确实由操作系统送达，只是时机由测试掌握，因此断言是确定性的。
 * 若把 kill 改成立即执行，"第二次 stop 是否等待"就退化成毫秒级竞猜。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PowerShellBackend, resolvePowerShell } from '../backend/bridge.js';

/**
 * 假 worker：握手 → 按 cmd 分支。
 *   echo  → 应答（result 带 pid，用来证明换代）
 *   die   → 自己退出（错误路径）
 *   hang  → 永不回应（由传输层超时 / 取消来停它）
 *   shutdown → 退出（dispose 的礼貌路径）
 */
const FAKE_WORKER = String.raw`$ErrorActionPreference = 'Stop'
$out = [Console]::Out
$out.WriteLine('{"ready":true,"info":{"fake":true,"pid":' + $PID + '}}')
$out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $obj = $line | ConvertFrom-Json } catch { continue }
  if ($obj.cmd -eq 'shutdown') { break }
  if ($obj.cmd -eq 'die') { exit 0 }
  if ($obj.cmd -eq 'echo') {
    $out.WriteLine('{"id":' + $obj.id + ',"ok":true,"result":{"workerPid":' + $PID + '}}')
    $out.Flush()
  }
}
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询直到条件成立；超时抛出带标签的错误（比裸 sleep 更不容易假绿）。
 * @param predicate - 条件。
 * @param options.timeoutMs - 最长等待。
 * @param options.label - 失败信息里的条件名。
 */
async function waitFor(predicate, { timeoutMs = 15_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** 写出假 worker 脚本，返回临时目录与脚本路径（测试结束后整个目录删除）。 */
function makeWorkerScript() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-lifecycle-'));
  const script = join(dir, 'fake-worker.ps1');
  writeFileSync(script, FAKE_WORKER, 'utf8');
  return { dir, script };
}

const PS = resolvePowerShell();

/** 构造一个只连假 worker 的传输层；超时/取消宽限期都缩到测试可等的量级。 */
function newBackend(script) {
  return new PowerShellBackend({
    scriptPath: script,
    powerShell: PS,
    timeoutMs: 10_000,
    startTimeoutMs: 20_000,
    cancelGraceMs: 150,
  });
}

/**
 * 让 `child.kill()` 延迟执行：进程确实会在 delayMs 后被真正 kill，只是"消失得慢"。
 * 记录每次 kill 调用，供"同一代只杀一次"的断言使用。
 * @param delayMs - 从调用 kill 到真正终止的间隔。
 * @returns `{ kills, restore }`。
 */
function slowKill(delayMs) {
  const original = ChildProcess.prototype.kill;
  const kills = [];
  ChildProcess.prototype.kill = function patchedKill(signal) {
    const child = this;
    kills.push({ pid: child.pid, signal: signal ?? null });
    const timer = setTimeout(() => {
      try {
        original.call(child, signal);
      } catch {
        // 已经退出；测试只关心"等待是否发生"，不关心这次 kill 是否还有对象。
      }
    }, delayMs);
    timer.unref?.();
    return true;
  };
  return {
    kills,
    restore() {
      ChildProcess.prototype.kill = original;
    },
  };
}

/**
 * 独立释放脚本的测试替身：只睡眠、记调用次数并回 JSON，从不调用 SendInput。
 * held 文件故意写成非 JSON；若生产代码忽略 releaseScriptPath 注入而运行真实脚本，
 * 真实脚本会在解析阶段失败并退出，不会释放任何键。
 */
function makeReleaseScript(dir, delayMs = 100) {
  const script = join(dir, 'fake-release.ps1');
  const invocations = join(dir, 'release-invocations.txt');
  const escaped = invocations.replaceAll("'", "''");
  writeFileSync(script, `param([string]$StateFile)
Start-Sleep -Milliseconds ${delayMs}
Add-Content -LiteralPath '${escaped}' -Value 'called'
[Console]::Out.WriteLine('{"ok":true,"released":[]}')
`, 'utf8');
  return { script, invocations };
}

/** dispose 之后给假 worker 一点时间死透、再删临时目录，避免 Windows 文件占用。 */
async function cleanup(backend, dir, killPatch) {
  try {
    backend.dispose();
  } catch {
    // dispose 的失败不该掩盖测试本身的断言失败。
  }
  killPatch?.restore();
  await sleep(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉不算回归。
  }
}

test('child 代际：第二次 stop 必须等第二个 child 真正退出，不能复用已结算的等待', async () => {
  const { dir, script } = makeWorkerScript();
  const kill = slowKill(500);
  const backend = newBackend(script);
  try {
    // 第一代：超时停掉。这是最普通的 stop 来源。
    const info1 = await backend.start();
    assert.equal(backend.state, 'ready');
    const first = backend.request('hang', {}, { timeoutMs: 60 }).then(
      () => assert.fail('hang 不应答，必然超时'),
      (error) => error,
    );
    const timeoutError = await first;
    assert.equal(timeoutError.code, 'TIMEOUT');
    assert.equal(timeoutError.dispatched, true);
    await waitFor(() => backend.state === 'idle', { label: '第一代 worker 退出' });
    assert.equal(kill.kills.length, 1, '第一代必须被杀一次');
    assert.equal(backend.stats.spawns, 1);

    // 第二代：取消触发 grace 后停掉。换一条 stop 来源，证明问题不在某条路径里。
    const info2 = await backend.start();
    assert.equal(backend.stats.spawns, 2);
    assert.notEqual(info2.pid, info1.pid);
    const second = backend.request('hang', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('已取消的 hang 不应成功'),
      (error) => error,
    );
    await waitFor(() => backend.stats.dispatched === 2, { label: '第二代请求已写出' });
    assert.equal(backend.cancelAll('测试取消'), 1);
    const cancelError = await second;
    assert.equal(cancelError.code, 'CANCELLED');
    assert.equal(cancelError.dispatched, true);
    await waitFor(() => backend.state === 'stopping', { label: '第二代进入 stopping' });
    await waitFor(() => kill.kills.length === 2, { label: '第二代被 kill' });

    // 关键断言：kill 延迟 500ms，此刻第二个 child 还活着。start() 必须等它退出；
    // 回归前 #exitPromise 里是第一代那个已结算的 Promise，start() 会立刻开第三代。
    const spawnsBefore = backend.stats.spawns;
    // 先接住结果再断言：断言失败时也不能留下未处理的 rejection（它会盖掉真正的失败信息）。
    const outcome = backend.start().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await sleep(150);
    const spawnsWhileDying = backend.stats.spawns;
    const stateWhileDying = backend.state;
    const started = await outcome;
    assert.equal(
      spawnsWhileDying,
      spawnsBefore,
      '第二个 worker 尚未退出时不得开启第三代 worker',
    );
    assert.equal(stateWhileDying, 'stopping', '等待期间应保持 stopping，而不是已经开始启动');
    assert.equal(started.ok, true, `start() 应在旧进程退出后成功：${started.error?.message ?? ''}`);
    assert.equal(backend.stats.spawns, spawnsBefore + 1);
    assert.equal(backend.state, 'ready');
    assert.equal(typeof backend.info.pid, 'number', '第三代 worker 应已握手');
    assert.equal(kill.kills.length, 2, 'start() 只等待，不应额外 kill 一次');
  } finally {
    await cleanup(backend, dir, kill);
  }
});

test('重复 stop：同一代 worker 只 kill 一次，重复 cancelAll 不重复结算', async () => {
  const { dir, script } = makeWorkerScript();
  const kill = slowKill(300);
  const backend = newBackend(script);
  try {
    await backend.start();
    const pending = backend.request('hang', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('已取消的 hang 不应成功'),
      (error) => error,
    );
    await waitFor(() => backend.stats.dispatched === 1, { label: '请求已写出' });
    assert.equal(backend.cancelAll('关闭能力'), 1);
    const error = await pending;
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.dispatched, true);
    // 已经结算过的请求不该被第二次 cancel 再结算一遍，也不该再排一个 stop。
    assert.equal(backend.cancelAll('关闭能力'), 0);
    await waitFor(() => kill.kills.length === 1, { label: 'grace 到点后的 kill' });
    await sleep(250);
    assert.equal(kill.kills.length, 1, '重复 cancelAll 不得给同一代再排一次 kill');
    await waitFor(() => backend.state === 'idle', { label: 'worker 退出' });
    // 停干净之后仍能换代恢复。
    const info = await backend.start();
    assert.equal(backend.stats.spawns, 2);
    assert.equal(backend.state, 'ready');
    assert.equal(typeof info.pid, 'number');
  } finally {
    await cleanup(backend, dir, kill);
  }
});

test('worker 在请求中途退出：dispatched=true、WORKER_EXITED，且能换代恢复', async () => {
  const { dir, script } = makeWorkerScript();
  const backend = newBackend(script);
  try {
    const info1 = await backend.start();
    const failed = backend.request('die', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('worker 退出后请求不应成功'),
      (error) => error,
    );
    const error = await failed;
    assert.equal(error.code, 'WORKER_EXITED');
    assert.equal(error.dispatched, true, '已写出的请求必须标记 unknown outcome');
    assert.match(error.message, /exited/);
    await waitFor(() => backend.state === 'idle', { label: '退出后的清理' });
    const info2 = await backend.start();
    assert.equal(backend.stats.spawns, 2);
    assert.notEqual(info2.pid, info1.pid, '必须是一个新进程');
  } finally {
    await cleanup(backend, dir, undefined);
  }
});

test('超时后重启：第二代 echo 由新进程应答（旧 TIMEOUT 不污染后续请求）', async () => {
  const { dir, script } = makeWorkerScript();
  const kill = slowKill(120);
  const backend = newBackend(script);
  try {
    const info1 = await backend.start();
    const timeoutError = await backend.request('hang', {}, { timeoutMs: 60 }).then(
      () => assert.fail('hang 不应答，必然超时'),
      (error) => error,
    );
    assert.equal(timeoutError.code, 'TIMEOUT');
    assert.equal(timeoutError.dispatched, true);
    assert.equal(typeof timeoutError.releaseConfirmed, 'boolean');
    await waitFor(() => backend.state === 'idle', { label: '第一代退出' });
    const result = await backend.request('echo', {}, { timeoutMs: 5_000 });
    assert.equal(backend.stats.spawns, 2);
    assert.equal(result.workerPid, backend.info.pid);
    assert.notEqual(result.workerPid, info1.pid, '应答必须来自新进程');
  } finally {
    await cleanup(backend, dir, kill);
  }
});

test('启动失败：脚本不存在 → NO_WORKER_SCRIPT，不 spawn，也不留下半启动状态', async () => {
  const missing = join(tmpdir(), `dsh-bridge-missing-${process.pid}-${Date.now()}.ps1`);
  const backend = new PowerShellBackend({
    scriptPath: missing,
    powerShell: PS,
    startTimeoutMs: 20_000,
  });
  try {
    await assert.rejects(backend.start(), (error) => {
      assert.equal(error.code, 'NO_WORKER_SCRIPT');
      assert.match(error.message, /not found/);
      return true;
    });
    assert.equal(backend.stats.spawns, 0);
    assert.equal(backend.alive, false);
    assert.equal(backend.state, 'idle', '失败后应回到可重试的 idle');
  } finally {
    backend.dispose();
  }
});

test('取消停止：独立释放尚未完成时 start 不得换代，且最终报告真实释放结果', async () => {
  const { dir, script } = makeWorkerScript();
  const release = makeReleaseScript(dir, 2_300);
  const heldFilePath = join(dir, 'held.json');
  // 非 JSON 是安全保险：旧代码若忽略释放脚本注入，真实 release-input.ps1 只会报解析错误。
  writeFileSync(heldFilePath, 'not-json', 'utf8');
  const backend = new PowerShellBackend({
    scriptPath: script,
    powerShell: PS,
    timeoutMs: 10_000,
    startTimeoutMs: 20_000,
    cancelGraceMs: 150,
    heldFilePath,
    releaseScriptPath: release.script,
  });
  try {
    await backend.start();
    const pending = backend.request('hang', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('已取消的 hang 不应成功'),
      (error) => error,
    );
    await waitFor(() => backend.stats.dispatched === 1, { label: '请求已写出' });
    backend.cancelAll('测试慢速释放');
    assert.equal((await pending).code, 'CANCELLED');
    await waitFor(() => backend.state === 'stopping', { label: '停止已开始' });
    const started = backend.start().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    // 释放需要约 2.3s，而旧 #exited() 只有 2s 上限：这里必须仍只有第一代。
    await sleep(2_150);
    assert.equal(backend.stats.spawns, 1, '释放未返回、旧 worker 尚未被杀时不得启动下一代');
    assert.equal(backend.state, 'stopping');
    const outcome = await started;
    assert.equal(outcome.ok, true, `释放完成后应能换代：${outcome.error?.message ?? ''}`);
    assert.equal(backend.stats.spawns, 2);
    assert.equal(backend.lastRelease?.releaseConfirmed, true);
    await waitFor(() => backend.state === 'ready', { label: '第二代就绪' });
  } finally {
    await cleanup(backend, dir, undefined);
  }
});

test('超时停止：同一次故障只运行一次独立释放，不重复等待或重复发送', async () => {
  const { dir, script } = makeWorkerScript();
  const release = makeReleaseScript(dir, 120);
  const heldFilePath = join(dir, 'held.json');
  writeFileSync(heldFilePath, 'not-json', 'utf8');
  const backend = new PowerShellBackend({
    scriptPath: script,
    powerShell: PS,
    timeoutMs: 10_000,
    startTimeoutMs: 20_000,
    heldFilePath,
    releaseScriptPath: release.script,
  });
  try {
    await backend.start();
    const error = await backend.request('hang', {}, { timeoutMs: 60 }).then(
      () => assert.fail('hang 不应答，必然超时'),
      (failure) => failure,
    );
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.dispatched, true);
    assert.equal(error.releaseConfirmed, true);
    await waitFor(() => backend.state === 'idle', { label: '超时 worker 退出' });
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(release.invocations, 'utf8').trim().split(/\r?\n/).length, 1,
      '超时路径先 release、#stopChild 又 release 的旧行为不得回归');
  } finally {
    await cleanup(backend, dir, undefined);
  }
});

test('并发 start：所有等待同一代退出的调用者共享新一代，不得误读别人的新 child', async () => {
  const { dir, script } = makeWorkerScript();
  const release = makeReleaseScript(dir, 1_200);
  const heldFilePath = join(dir, 'held.json');
  writeFileSync(heldFilePath, 'not-json', 'utf8');
  const backend = new PowerShellBackend({
    scriptPath: script, powerShell: PS, timeoutMs: 10_000, startTimeoutMs: 20_000,
    cancelGraceMs: 150, heldFilePath, releaseScriptPath: release.script,
  });
  try {
    await backend.start();
    const pending = backend.request('hang', {}, { timeoutMs: 10_000 }).then(
      () => assert.fail('已取消的 hang 不应成功'), (error) => error,
    );
    await waitFor(() => backend.stats.dispatched === 1, { label: '并发 start 测试的请求已写出' });
    backend.cancelAll('测试并发 start');
    assert.equal((await pending).code, 'CANCELLED');
    await waitFor(() => backend.state === 'stopping', { label: '并发 start 前进入 stopping' });
    const outcomes = await Promise.allSettled([backend.start(), backend.start()]);
    assert.deepEqual(outcomes.map((one) => one.status), ['fulfilled', 'fulfilled'],
      outcomes.map((one) => one.status === 'rejected' ? one.reason?.message : 'ok').join(' | '));
    assert.equal(backend.stats.spawns, 2, '两个 waiter 只能共同启动一个新 child');
    assert.equal(backend.state, 'ready');
  } finally {
    await cleanup(backend, dir, undefined);
  }
});

test('START_TIMEOUT：立即重启也必须等旧 child 释放并退出，之后才能使用新脚本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-start-timeout-'));
  const script = join(dir, 'never-ready.ps1');
  const pidFile = join(dir, 'first.pid');
  writeFileSync(script, `Set-Content -LiteralPath '${pidFile.replaceAll("'", "''")}' -Value \$PID
while (\$true) { Start-Sleep -Milliseconds 100 }
`, 'utf8');
  const release = makeReleaseScript(dir, 1_800);
  const heldFilePath = join(dir, 'held.json');
  writeFileSync(heldFilePath, 'not-json', 'utf8');
  const backend = new PowerShellBackend({
    scriptPath: script, powerShell: PS, timeoutMs: 10_000, startTimeoutMs: 500,
    heldFilePath, releaseScriptPath: release.script,
  });
  try {
    const starting = backend.start().then(() => null, (error) => error);
    await waitFor(() => existsSync(pidFile), { label: '第一代 never-ready pid 已落盘' });
    const oldPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(oldPid) && oldPid > 0);
    const first = await starting;
    assert.equal(first.code, 'START_TIMEOUT');
    assert.equal(backend.state, 'stopping', '超时不等于进程已死；必须保留停止中的代际状态');

    // 已运行的第一代不会重读脚本；只有合法的新一代会使用这个可握手版本。
    writeFileSync(script, FAKE_WORKER, 'utf8');
    const second = backend.start().then((info) => ({ info }), (error) => ({ error }));
    await sleep(400);
    assert.equal(backend.stats.spawns, 1, '旧 worker 还在慢速独立释放时不得提前 spawn');
    assert.equal(backend.state, 'stopping');
    const outcome = await second;
    assert.ok(outcome.info, `第二代应在旧代真正退出后就绪：${outcome.error?.message ?? ''}`);
    assert.equal(backend.stats.spawns, 2);
    assert.equal(backend.state, 'ready');
    assert.throws(() => process.kill(oldPid, 0), '新 generation 启动前旧 PID 必须已经退出');
  } finally {
    await cleanup(backend, dir, undefined);
  }
});

test('旧超时释放回调不得停止已经换代的新 worker，也不得重复释放', async () => {
  const { dir, script } = makeWorkerScript();
  writeFileSync(script, FAKE_WORKER.replace(
    "  if ($obj.cmd -eq 'echo') {",
    "  if ($obj.cmd -eq 'slowdie') { Start-Sleep -Milliseconds 300; exit 0 }\n  if ($obj.cmd -eq 'echo') {",
  ), 'utf8');
  const release = makeReleaseScript(dir, 1_400);
  const heldFilePath = join(dir, 'held.json');
  writeFileSync(heldFilePath, 'not-json', 'utf8');
  const backend = new PowerShellBackend({
    scriptPath: script, powerShell: PS, timeoutMs: 10_000, startTimeoutMs: 20_000,
    heldFilePath, releaseScriptPath: release.script,
  });
  try {
    await backend.start();
    const firstError = await backend.request('slowdie', {}, { timeoutMs: 80 }).then(
      () => assert.fail('slowdie 不应成功'), (error) => error,
    );
    assert.ok(['TIMEOUT', 'WORKER_EXITED'].includes(firstError.code), firstError.code);
    assert.equal(firstError.dispatched, true);
    await waitFor(() => backend.state === 'idle', { label: '旧 worker 在慢速释放中自然退出' });

    const second = await backend.start();
    const echo = await backend.request('echo', {}, { timeoutMs: 5_000 });
    assert.equal(echo.workerPid, second.pid);
    assert.equal(backend.stats.spawns, 2);
    await waitFor(() => existsSync(release.invocations), { label: '旧 release 回调已完成' });
    await sleep(200);
    assert.equal(backend.state, 'ready', '旧回调不得把新 generation 停掉');
    assert.equal(backend.alive, true);
    const again = await backend.request('echo', {}, { timeoutMs: 5_000 });
    assert.equal(again.workerPid, second.pid);
    const calls = readFileSync(release.invocations, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(calls.length, 1, '旧回调不得对新代再执行一次独立释放');
  } finally {
    await cleanup(backend, dir, undefined);
  }
});

test('kill error 不是 exit：旧进程仍活着时 start 不得换代', async () => {
  const { dir, script } = makeWorkerScript();
  const backend = new PowerShellBackend({
    scriptPath: script, powerShell: PS, timeoutMs: 10_000, startTimeoutMs: 20_000,
    heldFilePath: '',
  });
  const originalKill = ChildProcess.prototype.kill;
  let firstPid;
  let second;
  try {
    const first = await backend.start();
    firstPid = first.pid;
    ChildProcess.prototype.kill = function (...args) {
      if (this.pid === firstPid) {
        const error = Object.assign(new Error('simulated EPERM'), { code: 'EPERM' });
        process.nextTick(() => this.emit('error', error));
        return false;
      }
      return originalKill.apply(this, args);
    };
    const failure = await backend.request('hang', {}, { timeoutMs: 80 }).then(
      () => assert.fail('hang 不应成功'), (error) => error,
    );
    assert.equal(failure.code, 'TIMEOUT');
    await sleep(100);
    assert.doesNotThrow(() => process.kill(firstPid, 0), 'kill error 后旧进程实际上仍存活');
    assert.equal(backend.state, 'stopping', '不得把 kill error 当退出并清代际');
    assert.equal(backend.stats.spawns, 1);

    let secondSettled = false;
    second = backend.start().finally(() => { secondSettled = true; });
    await sleep(200);
    assert.equal(secondSettled, false, '旧进程未退出前 replacement 不得就绪');
    assert.equal(backend.stats.spawns, 1);

    process.kill(firstPid);
    const replacement = await second;
    assert.notEqual(replacement.pid, firstPid);
    assert.equal(backend.stats.spawns, 2);
    assert.throws(() => process.kill(firstPid, 0));
  } finally {
    ChildProcess.prototype.kill = originalKill;
    if (firstPid !== undefined) {
      try { process.kill(firstPid); } catch { /* already gone */ }
    }
    if (second) await second.catch(() => {});
    await cleanup(backend, dir, undefined);
  }
});

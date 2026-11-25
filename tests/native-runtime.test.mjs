import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bundledWorkerPath,
  publishNativeProjects,
  resolveWorkerLaunch,
} from '../tools/native-runtime.mjs';

test('native worker launch defaults to stdio and preserves an explicit path', () => {
  const launch = resolveWorkerLaunch({ explicitPath: 'C:\\custom\\Rt.Worker.exe' });
  assert.equal(launch.configured, true);
  assert.equal(launch.workerPath, 'C:\\custom\\Rt.Worker.exe');
  assert.deepEqual(launch.workerArgs, ['--stdio']);
  assert.equal(launch.source, 'explicit');
});

test('native worker launch discovers the bundled executable only when it exists', () => {
  const root = join('C:\\', 'package');
  const expected = bundledWorkerPath(root);
  assert.equal(resolveWorkerLaunch({ packageRoot: root, exists: () => false }).configured, false);
  const launch = resolveWorkerLaunch({ packageRoot: root, exists: (path) => path === expected });
  assert.equal(launch.configured, true);
  assert.equal(launch.workerPath, expected);
  assert.deepEqual(launch.workerArgs, ['--stdio']);
  assert.equal(launch.source, 'bundled');
  const disabled = resolveWorkerLaunch({ packageRoot: root, includeBundled: false, exists: () => { throw new Error('bundled lookup must be disabled'); } });
  assert.equal(disabled.configured, false);
  assert.equal(disabled.workerPath, null);
  assert.equal(disabled.source, 'missing');
});

test('an injected worker factory does not require a native executable', () => {
  const launch = resolveWorkerLaunch({ hasClientFactory: true, exists: () => false });
  assert.equal(launch.configured, true);
  assert.equal(launch.workerPath, null);
  assert.equal(launch.source, 'factory');
});

test('native publish emits three framework-dependent win-x64 applications', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-native-publish-test-'));
  const calls = [];
  try {
    const outputs = publishNativeProjects(root, {
      platform: 'win32',
      exec: (command, args, options) => calls.push({ command, args, options }),
      exists: (path) => calls.some((call) => call.args.includes(join(path, '..'))) || path.endsWith('.exe'),
    });
    assert.deepEqual(outputs.map((entry) => entry.name), ['worker', 'synth', 'harness']);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.command, 'dotnet');
      assert.equal(call.args[0], 'publish');
      assert.ok(call.args.includes('Release'));
      assert.ok(call.args.includes('win-x64'));
      assert.ok(call.args.includes('--self-contained'));
      assert.ok(call.args.includes('false'));
      assert.equal(call.options.shell, false);
      assert.equal(call.options.stdio, 'inherit');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native publish refuses a non-Windows host before invoking dotnet', () => {
  let invoked = false;
  assert.throws(() => publishNativeProjects('C:\\package', {
    platform: 'linux',
    exec: () => { invoked = true; },
  }), /Windows/i);
  assert.equal(invoked, false);
});

test('package declares the native build and native asset allowlist', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['build:native'], 'node tools/build-native.mjs');
  assert.equal(manifest.scripts['pack:candidate:native'], 'npm run build:native && npm run pack:candidate');
  assert.ok(manifest.files.includes('native'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  MANIFEST_NAME,
  PACKAGE_ROOT,
  productionFiles,
  verifyRelease,
} from '../internal/release-manifest.mjs';

test('候选发行包：写入清单、实际 npm pack、解包后身份仍可验证', () => {
  const stage = mkdtempSync(join(tmpdir(), 'vision-pack-stage-'));
  const output = mkdtempSync(join(tmpdir(), 'vision-pack-output-'));
  const installed = mkdtempSync(join(tmpdir(), 'vision-pack-installed-'));
  try {
    for (const name of productionFiles(PACKAGE_ROOT)) {
      const destination = join(stage, name.split('/').join(sep));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(PACKAGE_ROOT, name.split('/').join(sep)), destination);
    }
    const cli = join(stage, 'tools', 'pack-candidate.mjs');
    assert.ok(existsSync(cli), 'tools/pack-candidate.mjs 必须存在并进入发行文件集');

    const stdout = execFileSync(process.execPath, [cli, '--pack-destination', output], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    const archives = readdirSync(output).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1, stdout);
    const archive = join(output, archives[0]);
    assert.ok(statSync(archive).size > 0);

    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000 });
    assert.ok(listing.split(/\r?\n/).includes('package/' + MANIFEST_NAME), listing);
    execFileSync('tar', ['-xzf', archive, '-C', installed], { timeout: 30_000 });
    const verification = verifyRelease(join(installed, 'package'));
    assert.equal(verification.error, '');
    assert.deepEqual(verification.missing, []);
    assert.deepEqual(verification.extra, []);
    assert.deepEqual(verification.mismatched, []);
    assert.equal(verification.matches, true, JSON.stringify(verification.checks));
    assert.equal(verification.buildId, result.releaseBuildId);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
    rmSync(installed, { recursive: true, force: true });
  }
});

function copyProductionStage() {
  const stage = mkdtempSync(join(tmpdir(), 'vision-pack-adversarial-stage-'));
  for (const name of productionFiles(PACKAGE_ROOT)) {
    const destination = join(stage, name.split('/').join(sep));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(PACKAGE_ROOT, name.split('/').join(sep)), destination);
  }
  return stage;
}

function installFakeNpm(stage, output) {
  const fakeNpm = join(output, 'fake npm ; not-a-shell.cjs');
  writeFileSync(fakeNpm, `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const destination = args[args.indexOf('--pack-destination') + 1];
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'fake.tgz'), 'this is not a tarball');
    const files = JSON.parse(process.env.FAKE_PACK_FILES).map((path) => ({ path }));
    console.log(JSON.stringify([{ filename: 'fake.tgz', files }]));
  `, 'utf8');
  return {
    ...process.env,
    npm_execpath: fakeNpm,
    FAKE_PACK_FILES: JSON.stringify([...productionFiles(stage), MANIFEST_NAME]),
  };
}

test('候选发行 CLI：拒绝只有文件清单、实际却不是 tarball 的交付物', () => {
  const stage = copyProductionStage();
  const output = mkdtempSync(join(tmpdir(), 'vision-pack-fake-output-'));
  try {
    const env = installFakeNpm(stage, output);
    let failure;
    try {
      execFileSync(process.execPath, [join(stage, 'tools', 'pack-candidate.mjs'), '--pack-destination', output], {
        cwd: stage, env, encoding: 'utf8', timeout: 30_000,
      });
    } catch (error) { failure = error; }
    assert.ok(failure, '假 npm 的文本文件不能被当成成功发行包');
    assert.match(String(failure.stderr), /tar|archive|verify|发行/i);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('候选发行 CLI：解包后的入口必须能加载，缺本地 import 不得放行', () => {
  const stage = copyProductionStage();
  const output = mkdtempSync(join(tmpdir(), 'vision-pack-import-output-'));
  try {
    rmSync(join(stage, 'see', 'apply.mjs'), { force: true });
    let failure;
    try {
      execFileSync(process.execPath, [join(stage, 'tools', 'pack-candidate.mjs'), '--pack-destination', output], {
        cwd: stage, encoding: 'utf8', timeout: 60_000,
      });
    } catch (error) { failure = error; }
    assert.ok(failure, '缺少 index.js 静态依赖时不能返回 ok:true');
    assert.match(String(failure.stderr), /MODULE_NOT_FOUND|entry|import|加载|smoke/i);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('候选发行 CLI：未知、重复和缺失参数必须显式失败', () => {
  const stage = copyProductionStage();
  const output = mkdtempSync(join(tmpdir(), 'vision-pack-args-output-'));
  try {
    const env = installFakeNpm(stage, output);
    const cli = join(stage, 'tools', 'pack-candidate.mjs');
    for (const args of [
      ['--unknown'],
      ['positional'],
      ['--pack-destination'],
      ['--pack-destination', output, '--pack-destination', output],
      ['--pack-destination', output, 'extra'],
    ]) {
      let failure;
      try {
        execFileSync(process.execPath, [cli, ...args], { cwd: stage, env, encoding: 'utf8', timeout: 30_000 });
      } catch (error) { failure = error; }
      assert.ok(failure, '参数应失败：' + JSON.stringify(args));
      assert.match(String(failure.stderr), /argument|参数|pack-destination|unknown|unexpected/i);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

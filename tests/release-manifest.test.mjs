/**
 * internal/release-manifest.mjs 发行身份回归（方案 Task 0）。
 *
 * 清单的全部价值是“正式发行包里的生产文件一个不漏”：package.json 的 files 决定**实际发行什么**，
 * productionFiles() 决定**什么进入 releaseBuildId**。两者一旦脱节，改一个仍然发行的目录
 * （see/、tools/、skills/）可以保持同一个 releaseBuildId，宿主端的 RELEASE_BUILD_MISMATCH
 * 就永远发现不了“同一个版本、两套文件”的半更新（研究报告 P1-C 的同一类问题）。
 *
 * 因此这里先钉住“package.json 里实际发行的目录必须全部被哈希”（对真实包），再用临时夹具
 * 钉住确定性与内容纪律：路径排序、清单自身排除、OS 噪声跳过、缺失文件不被静默吞掉、
 * 写清单后可自校验且清单自身不改变身份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_NAME,
  PACKAGE_ROOT,
  buildReleaseIdentity,
  productionFiles,
  readPackageManifest,
  readReleaseManifest,
  verifyRelease,
  writeReleaseManifest,
} from '../internal/release-manifest.mjs';

/** 测试侧镜像 isProductionName 的公开规则：清单自身、OS 噪声、归档/日志后缀不进哈希。 */
const SKIP_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIP_SUFFIXES = ['.log', '.tmp', '.bak', '.zip', '.tgz', '.tar', '.gz', '.7z'];

/**
 * 按发行规则判断一个包内路径是否应当被哈希。
 * @param name 包内正斜杠路径。
 */
function shipsByPolicy(name) {
  if (name === MANIFEST_NAME) return false;
  const base = name.split('/').at(-1) ?? name;
  if (SKIP_BASENAMES.has(base)) return false;
  return !SKIP_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
}

/**
 * 递归列出目录下的普通文件（包内正斜杠路径）。
 * @param root 包根目录。
 * @param directory 包内相对目录。
 * @param list 累加器。
 */
function walkFiles(root, directory, list = []) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const name = directory + '/' + entry.name;
    if (entry.isDirectory()) walkFiles(root, name, list);
    else if (entry.isFile()) list.push(name);
  }
  return list;
}

/** package.json 的 files 中当前真实存在的目录项。 */
function shippedDirectories(root) {
  const manifest = readPackageManifest(root).manifest;
  const entries = Array.isArray(manifest?.files) ? manifest.files : [];
  return entries.filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 在临时目录里造一个“像发行包”的根：package.json + 各发行目录 + 各种噪声。 */
function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-manifest-'));
  const write = (name, body) => {
    const absolute = join(root, ...name.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, body, 'utf8');
  };
  write('package.json', JSON.stringify({
    name: 'fixture-plugin',
    version: '9.9.9',
    files: ['index.js', 'REALTIME.md', 'backend', 'browser', 'internal', 'see', 'skills', 'tools', 'native', 'realtime'],
  }, null, 2));
  write('index.js', 'export const entry = true;\n');
  write('REALTIME.md', '# realtime\n');
  write('client.js', 'export const client = true;\n');
  write('cordis.patch.yml', 'patch: true\n');
  write('backend/worker.ps1', '# worker\n');
  write('backend/bridge.js', 'export const bridge = true;\n');
  write('backend/release-input.ps1', '# release\n');
  write('backend/parts-manifest.json', '{}\n');
  write('browser/x.mjs', 'export const browser = 1;\n');
  write('internal/y.mjs', 'export const internal = 1;\n');
  write('see/z.mjs', 'export const see = 1;\n');
  write('skills/SKILL.md', '# skill\n');
  write('tools/t.mjs', 'export const tool = 1;\n');
  write('native/win-x64/worker/Rt.Worker.exe', 'native\n');
  write('realtime/contracts.mjs', 'export const realtime = true;\n');
  // 噪声：日志、OS 垃圾、归档、清单自身都不该改变身份。
  write('backend/debug.log', 'noise\n');
  write('internal/.DS_Store', 'noise\n');
  write('see/archive.zip', 'noise\n');
  write(MANIFEST_NAME, '{"stale":true}\n');
  // 未列入 files 的文件同样不属于发行身份。
  write('docs/notes.md', 'not shipped\n');
  return root;
}

const FIXTURE_EXPECTED = [
  'backend/bridge.js',
  'backend/parts-manifest.json',
  'backend/release-input.ps1',
  'backend/worker.ps1',
  'browser/x.mjs',
  'client.js',
  'cordis.patch.yml',
  'index.js',
  'internal/y.mjs',
  'native/win-x64/worker/Rt.Worker.exe',
  'package.json',
  'REALTIME.md',
  'realtime/contracts.mjs',
  'see/z.mjs',
  'skills/SKILL.md',
  'tools/t.mjs',
];

test('发行目录：package.json files 里实际发行的目录，其每一个文件都进入哈希', () => {
  const directories = shippedDirectories(PACKAGE_ROOT);
  const declared = readPackageManifest(PACKAGE_ROOT).manifest?.files ?? [];
  for (const required of ['see', 'tools', 'skills', 'native', 'realtime']) {
    assert.ok(declared.includes(required), 'package.json files 应声明 ' + required + '/');
  }
  const shipped = new Set(productionFiles(PACKAGE_ROOT));
  const problems = [];
  for (const directory of directories) {
    const names = walkFiles(PACKAGE_ROOT, directory).filter(shipsByPolicy);
    const missing = names.filter((name) => !shipped.has(name));
    if (missing.length > 0) {
      problems.push(directory + '/: ' + missing.length + '/' + names.length + ' 个文件未进入哈希（例如 '
        + missing.slice(0, 3).join(', ') + '）');
    }
  }
  assert.deepEqual(problems, [], '发行目录与哈希集合脱节：\n' + problems.join('\n'));
});

test('发行目录：see/ 与 tools/ 的每个文件都在生产集合里（方案 Task 0 第 3 条）', () => {
  const shipped = new Set(productionFiles(PACKAGE_ROOT));
  for (const directory of ['see', 'tools']) {
    const names = walkFiles(PACKAGE_ROOT, directory);
    assert.ok(names.length > 0, directory + '/ 应当非空');
    const missing = names.filter((name) => !shipped.has(name));
    assert.deepEqual(missing, [], directory + '/ 未进入发行哈希：\n' + missing.join('\n'));
  }
});

test('真实包：文件列表确定、排序稳定、无重复，且不含清单自身', () => {
  const files = productionFiles(PACKAGE_ROOT);
  assert.ok(files.length > 0);
  assert.deepEqual(files, [...new Set(files)], '不得有重复路径');
  assert.deepEqual(files, [...files].sort((a, b) => a.localeCompare(b)), '必须按路径排序');
  assert.ok(files.every((name) => !name.includes('\\')), '必须使用正斜杠');
  assert.ok(!files.includes(MANIFEST_NAME), '清单自身不得进入哈希');
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('backend/worker.ps1'));
  const first = buildReleaseIdentity(PACKAGE_ROOT);
  const second = buildReleaseIdentity(PACKAGE_ROOT);
  assert.deepEqual(second, first, '同一棵树两次计算必须完全一致');
  assert.equal(first.buildId.length, 16);
  assert.deepEqual(first.missing, []);
});

test('真实包：npm pack 的每一个生产文件都进入 releaseBuildId', () => {
  const output = execFileSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    shell: true,
  });
  const parsed = JSON.parse(output);
  const packed = parsed[0].files.map((entry) => entry.path).filter((name) => name !== MANIFEST_NAME);
  const hashed = new Set(productionFiles(PACKAGE_ROOT));
  const shippedNotHashed = packed.filter((name) => !hashed.has(name)).sort();
  const hashedNotPacked = [...hashed].filter((name) => !packed.includes(name)).sort();
  assert.deepEqual(shippedNotHashed, [], 'npm 已发行但未哈希：' + shippedNotHashed.join(', '));
  assert.deepEqual(hashedNotPacked, [], '已哈希但 npm 未发行：' + hashedNotPacked.join(', '));
  for (const required of ['README_EN.md', 'LICENSE-MIT', 'NOTICE']) {
    assert.ok(hashed.has(required), required + ' 必须进入哈希');
  }
});

test('夹具：缺失必需目录不能被省略，且阻止写清单', () => {
  const root = makeFixtureRoot();
  try {
    rmSync(join(root, 'backend'), { recursive: true, force: true });
    const identity = buildReleaseIdentity(root);
    assert.ok(identity.missing.includes('backend'), JSON.stringify(identity.missing));
    assert.throws(() => writeReleaseManifest(root), /missing backend/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：缺失原生运行时目录必须阻断发行', () => {
  const root = makeFixtureRoot();
  try {
    rmSync(join(root, 'native'), { recursive: true, force: true });
    const identity = buildReleaseIdentity(root);
    assert.ok(identity.missing.includes('native'), JSON.stringify(identity.missing));
    assert.throws(() => writeReleaseManifest(root), /missing native/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：删除关键 worker 入口不能被剩余文件掩盖', () => {
  const root = makeFixtureRoot();
  try {
    rmSync(join(root, 'backend', 'worker.ps1'));
    const identity = buildReleaseIdentity(root);
    assert.ok(identity.missing.includes('backend/worker.ps1'), JSON.stringify(identity.missing));
    assert.throws(() => writeReleaseManifest(root), /missing backend\/worker\.ps1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：空必需目录和文件冒充目录都必须阻断发行', async (t) => {
  for (const variant of ['empty', 'regular-file']) {
    await t.test(variant, () => {
      const root = makeFixtureRoot();
      try {
        rmSync(join(root, 'backend'), { recursive: true, force: true });
        if (variant === 'empty') mkdirSync(join(root, 'backend'));
        else writeFileSync(join(root, 'backend'), 'not a directory\n', 'utf8');
        const identity = buildReleaseIdentity(root);
        assert.ok(identity.missing.includes('backend'), JSON.stringify(identity.missing));
        const marker = identity.files.find((entry) => entry.name === 'backend');
        assert.equal(marker?.sha256, null, '目录占位不能被普通文件的字节哈希替代');
        assert.throws(() => writeReleaseManifest(root), /missing backend/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('夹具：只哈希发行集合，路径排序且排除清单自身与噪声', () => {
  const root = makeFixtureRoot();
  try {
    assert.deepEqual(productionFiles(root), FIXTURE_EXPECTED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：字节/哈希准确，内容变化改变 buildId，缺失文件不被静默吞掉', () => {
  const root = makeFixtureRoot();
  try {
    const identity = buildReleaseIdentity(root);
    assert.deepEqual(identity.missing, []);
    assert.equal(identity.files.length, FIXTURE_EXPECTED.length);
    assert.deepEqual(identity.files.map((entry) => entry.name), FIXTURE_EXPECTED);
    const worker = identity.files.find((entry) => entry.name === 'backend/worker.ps1');
    const bytes = readFileSync(join(root, 'backend', 'worker.ps1'));
    assert.equal(worker.bytes, bytes.length);
    assert.equal(worker.sha256, createHash('sha256').update(bytes).digest('hex'));

    writeFileSync(join(root, 'see', 'z.mjs'), 'export const see = 2;\n', 'utf8');
    const changed = buildReleaseIdentity(root);
    assert.notEqual(changed.buildId, identity.buildId, '发行文件内容变化必须改变 releaseBuildId');

    // 删除必需生产文件：名字必须保留为空洞并进入 missing，绝不能在 pack 前被静默省略。
    rmSync(join(root, 'index.js'));
    const holed = buildReleaseIdentity(root);
    assert.equal(holed.files.length, FIXTURE_EXPECTED.length);
    const missingEntry = holed.files.find((one) => one.name === 'index.js');
    assert.deepEqual(missingEntry, { name: 'index.js', bytes: null, sha256: null });
    assert.deepEqual(holed.missing, ['index.js']);
    assert.notEqual(holed.buildId, changed.buildId, '缺文件不能与完整包同 id');
    assert.throws(() => writeReleaseManifest(root), /missing index\.js/);

    // 只有显式传入的文件列表才会留下“空洞”记录：sha256=null 且被 missing 点名。
    const explicit = buildReleaseIdentity(root, { files: ['index.js', 'backend/worker.ps1', 'gone.mjs'] });
    assert.deepEqual(explicit.missing, ['index.js', 'gone.mjs']);
    for (const one of explicit.files) {
      assert.equal(one.sha256 === null, explicit.missing.includes(one.name), one.name);
    }
    assert.notEqual(explicit.buildId, holed.buildId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：写清单 → 自校验通过 → 清单自身不改变 buildId', () => {
  const root = makeFixtureRoot();
  try {
    const builtAt = '2026-11-07T00:00:00.000Z';
    const written = writeReleaseManifest(root, { builtAt });
    assert.equal(written.path, join(root, MANIFEST_NAME));
    const manifest = written.manifest;
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.name, 'fixture-plugin');
    assert.equal(manifest.version, '9.9.9');
    assert.equal(manifest.builtAt, builtAt);
    assert.equal(manifest.releaseBuildId, written.verification.buildId);
    assert.equal(manifest.files.length, FIXTURE_EXPECTED.length);
    assert.deepEqual(
      manifest.files.map((entry) => entry.name),
      FIXTURE_EXPECTED,
      '清单文件顺序必须与确定性文件列表一致',
    );

    const onDisk = JSON.parse(readFileSync(join(root, MANIFEST_NAME), 'utf8'));
    assert.deepEqual(onDisk, manifest, '写出的文件必须与返回值一致');
    assert.equal(readReleaseManifest(root).present, true);

    const verification = verifyRelease(root, { version: '9.9.9' });
    assert.equal(verification.matches, true, JSON.stringify(verification.checks));
    assert.deepEqual(verification.checks, {
      name: true,
      version: true,
      releaseBuildId: true,
      fileSet: true,
      hashes: true,
    });
    // 写清单不改变身份（自引用排除）；重复写得到同一 buildId。
    const again = writeReleaseManifest(root, { builtAt });
    assert.equal(again.manifest.releaseBuildId, manifest.releaseBuildId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：篡改 / 多余文件 / 缺失文件都能被 verifyRelease 点名', () => {
  const root = makeFixtureRoot();
  try {
    writeReleaseManifest(root);

    // 1. 内容被改：哈希不一致，buildId 也不同。
    writeFileSync(join(root, 'see', 'z.mjs'), 'export const see = 3;\n', 'utf8');
    const tampered = verifyRelease(root);
    assert.equal(tampered.matches, false);
    assert.deepEqual(tampered.mismatched, ['see/z.mjs']);
    assert.equal(tampered.checks.hashes, false);
    assert.equal(tampered.checks.releaseBuildId, false);

    // 2. 多了一个发行目录内的文件（未在清单里）。
    writeReleaseManifest(root);
    writeFileSync(join(root, 'tools', 'new.mjs'), 'export const extra = 1;\n', 'utf8');
    const extra = verifyRelease(root);
    assert.equal(extra.matches, false);
    assert.ok(extra.extra.includes('tools/new.mjs'), JSON.stringify(extra.extra));
    assert.equal(extra.checks.fileSet, false);

    // 3. 清单里列出的文件被删（实际集合缺、清单集合有）。
    writeReleaseManifest(root);
    rmSync(join(root, 'tools', 't.mjs'));
    const missing = verifyRelease(root);
    assert.equal(missing.matches, false);
    assert.ok(missing.missing.includes('tools/t.mjs'), JSON.stringify(missing.missing));
    assert.equal(missing.checks.fileSet, false);

    // 4. 写出者以树为准：删掉的文件不再被列出，重写后自校验通过（“缺失”只相对旧清单成立）。
    const rewritten = writeReleaseManifest(root);
    assert.ok(!rewritten.manifest.files.some((entry) => entry.name === 'tools/t.mjs'));
    assert.equal(rewritten.verification.matches, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('夹具：没有清单时只报告 present=false，不把开发副本判成坏包', () => {
  const root = makeFixtureRoot();
  try {
    rmSync(join(root, MANIFEST_NAME), { force: true });
    const report = verifyRelease(root);
    assert.equal(report.present, false);
    assert.equal(report.error, '');
    assert.equal(report.matches, false);
    assert.equal(report.buildId.length, 16);
    assert.equal(report.files, FIXTURE_EXPECTED.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

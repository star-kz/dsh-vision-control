/**
 * 发行身份：整份插件（不只是 worker.ps1）的路径 + SHA256 清单。
 *
 * 1.39.5 的 buildId 只由 `backend/worker.ps1` 推导，所以改了 `client.js`、
 * `internal/schema-visibility.mjs` 或 `cordis.patch.yml` 仍可能得到同一个 id；`assertWorkerContract()`
 * 又能发现"运行中的 worker 与磁盘上的 worker 不一致"，却证明不了 host / client / internal /
 * patch 来自同一个发行包。1.40.0 把这两件事分开：
 *
 *   * `workerBuildId` —— worker.ps1 的局部协议身份，仍然用于运行中进程的比对；
 *   * `releaseBuildId` —— 所有生产文件按路径排序后的有序哈希，任何一个文件不同都会变。
 *
 * 发行包在打包时写一份 `release-manifest.json`；宿主启动时重新计算并比对。源码安装没有这份
 * manifest 时只报 `RELEASE_MANIFEST_MISSING`（info），不会把开发副本误判成坏包；`doctor
 * --release` 则把它当阻断项，因为正式发行包必须带清单。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件根目录（`internal/` 的上一层）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 清单文件名；它自己不进哈希集合，否则会形成自引用。 */
export const MANIFEST_NAME = 'release-manifest.json';

/** Runtime entry points that must exist even if package.json files is edited incorrectly. */
const REQUIRED_ROOT_FILES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml'];

/** Entry points whose absence makes an otherwise self-consistent archive unusable. */
const REQUIRED_RUNTIME_FILES = [
  'backend/worker.ps1',
  'backend/bridge.js',
  'backend/release-input.ps1',
  'backend/parts-manifest.json',
];

/**
 * Directories whose every file is executed or read at runtime.
 *
 * This list must cover **every directory `package.json` `files` ships**: a directory that is
 * distributed but not hashed lets two different builds carry the same `releaseBuildId`, so a
 * half-updated install still "matches" (the P1-C class of bug). `see/` is the capture pipeline the
 * tools spawn, `tools/` is the CLI surface users and hosts invoke, and `skills/` holds the
 * SKILL.md the agent reads before acting.
 */
const RUNTIME_DIRS = ['backend', 'browser', 'internal', 'see', 'skills', 'tools', 'realtime'];

/** The optional preset bundle is shipped in the same zip but installed separately. */
const PRESET_FILES = [
  'presets/package.json',
  'presets/cordis.patch.yml',
  'presets/README.md',
];

/** Files that are build output or OS noise, never part of the release identity. */
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIP_SUFFIXES = ['.log', '.tmp', '.bak', '.zip', '.tgz', '.tar', '.gz', '.7z'];

/**
 * Whether a path belongs to the production set.
 * @param name - package-relative path with forward slashes.
 * @returns whether it should be hashed.
 */
function isProductionName(name) {
  if (name === MANIFEST_NAME) return false;
  const base = name.split('/').at(-1) ?? name;
  if (SKIP_NAMES.has(base)) return false;
  return !SKIP_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
}

/**
 * Every regular file below a directory, as package-relative forward-slash paths.
 * @param root - package root.
 * @param directory - package-relative directory name.
 * @param list - accumulator.
 * @returns the accumulator.
 */
function walk(root, directory, list = []) {
  const absolute = join(root, directory);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    // A required directory that cannot be read is a release hole, not an empty directory.
    // Keep its name as a marker; buildReleaseIdentity will report it in `missing`.
    list.push(directory);
    return list;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(root, name, list);
      continue;
    }
    if (entry.isFile() && isProductionName(name)) list.push(name);
  }
  return list;
}

/**
 * The deterministic production file list for a package root.
 * @param root - package root.
 * @returns sorted package-relative paths with forward slashes.
 */
function requiredDirectories(root) {
  const declared = readPackageManifest(root).manifest?.files;
  const packageFiles = Array.isArray(declared)
    ? declared.filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  const declaredDirectories = packageFiles.filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });
  return [...new Set([...RUNTIME_DIRS, ...declaredDirectories])];
}

export function productionFiles(root = PACKAGE_ROOT) {
  const names = [];
  const declared = readPackageManifest(root).manifest?.files;
  const packageFiles = Array.isArray(declared)
    ? declared.filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  const directories = requiredDirectories(root);
  const rootFiles = [...new Set([
    ...REQUIRED_ROOT_FILES,
    ...REQUIRED_RUNTIME_FILES,
    ...packageFiles.filter((name) => !directories.includes(name) && !PRESET_FILES.includes(name)),
  ])];

  // Required names stay in the list even when absent. This is what lets
  // buildReleaseIdentity produce { sha256: null } and `missing` instead of silently
  // blessing an incomplete tree with a valid manifest.
  for (const name of rootFiles) {
    if (isProductionName(name)) names.push(name);
  }
  for (const directory of directories) walk(root, directory, names);
  for (const name of PRESET_FILES) {
    try {
      if (statSync(join(root, name)).isFile() && isProductionName(name)) names.push(name);
    } catch {
      // Optional preset files are omitted when absent.
    }
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Read and parse the package manifest.
 * @param root - package root.
 * @returns `{ path, manifest, error }`; `manifest` is null when unreadable.
 */
export function readPackageManifest(root = PACKAGE_ROOT) {
  const path = join(root, 'package.json');
  try {
    return { path, manifest: JSON.parse(readFileSync(path, 'utf8')), error: '' };
  } catch (error) {
    return { path, manifest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Hash every production file and derive the release identity.
 *
 * Missing files are kept in the list with `sha256: null` and named in `missing`, so a package
 * with a hole cannot accidentally hash to the same id as a complete one.
 * @param root - package root.
 * @param options.files - override the production file list (tests).
 * @returns `{ root, buildId, files, missing }`.
 */
export function buildReleaseIdentity(root = PACKAGE_ROOT, { files } = {}) {
  const names = files ?? productionFiles(root);
  const entries = [];
  const missing = [];
  for (const name of names) {
    const path = join(root, name.split('/').join(sep));
    try {
      const bytes = readFileSync(path);
      entries.push({
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      entries.push({ name, bytes: null, sha256: null });
      missing.push(name);
    }
  }
  // A directory replaced by a regular file can otherwise be hashed as if it were a
  // production file. Empty required directories are equally invalid even though npm
  // silently omits them. Explicit `files` overrides remain low-level test/fixture APIs.
  if (files === undefined) {
    for (const directory of requiredDirectories(root)) {
      let directoryExists = false;
      try { directoryExists = statSync(join(root, directory)).isDirectory(); } catch { /* missing */ }
      const hasPayload = names.some((name) => {
        if (!name.startsWith(directory + '/')) return false;
        try { return statSync(join(root, name)).isFile(); } catch { return false; }
      });
      if (directoryExists && hasPayload) continue;
      const existing = entries.find((entry) => entry.name === directory);
      if (existing) {
        existing.bytes = null;
        existing.sha256 = null;
      } else {
        entries.push({ name: directory, bytes: null, sha256: null });
      }
      if (!missing.includes(directory)) missing.push(directory);
    }
  }
  const digest = createHash('sha256');
  for (const entry of entries) digest.update(`${entry.name}\0${entry.sha256 ?? 'MISSING'}\n`);
  return {
    root,
    buildId: digest.digest('hex').slice(0, 16),
    files: entries,
    missing,
  };
}

/**
 * Read the shipped release manifest, if any.
 * @param root - package root.
 * @returns `{ path, present, manifest, error }`.
 */
export function readReleaseManifest(root = PACKAGE_ROOT) {
  const path = join(root, MANIFEST_NAME);
  try {
    return { path, present: true, manifest: JSON.parse(readFileSync(path, 'utf8')), error: '' };
  } catch (error) {
    const code = error?.code;
    return {
      path,
      present: code !== 'ENOENT',
      manifest: null,
      error: code === 'ENOENT' ? '' : error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Compare the installed tree with its release manifest.
 *
 * `matches` is true only when name, version, file list, every hash, and the aggregate id agree.
 * The per-file lists are capped by the caller when rendering; this function returns them whole
 * because a doctor report should be able to name the actual offending file.
 * @param root - package root.
 * @param options.version - expected package version (defaults to package.json).
 * @returns the comparison, including `buildId` for status reports even when no manifest exists.
 */
export function verifyRelease(root = PACKAGE_ROOT, { version } = {}) {
  const identity = buildReleaseIdentity(root);
  const expected = version ?? readPackageManifest(root).manifest?.version ?? '';
  const shipped = readReleaseManifest(root);
  const result = {
    root: relative(process.cwd(), root) || '.',
    buildId: identity.buildId,
    files: identity.files.length,
    missing: [...identity.missing],
    extra: [],
    mismatched: [],
    present: shipped.present,
    manifestPath: shipped.path,
    manifest: shipped.manifest === null ? null : {
      name: shipped.manifest.name ?? null,
      version: shipped.manifest.version ?? null,
      releaseBuildId: shipped.manifest.releaseBuildId ?? null,
      builtAt: shipped.manifest.builtAt ?? null,
      files: Array.isArray(shipped.manifest.files) ? shipped.manifest.files.length : 0,
    },
    error: shipped.error,
    matches: false,
  };
  if (!shipped.present || shipped.manifest === null) return result;

  const manifest = shipped.manifest;
  const listed = new Map((Array.isArray(manifest.files) ? manifest.files : [])
    .filter((entry) => typeof entry?.name === 'string')
    .map((entry) => [entry.name, entry.sha256]));
  const actual = new Map(identity.files.map((entry) => [entry.name, entry.sha256]));
  for (const name of listed.keys()) {
    if (!actual.has(name)) result.missing.push(name);
  }
  for (const name of actual.keys()) {
    if (!listed.has(name)) result.extra.push(name);
  }
  for (const [name, sha] of listed) {
    if (actual.has(name) && actual.get(name) !== sha) result.mismatched.push(name);
  }
  const nameMatches = manifest.name === readPackageManifest(root).manifest?.name;
  const versionMatches = manifest.version === expected;
  const buildIdMatches = manifest.releaseBuildId === identity.buildId;
  result.checks = {
    name: nameMatches,
    version: versionMatches,
    releaseBuildId: buildIdMatches,
    fileSet: result.missing.length === 0 && result.extra.length === 0,
    hashes: result.mismatched.length === 0,
  };
  result.matches = Object.values(result.checks).every(Boolean);
  return result;
}

/**
 * Write a release manifest for the current tree, then verify it by reading it back.
 *
 * Used by `tools/pack-candidate.mjs`; keeping the writer and the verifier in one module is what
 * makes the two agree by construction.
 * @param root - package root.
 * @param options.builtAt - ISO timestamp (defaults to now).
 * @returns `{ path, manifest, verification }`.
 */
export function writeReleaseManifest(root = PACKAGE_ROOT, { builtAt = new Date().toISOString() } = {}) {
  const packageManifest = readPackageManifest(root).manifest;
  if (packageManifest === null) throw new Error(`cannot write ${MANIFEST_NAME}: package.json is unreadable in ${root}`);
  const identity = buildReleaseIdentity(root);
  if (identity.missing.length > 0) {
    throw new Error(`cannot write ${MANIFEST_NAME}: missing ${identity.missing.join(', ')}`);
  }
  const manifest = {
    schema: 1,
    name: packageManifest.name,
    version: packageManifest.version,
    builtAt,
    releaseBuildId: identity.buildId,
    files: identity.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  };
  const path = join(root, MANIFEST_NAME);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const verification = verifyRelease(root, { version: packageManifest.version });
  if (!verification.matches) {
    throw new Error(`release manifest verification failed after writing: ${JSON.stringify(verification.checks)}`);
  }
  return { path, manifest, verification };
}

/**
 * A compact form for status/doctor payloads: no per-file hashes.
 * @param report - a {@link verifyRelease} result.
 * @returns the summary fields.
 */
export function summarizeRelease(report) {
  return {
    buildId: report.buildId,
    files: report.files,
    missing: report.missing.slice(0, 20),
    extra: report.extra.slice(0, 20),
    mismatched: report.mismatched.slice(0, 20),
    manifest: report.present ? {
      present: true,
      version: report.manifest?.version ?? null,
      releaseBuildId: report.manifest?.releaseBuildId ?? null,
      builtAt: report.manifest?.builtAt ?? null,
      fileCount: report.manifest?.files ?? 0,
    } : { present: false },
    matches: report.matches === true,
    error: report.error,
  };
}

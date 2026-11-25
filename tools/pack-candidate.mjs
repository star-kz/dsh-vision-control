#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MANIFEST_NAME,
  productionFiles,
  verifyRelease,
  writeReleaseManifest,
} from '../internal/release-manifest.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Write the release identity, create a real npm tarball, and verify its file closure. */
export function packCandidate(root = PACKAGE_ROOT, { destination = join(root, 'dist'), builtAt } = {}) {
  const outputDirectory = resolve(root, destination);
  mkdirSync(outputDirectory, { recursive: true });
  const written = writeReleaseManifest(root, builtAt === undefined ? {} : { builtAt });
  const npmCli = process.env.npm_execpath
    ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('cannot locate npm-cli.js; run through npm run pack:candidate');
  const stdout = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', outputDirectory], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
  });
  const report = JSON.parse(stdout)[0];
  if (!report || !Array.isArray(report.files)) throw new Error('npm pack returned no file inventory');

  const actual = new Set(report.files.map((entry) => entry.path));
  const expected = new Set([...productionFiles(root), MANIFEST_NAME]);
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new Error('npm pack file closure mismatch: ' + JSON.stringify({ missing, extra }));
  }
  if (!actual.has(MANIFEST_NAME)) throw new Error(MANIFEST_NAME + ' is absent from the tarball');

  const archive = isAbsolute(report.filename) ? report.filename : join(outputDirectory, basename(report.filename));
  if (statSync(archive).size <= 0) throw new Error('npm pack produced an empty archive: ' + archive);

  // A matching JSON inventory is not evidence that the artifact is a tarball, nor
  // that its installed bytes match the manifest. Verify the deliverable itself.
  const extraction = mkdtempSync(join(tmpdir(), 'dsh-pack-candidate-'));
  let archiveVerification;
  let nativeWorkerHandshake = false;
  try {
    execFileSync('tar', ['-xzf', archive, '-C', extraction], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });
    archiveVerification = verifyRelease(join(extraction, 'package'), { version: written.manifest.version });
    const valid = archiveVerification.present
      && archiveVerification.matches
      && archiveVerification.error === ''
      && archiveVerification.missing.length === 0
      && archiveVerification.extra.length === 0
      && archiveVerification.mismatched.length === 0
      && archiveVerification.buildId === written.manifest.releaseBuildId;
    if (!valid) {
      throw new Error('tarball release verification failed: ' + JSON.stringify({
        present: archiveVerification.present,
        matches: archiveVerification.matches,
        error: archiveVerification.error,
        missing: archiveVerification.missing,
        extra: archiveVerification.extra,
        mismatched: archiveVerification.mismatched,
        checks: archiveVerification.checks,
      }));
    }
    // The manifest proves byte identity, not that Node can resolve the entry's
    // static imports. Execute only the extracted entry module: index.js catches
    // absent host packages and does not start a server until apply() is called.
    // A missing local module still fails module loading and must reject the candidate.
    execFileSync(process.execPath, [join(extraction, 'package', 'index.js'), '--pack-candidate-smoke'], {
      cwd: join(extraction, 'package'),
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
      env: { ...process.env, DSH_PACK_CANDIDATE_SMOKE: '1' },
    });

    // A native candidate must start the Worker from the extracted package, not
    // accidentally fall back to the source checkout or an environment override.
    const packageRoot = join(extraction, 'package');
    if (existsSync(join(packageRoot, 'native', 'win-x64', 'worker', 'Rt.Worker.exe'))) {
      const moduleUrl = pathToFileURL(join(packageRoot, 'tools', 'realtime.mjs')).href;
      const source = `const { createRealtimeHost } = await import(${JSON.stringify(moduleUrl)});
        const host = createRealtimeHost({ env: {} });
        try {
          const reply = await host.targets({}, { agent: { session: { id: 'pack-native-smoke' } } });
          if (!reply || reply.degraded !== false || reply.synthetic !== false || !Array.isArray(reply.targets)) throw new Error('native Worker targets handshake failed: ' + JSON.stringify(reply));
          console.log(JSON.stringify({ ok: true, targetCount: reply.targets.length }));
        } finally { await host.dispose(); }`;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: packageRoot, encoding: 'utf8', shell: false, timeout: 30_000,
        env: { ...process.env, DSH_RT_WORKER_PATH: '', DSH_RT_HARNESS_PATH: '', DSH_PACK_CANDIDATE_SMOKE: '1' },
      });
      const verdict = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
      if (verdict.ok !== true) throw new Error('extracted native Worker handshake did not confirm');
      nativeWorkerHandshake = true;
    }
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
  return {
    archive,
    releaseBuildId: written.manifest.releaseBuildId,
    fileCount: actual.size,
    verification: archiveVerification,
    nativeWorkerHandshake,
  };
}

function parseDestination(argv) {
  if (argv.length === 0) return join(PACKAGE_ROOT, 'dist');
  if (argv[0] !== '--pack-destination') {
    throw new Error('unknown or unexpected argument: ' + argv[0]);
  }
  if (argv.length < 2 || !argv[1] || argv[1].startsWith('--')) {
    throw new Error('--pack-destination requires a directory');
  }
  if (argv.length !== 2) {
    throw new Error('unexpected or duplicate pack-candidate arguments: ' + argv.slice(2).join(' '));
  }
  return argv[1];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = packCandidate(PACKAGE_ROOT, { destination: parseDestination(process.argv.slice(2)) });
    console.log(JSON.stringify({
      ok: true,
      archive: result.archive,
      releaseBuildId: result.releaseBuildId,
      fileCount: result.fileCount,
      nativeWorkerHandshake: result.nativeWorkerHandshake,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

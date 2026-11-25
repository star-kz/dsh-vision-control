import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const NATIVE_PROJECTS = Object.freeze([
  Object.freeze({ name: 'worker', project: join('rt', 'src', 'Rt.Worker', 'Rt.Worker.csproj'), executable: 'Rt.Worker.exe' }),
  Object.freeze({ name: 'synth', project: join('rt', 'src', 'Rt.SynthWindow', 'Rt.SynthWindow.csproj'), executable: 'Rt.SynthWindow.exe' }),
  Object.freeze({ name: 'harness', project: join('rt', 'src', 'Rt.Harness', 'Rt.Harness.csproj'), executable: 'Rt.Harness.exe' }),
]);

export function bundledWorkerPath(root = PACKAGE_ROOT) {
  return join(root, 'native', 'win-x64', 'worker', 'Rt.Worker.exe');
}

export function bundledHarnessPath(root = PACKAGE_ROOT) {
  return join(root, 'native', 'win-x64', 'harness', 'Rt.Harness.exe');
}

/** Resolve launch configuration without turning a missing optional runtime into a fake success. */
export function resolveWorkerLaunch({
  explicitPath,
  workerArgs,
  packageRoot = PACKAGE_ROOT,
  exists = existsSync,
  hasClientFactory = false,
  includeBundled = true,
} = {}) {
  const explicit = typeof explicitPath === 'string' && explicitPath.trim() !== '' ? explicitPath.trim() : null;
  const bundled = includeBundled ? bundledWorkerPath(packageRoot) : null;
  const workerPath = explicit ?? (bundled !== null && exists(bundled) ? bundled : null);
  return {
    configured: hasClientFactory || workerPath !== null,
    workerPath,
    workerArgs: workerArgs ?? ['--stdio'],
    source: hasClientFactory ? 'factory' : explicit ? 'explicit' : workerPath ? 'bundled' : 'missing',
  };
}

/** Publish the distributable native applications. The .NET 8 desktop runtime remains a host prerequisite. */
export function publishNativeProjects(root = PACKAGE_ROOT, {
  platform = process.platform,
  dotnet = 'dotnet',
  exec = execFileSync,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') throw new Error('native realtime publishing requires Windows (win-x64)');
  const nativeBase = resolve(root, 'native');
  const outputRoot = resolve(nativeBase, 'win-x64');
  if (dirname(outputRoot) !== nativeBase || basename(outputRoot) !== 'win-x64' || !outputRoot.startsWith(resolve(root) + sep)) {
    throw new Error('refusing to clean an unexpected native output path: ' + outputRoot);
  }
  rmSync(outputRoot, { recursive: true, force: true });
  const outputs = [];
  for (const project of NATIVE_PROJECTS) {
    const output = join(outputRoot, project.name);
    const args = [
      'publish', join(root, project.project),
      '-c', 'Release',
      '-r', 'win-x64',
      '--self-contained', 'false',
      '-p:UseAppHost=true',
      '-p:DebugType=None',
      '-p:DebugSymbols=false',
      '-o', output,
      '--nologo',
    ];
    exec(dotnet, args, { cwd: root, shell: false, stdio: 'inherit', timeout: 600_000 });
    const executable = join(output, project.executable);
    if (!exists(executable)) throw new Error('dotnet publish did not produce ' + executable);
    outputs.push({ ...project, output, executable });
  }
  return outputs;
}

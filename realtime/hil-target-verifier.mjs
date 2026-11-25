import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { bundledHarnessPath } from '../tools/native-runtime.mjs';

const MAGIC = 'RT-SYNTH-HIL-9D27C4|';
const MAX_STDOUT = 64 * 1024;

function normalizeHwnd(value) {
  try {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value ?? '').trim();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return null;
    const parsed = BigInt(text);
    if (parsed <= 0n || parsed > 0x7fffffffffffffffn) return null;
    return parsed.toString(10);
  } catch { return null; }
}

function invalid(reason) { return { ok: false, reason }; }

/**
 * Independently verifies the one self-built HIL target through an inert Harness command.
 * The command only reads Win32 facts; it never activates a window or synthesizes input.
 */
export function createNativeHilTargetVerifier({
  harnessPath,
  packageRoot,
  exists = existsSync,
  exec = execFileSync,
} = {}) {
  const executable = harnessPath ?? bundledHarnessPath(packageRoot);
  return async function verifyHilTarget(target) {
    const hwnd = normalizeHwnd(target?.hwnd);
    const processId = target?.processId;
    const title = target?.title;
    if (target?.kind !== 'hil' || typeof target?.id !== 'string' || target.id.length === 0) {
      return invalid('active input requires an explicit self-built HIL target descriptor');
    }
    if (!hwnd || !Number.isSafeInteger(processId) || processId <= 0 ||
        typeof title !== 'string' || !title.startsWith(MAGIC) || title.length > 512 || title.includes('\0')) {
      return invalid('HIL target must contain a nonzero hwnd, positive processId, and exact RT-SYNTH-HIL title magic');
    }
    if (!exists(executable)) return invalid('native HIL verifier is unavailable; run npm run build:native');

    let outcome;
    try {
      const returned = exec(executable,
        ['verify-target', '--hwnd', hwnd, '--process-id', String(processId), '--title', title],
        { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: MAX_STDOUT });
      outcome = returned && typeof returned === 'object' && ('status' in returned || 'stdout' in returned)
        ? returned
        : { status: 0, stdout: returned, stderr: '' };
    } catch (error) {
      return invalid('native HIL verification failed: ' + (error?.message ?? error));
    }
    if (outcome.error) return invalid('native HIL verification failed: ' + outcome.error.message);
    const stdout = String(outcome.stdout ?? '');
    if (stdout.length > MAX_STDOUT) return invalid('native HIL verifier output exceeded its bound');
    let verdict;
    try { verdict = JSON.parse(stdout); } catch { return invalid('native HIL verifier returned malformed JSON'); }
    if (!verdict || typeof verdict !== 'object') return invalid('native HIL verifier returned no verdict');
    if (outcome.status !== 0 || verdict.ok !== true) {
      return invalid(String(verdict.reason ?? outcome.stderr ?? 'native HIL target was rejected'));
    }
    const facts = verdict.facts;
    if (!facts || normalizeHwnd(facts.hwnd) !== hwnd || facts.processId !== processId ||
        facts.processName !== 'Rt.SynthWindow' || facts.title !== title ||
        facts.isVisible !== true || facts.isMinimized !== false ||
        !Number.isFinite(facts.bounds?.width) || facts.bounds.width <= 0 ||
        !Number.isFinite(facts.bounds?.height) || facts.bounds.height <= 0) {
      return invalid('native HIL verifier facts do not match the authorized target');
    }
    return { ok: true, facts };
  };
}

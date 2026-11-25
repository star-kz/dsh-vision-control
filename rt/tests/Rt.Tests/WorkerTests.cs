using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Rt.Core.Tracing;

namespace Rt.Tests;

/// <summary>Task 4 RED: real Worker process, CLI failures, and the repository's actual Node client.</summary>
public static class WorkerTests
{
    private static readonly Lazy<string> WorkerDll = new(BuildWorker, LazyThreadSafetyMode.ExecutionAndPublication);

    [RtFact]
    public static void WorkerCli_ReplayVirtualInputGoldenAssert_DeterministicAndFailuresNonzero()
    {
        string dir = TempDir();
        try
        {
            string trace = Path.Combine(dir, "input.rtt");
            CreateTrace(trace);
            string first = Path.Combine(dir, "first.jsonl");
            string second = Path.Combine(dir, "second.jsonl");

            ProcessResult replay1 = RunWorker(new[] { "replay", "--trace", trace, "--virtual-input", "--golden", first });
            ProcessResult replay2 = RunWorker(new[] { "replay", "--trace", trace, "--virtual-input", "--golden", second });
            Assert.Equal(0, replay1.ExitCode, replay1.StdOut + replay1.StdErr);
            Assert.Equal(0, replay2.ExitCode, replay2.StdOut + replay2.StdErr);
            Assert.True(File.ReadAllBytes(first).AsSpan().SequenceEqual(File.ReadAllBytes(second)),
                "two separate Worker processes must produce identical golden bytes");

            ProcessResult assertion = RunWorker(new[] { "assert", "--actual", first, "--expected", second });
            Assert.Equal(0, assertion.ExitCode, assertion.StdOut + assertion.StdErr);
            byte[] corrupted = File.ReadAllBytes(second);
            corrupted[^2] ^= 1;
            File.WriteAllBytes(second, corrupted);
            ProcessResult mismatch = RunWorker(new[] { "assert", "--actual", first, "--expected", second });
            Assert.True(mismatch.ExitCode != 0, "golden mismatch must produce a nonzero CLI exit");

            ProcessResult realInputRefused = RunWorker(new[] { "replay", "--trace", trace, "--golden", first });
            Assert.True(realInputRefused.ExitCode != 0, "replay without --virtual-input must not silently use real input");
            string truncated = Path.Combine(dir, "truncated.rtt");
            File.WriteAllBytes(truncated, File.ReadAllBytes(trace).Take(11).ToArray());
            ProcessResult corrupt = RunWorker(new[] { "replay", "--trace", truncated, "--virtual-input", "--golden", first });
            Assert.True(corrupt.ExitCode != 0, "corrupt trace must produce a nonzero CLI exit");
        }
        finally { Directory.Delete(dir, true); }
    }

    [RtFact]
    public static async Task WorkerStdio_ActualNodeClient_ReplayStaleRunAndGracefulEof()
    {
        string dir = TempDir();
        try
        {
            string trace = Path.Combine(dir, "protocol.rtt");
            string golden = Path.Combine(dir, "protocol-golden.jsonl");
            CreateTrace(trace);
            string clientPath = Path.Combine(RepoRoot, "realtime", "worker-client.mjs");
            string scriptPath = Path.Combine(dir, "worker-protocol-test.mjs");
            string script = NodeScript
                .Replace("__CLIENT_URL__", JsonSerializer.Serialize(new Uri(clientPath).AbsoluteUri), StringComparison.Ordinal)
                .Replace("__WORKER_DLL__", JsonSerializer.Serialize(WorkerDll.Value), StringComparison.Ordinal)
                .Replace("__TRACE__", JsonSerializer.Serialize(trace), StringComparison.Ordinal)
                .Replace("__GOLDEN__", JsonSerializer.Serialize(golden), StringComparison.Ordinal);
            await File.WriteAllTextAsync(scriptPath, script, Encoding.UTF8);

            ProcessResult result = await RunProcessAsync("node", new[] { scriptPath }, 20_000);
            Assert.True(result.ExitCode == 0, $"actual Node client protocol failed ({result.ExitCode})\n{result.StdOut}\n{result.StdErr}");
            Assert.True(result.StdOut.Contains("NODE_PROTOCOL_OK", StringComparison.Ordinal), result.StdOut);
            Assert.True(File.Exists(golden), "stdio replay command must execute real virtual replay");
        }
        finally { Directory.Delete(dir, true); }
    }

    private static string BuildWorker()
    {
        string project = Path.Combine(RepoRoot, "rt", "src", "Rt.Worker", "Rt.Worker.csproj");
        if (!File.Exists(project)) throw new InvalidOperationException($"Worker project is missing (expected RED): {project}");
        ProcessResult build = RunProcessAsync("dotnet", new[] { "build", project, "--nologo", "-c", "Debug" }, 120_000).GetAwaiter().GetResult();
        if (build.ExitCode != 0) throw new InvalidOperationException($"Worker build failed ({build.ExitCode})\n{build.StdOut}\n{build.StdErr}");
        string dll = Path.Combine(RepoRoot, "rt", "src", "Rt.Worker", "bin", "Debug", "net8.0-windows10.0.19041.0", "Rt.Worker.dll");
        if (!File.Exists(dll)) throw new InvalidOperationException($"Worker assembly missing after build: {dll}");
        return dll;
    }

    private static ProcessResult RunWorker(IEnumerable<string> args) =>
        RunProcessAsync("dotnet", new[] { WorkerDll.Value }.Concat(args), 15_000).GetAwaiter().GetResult();

    private static async Task<ProcessResult> RunProcessAsync(string fileName, IEnumerable<string> args, int timeoutMs)
    {
        var start = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            CreateNoWindow = true,
        };
        foreach (string arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new InvalidOperationException($"failed to start {fileName}");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMilliseconds(timeoutMs)); }
        catch
        {
            try { process.Kill(true); } catch { /* best-effort test cleanup */ }
            throw;
        }
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    private static void CreateTrace(string path)
    {
        var payload = JsonDocument.Parse("{\"schemaVersion\":1,\"actionId\":\"worker-a\",\"sourceEpoch\":1,\"targetId\":\"dedicated-hil\",\"createdQpc\":0,\"expiresQpc\":10000,\"events\":[{\"control\":\"Space\",\"downQpc\":100,\"upQpc\":200,\"latestQpc\":150}],\"preconditions\":null}").RootElement.Clone();
        TraceFile.Write(path, new[] { new TraceEnvelope(TraceEnvelope.Plan, 0, 0, payload) });
    }

    private static string RepoRoot
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "realtime", "worker-client.mjs"))) return dir.FullName;
                dir = dir.Parent;
            }
            return Directory.GetCurrentDirectory();
        }
    }

    private static string TempDir()
    {
        string dir = Path.Combine(Path.GetTempPath(), "rt-worker-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private sealed record ProcessResult(int ExitCode, string StdOut, string StdErr);

    private const string NodeScript = """
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWorkerClient } from __CLIENT_URL__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const observed = [];
let childProcess;
let capture = '';
const client = createWorkerClient({
  command: 'dotnet', args: [__WORKER_DLL__, '--stdio'], helloTimeoutMs: 5000, requestTimeoutMs: 3000,
  spawnProcess(command, args, options) {
    const child = spawn(command, args, options);
    childProcess = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      capture += chunk;
      let at;
      while ((at = capture.indexOf('\n')) >= 0) {
        const line = capture.slice(0, at); capture = capture.slice(at + 1);
        try { const msg = JSON.parse(line); if (msg.rt === 'res') observed.push(msg.id); } catch {}
      }
    });
    return child;
  },
});
async function rejection(promise, code, dispatched) {
  try { await promise; assert.fail('expected rejection ' + code); }
  catch (err) {
    if (err && err.message && err.message.startsWith('expected rejection')) throw err;
    assert.equal(err.code, code);
    if (dispatched !== undefined) assert.equal(err.dispatched, dispatched);
  }
}
const watchdog = setTimeout(() => { client.dispose(); console.error('node protocol watchdog'); process.exit(2); }, 15000);
try {
  await client.start();
  const hello = client.info;
  assert.equal(hello.protocol, 1);
  for (const capability of ['targets', 'skill_validate', 'calibrate', 'run', 'status', 'stop', 'snapshot', 'replay', 'trace_read', 'heartbeat']) {
    assert.ok(hello.capabilities.includes(capability), capability);
  }
  await rejection(client.request('status', { runId: 'stale-run', sessionId: 's' }), 'STALE_RUN', true);
  const replay = await client.request('replay', { runId: 'run-next', tracePath: __TRACE__, mode: 'replay', sessionId: 's', goldenPath: __GOLDEN__ });
  assert.equal(replay.planCount, 1);
  assert.equal(replay.virtualEvents, 2);
  await rejection(client.request('status', { runId: 'run-next', sessionId: 's' }), 'STALE_RUN', true);
  const skill = JSON.stringify({
    categories: [{ name: 'noteHead', color: { b: 0, g: 255, r: 255, tolerance: 4 }, minArea: 4, minWidth: 1, minHeight: 1, expectedArea: 16, minFill: 0.1 }],
    regions: [{ id: 'lane0', roi: { x: 0, y: 0, width: 64, height: 64 }, arrivalLineY: 32, control: 'key.a' }],
    tracking: { maxSamples: 8, maxGapQpc: 100000, maxAssociationDistancePixels: 20, minVelocityPixelsPerSecond: 1, maxVelocityPixelsPerSecond: 10000 },
    policy: { targetId: 'missing-hil', minimumConfidence: 0.5, planningHorizonQpc: 1000000, lateToleranceQpc: 1000,
      tapDurationQpc: 1000, maximumHoldQpc: 10000, planExpiryAfterQpc: 100000, maxConcurrent: 2, outputOffsetQpc: 0 },
  });
  await rejection(client.request('run', { runId: 'active-run', mode: 'active', skill,
    target: { id: 'missing-hil', kind: 'hil', handle: 1, processId: 1, title: 'missing' }, sessionId: 's' }), 'TARGET_NOT_FOUND', true);
  const exited = new Promise(resolve => client.onExit(resolve));
  childProcess.stdin.end();
  const exitInfo = await exited;
  assert.equal(exitInfo.code, 0);
  await rejection(client.request('status', { runId: 'run-next', sessionId: 's' }), 'WORKER_EXITED', false);
  console.log('NODE_PROTOCOL_OK ' + JSON.stringify({ orphans: client.stats.orphans, exit: exitInfo.code }));
} finally {
  clearTimeout(watchdog);
  client.dispose();
}
""";
}
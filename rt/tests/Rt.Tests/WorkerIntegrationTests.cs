using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Rt.Tests;

public static class WorkerIntegrationTests
{
    [RtFact]
    public static async Task Stdio_AdvertisesNineCommandsAndHeartbeatWithoutClaimingRealInput()
    {
        using var client = await WorkerClient.Start();
        string[] capabilities = client.Hello.RootElement.GetProperty("capabilities")
            .EnumerateArray().Select(x => x.GetString()!).ToArray();
        WorkerAssert.Equal(
            ["calibrate", "heartbeat", "replay", "run", "skill_validate", "snapshot", "status", "stop", "targets", "trace_read"],
            capabilities.Order().ToArray());
        WorkerAssert.Equal("native-windows", client.Hello.RootElement.GetProperty("worker").GetProperty("runtime").GetString());
        WorkerAssert.Equal("shadow", client.Hello.RootElement.GetProperty("worker").GetProperty("defaultMode").GetString());
        JsonElement heartbeat = await client.Request("heartbeat", "heartbeat", new { sessionId = "integration" });
        WorkerAssert.True(heartbeat.GetProperty("ok").GetBoolean(), heartbeat.ToString());
        WorkerAssert.True(heartbeat.GetProperty("result").GetProperty("heartbeat").GetBoolean());
        WorkerAssert.Equal("integration", heartbeat.GetProperty("result").GetProperty("sessionId").GetString());
    }

    [RtFact]
    public static async Task Stdio_RejectsInvalidDescriptorAndGenericActiveBeforeNativeInput()
    {
        using var client = await WorkerClient.Start();
        JsonElement invalid = await client.Request("invalid-skill", "skill_validate", new { skill = "{}" });
        WorkerAssert.Equal("INVALID_SKILL", invalid.GetProperty("error").GetProperty("code").GetString());

        string descriptor = WorkerRuntimeTests.ValidDescriptor;
        object args = new
        {
            runId = "active-generic",
            sessionId = "integration",
            mode = "active",
            target = new { id = "target-1", kind = "monitor" },
            skill = descriptor,
            authorization = new { granted = true, targetId = "target-1", expiresQpc = long.MaxValue },
        };
        JsonElement rejected = await client.Request("active-generic", "run", args);
        WorkerAssert.Equal("ACTIVE_TARGET_NOT_HIL", rejected.GetProperty("error").GetProperty("code").GetString());

        JsonElement missingHil = await client.Request("active-hil-missing", "run", new
        {
            runId = "active-hil-missing",
            sessionId = "integration",
            mode = "active",
            target = new { id = "target-1", kind = "hil" },
            skill = descriptor,
            authorization = new { granted = true, targetId = "target-1", expiresQpc = long.MaxValue },
        });
        WorkerAssert.Equal("TARGET_NOT_FOUND", missingHil.GetProperty("error").GetProperty("code").GetString(),
            "a syntactically valid dedicated-HIL request reaches read-only target resolution");

        JsonElement stale = await client.Request("stale", "status", new { runId = "missing", sessionId = "integration" });
        WorkerAssert.Equal("STALE_RUN", stale.GetProperty("error").GetProperty("code").GetString());
    }

    [RtFact]
    public static async Task Stdio_RejectsOversizeControlLineWithoutPixelPayload()
    {
        using var client = await WorkerClient.Start();
        string padding = new('x', 256 * 1024);
        JsonElement response = await client.Request("large", "status", new { runId = "r", padding });
        WorkerAssert.Equal("BAD_REQUEST", response.GetProperty("error").GetProperty("code").GetString());
        WorkerAssert.True(response.GetProperty("error").GetProperty("message").GetString()!.Contains("262144", StringComparison.Ordinal));
    }

    private sealed class WorkerClient : IDisposable
    {
        private readonly Process _process;
        private int _nextId;
        private WorkerClient(Process process, JsonDocument hello)
        {
            _process = process;
            Hello = hello;
        }
        public JsonDocument Hello { get; }

        public static async Task<WorkerClient> Start()
        {
            string repository = RepositoryRoot();
            string assembly = Path.Combine(repository, "rt", "src", "Rt.Worker", "bin", "Debug", "net8.0-windows10.0.19041.0", "Rt.Worker.dll");
            WorkerAssert.True(File.Exists(assembly), $"Build Rt.Worker before integration tests: {assembly}");
            var start = new ProcessStartInfo("dotnet", $"\"{assembly}\" --stdio")
            {
                WorkingDirectory = repository,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            var process = Process.Start(start) ?? throw new InvalidOperationException("Worker process did not start.");
            try
            {
                string? helloLine = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                if (helloLine is null)
                    throw new InvalidOperationException("Worker closed before hello: " + await process.StandardError.ReadToEndAsync());
                var hello = JsonDocument.Parse(helloLine);
                await process.StandardInput.WriteLineAsync("{\"rt\":\"welcome\",\"protocol\":1}");
                await process.StandardInput.FlushAsync();
                return new WorkerClient(process, hello);
            }
            catch
            {
                TryKill(process);
                throw;
            }
        }

        public async Task<JsonElement> Request(string id, string command, object args)
        {
            string json = JsonSerializer.Serialize(new { rt = "req", id = $"{id}-{++_nextId}", cmd = command, args });
            await _process.StandardInput.WriteLineAsync(json);
            await _process.StandardInput.FlushAsync();
            while (true)
            {
                string line = await _process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(8)) ?? throw new InvalidOperationException("Worker closed before response");
                using var document = JsonDocument.Parse(line);
                if (document.RootElement.GetProperty("rt").GetString() == "event") continue;
                return document.RootElement.Clone();
            }
        }

        public void Dispose()
        {
            try
            {
                if (!_process.HasExited)
                {
                    _process.StandardInput.WriteLine("{\"rt\":\"req\",\"id\":\"exit\",\"cmd\":\"exit\",\"args\":{}}");
                    _process.StandardInput.Flush();
                    _process.StandardInput.Close();
                    if (!_process.WaitForExit(2000)) TryKill(_process);
                }
            }
            catch { TryKill(_process); }
            _process.Dispose();
        }

        private static string RepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "rt", "Rt.sln"))) directory = directory.Parent;
            return directory?.FullName ?? throw new InvalidOperationException("Cannot locate rt/Rt.sln.");
        }

        private static void TryKill(Process process)
        {
            try { if (!process.HasExited) process.Kill(true); } catch { }
        }
    }
}

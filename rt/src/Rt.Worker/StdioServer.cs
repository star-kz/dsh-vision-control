using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Rt.Adapters.Rhythm;
using Rt.Core.Clocks;
using Rt.Core.Perception;
using Rt.Core.Runtime;
using Rt.Core.Tracing;
using Rt.Windows;

namespace Rt.Worker;

/// <summary>Concurrent JSON-lines control plane. Native runs have independent clocks and lifetimes.</summary>
public sealed class StdioServer : IAsyncDisposable
{
    public const int MaximumControlBytes = 256 * 1024;
    private static readonly string[] Commands =
        ["targets", "skill_validate", "calibrate", "run", "status", "stop", "snapshot", "replay", "trace_read"];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim _write = new(1, 1);
    private readonly ConcurrentDictionary<string, Task> _requests = new();
    private readonly CancellationTokenSource _heartbeatCancel = new();
    private readonly WorkerTargetCatalog _targets = new();
    private readonly ConcurrentDictionary<(string Session, string Run), NativeRunSpec> _specs = new();
    private readonly TextReader _input;
    private readonly TextWriter _output;
    private readonly RunCoordinator _runs;
    private readonly string _artifactRoot;
    private readonly Task _heartbeatLoop;

    public StdioServer(TextReader? input = null, TextWriter? output = null)
    {
        _input = input ?? Console.In;
        _output = output ?? Console.Out;
        _artifactRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("RT_WORKER_ARTIFACT_ROOT")
            ?? Path.Combine(Path.GetTempPath(), "Rt.Worker"));
        Directory.CreateDirectory(_artifactRoot);
        _runs = new RunCoordinator(CreateNativeRunAsync);
        _heartbeatLoop = Task.Run(HeartbeatLoopAsync);
    }

    public async Task RunAsync()
    {
        await WriteAsync(new
        {
            rt = "hello", protocol = 1,
            worker = new { name = "rt-worker", version = "2", runtime = "native-windows", defaultMode = "shadow" },
            capabilities = Commands.Concat(["heartbeat"]).ToArray(), commands = Commands,
        }).ConfigureAwait(false);
        try
        {
            while (true)
            {
                string? line = await _input.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break;
                if (line.Length == 0) continue;
                Task task = ProcessLineAsync(line);
                string key = Guid.NewGuid().ToString("N");
                _requests[key] = task;
                _ = task.ContinueWith(completed => _requests.TryRemove(key, out _), TaskScheduler.Default);
            }
        }
        finally
        {
            _heartbeatCancel.Cancel();
            Task[] pending = _requests.Values.ToArray();
            if (pending.Length > 0)
            {
                try { await Task.WhenAll(pending).ConfigureAwait(false); }
                catch { /* Every request has already emitted its own failure where possible. */ }
            }
            await _runs.DisposeAsync().ConfigureAwait(false);
        }
    }

    private async Task ProcessLineAsync(string line)
    {
        string id = "";
        try
        {
            if (Encoding.UTF8.GetByteCount(line) >= MaximumControlBytes)
            {
                id = ExtractOversizedRequestId(line);
                throw new WorkerException("BAD_REQUEST", "control line must be smaller than 262144 bytes");
            }
            using JsonDocument document = JsonDocument.Parse(line, new JsonDocumentOptions { AllowTrailingCommas = false });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new WorkerException("BAD_REQUEST", "request must be an object");
            id = OptionalString(root, "id") ?? "";
            if (id.Length == 0) throw new WorkerException("BAD_REQUEST", "request id must be a nonempty string");
            if (OptionalString(root, "rt") == "welcome")
            {
                await WriteAsync(new { rt = "res", id, ok = true, result = new { protocol = 1 } }).ConfigureAwait(false);
                return;
            }
            if (OptionalString(root, "rt") != "req") throw new WorkerException("BAD_REQUEST", "expected rt='req'");
            string cmd = OptionalString(root, "cmd") ?? "";
            if (cmd.Length == 0) throw new WorkerException("BAD_REQUEST", "request cmd must be a nonempty string");
            JsonElement args = root.TryGetProperty("args", out JsonElement value) ? value : default;
            if (args.ValueKind == JsonValueKind.Undefined || args.ValueKind == JsonValueKind.Null)
                args = JsonSerializer.SerializeToElement(new { });
            if (args.ValueKind != JsonValueKind.Object) throw new WorkerException("BAD_REQUEST", "args must be an object");
            string sessionId = OptionalString(args, "sessionId") ?? "default";
            _runs.Heartbeat(sessionId);
            object result = await DispatchAsync(cmd, args, sessionId).ConfigureAwait(false);
            await WriteAsync(new { rt = "res", id, ok = true, result }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            string code = ex switch
            {
                WorkerException worker => worker.Code,
                RunNotFoundException => "STALE_RUN",
                KeyNotFoundException => "TARGET_NOT_FOUND",
                DuplicateRunException => "RUN_BUSY",
                ActiveTargetBusyException => "TARGET_BUSY",
                UnauthorizedAccessException => "NOT_AUTHORIZED",
                JsonException => "BAD_REQUEST",
                _ when ex.Message == "ACTIVE_TARGET_NOT_HIL" => "ACTIVE_TARGET_NOT_HIL",
                _ => "BAD_REQUEST",
            };
            if (id.Length == 0) return;
            await WriteAsync(new { rt = "res", id, ok = false, error = new { code, message = ex.Message } }).ConfigureAwait(false);
        }
    }

    private async Task<object> DispatchAsync(string cmd, JsonElement args, string sessionId)
    {
        switch (cmd)
        {
            case "heartbeat":
                _runs.Heartbeat(sessionId);
                return new { heartbeat = true, sessionId, timestampQpc = Qpc.Now };
            case "targets":
                return new { targets = _targets.Enumerate(), synthetic = false };
            case "skill_validate":
            {
                string skill = RequiredString(args, "skill");
                string? expectedTarget = OptionalTargetId(args);
                try
                {
                    SceneDescriptor descriptor = SceneDescriptorJson.Parse(skill, expectedTarget);
                    return new { ok = true, valid = true, targetId = descriptor.Policy.TargetId, descriptor };
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidDataException or JsonException)
                {
                    throw new WorkerException("INVALID_SKILL", ex.Message);
                }
            }
            case "calibrate":
                return await CalibrateAsync(args, sessionId).ConfigureAwait(false);
            case "run":
                return await StartRunAsync(args, sessionId).ConfigureAwait(false);
            case "status":
            {
                string runId = RequiredString(args, "runId");
                return _runs.Get(sessionId, runId).Status();
            }
            case "stop":
            {
                string runId = RequiredString(args, "runId");
                IRunHost? host = null;
                try { host = _runs.Get(sessionId, runId); } catch (RunNotFoundException) { /* idempotent stop */ }
                host?.Freeze(); // synchronous priority before any other stop awaits
                try { await _runs.StopAsync(sessionId, runId).ConfigureAwait(false); }
                catch when (host is not null)
                {
                    // A failed stop remains registered. Return its actual stopped-unknown /
                    // released=false evidence instead of forgetting it or claiming idempotent success.
                    return host.Status();
                }
                return host is null
                    ? new { sessionId, runId, state = "stopped", stopped = true, idempotent = true, released = false, releaseConfirmed = false }
                    : host.Status();
            }
            case "snapshot":
            {
                string runId = RequiredString(args, "runId");
                IRunHost host = _runs.Get(sessionId, runId);
                if (host is not NativeRunHost native) throw new WorkerException("SNAPSHOT_UNAVAILABLE", "run has no native capture");
                string path = ArtifactPath("snapshots", runId, ".png");
                return await native.SnapshotAsync(path, CancellationToken.None).ConfigureAwait(false);
            }
            case "replay":
            {
                string mode = OptionalString(args, "mode") ?? "replay";
                if (mode != "replay") throw new WorkerException("BAD_REQUEST", "replay command requires mode='replay'");
                string tracePath = RequiredString(args, "tracePath");
                string? goldenPath = OptionalString(args, "goldenPath") ?? OptionalString(args, "outputPath");
                try { return WorkerReplay.Execute(tracePath, goldenPath); }
                catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or ArgumentException)
                { throw new WorkerException("REPLAY_FAILED", ex.Message); }
            }
            case "trace_read":
            {
                string path = RequiredString(args, "tracePath");
                long offset = OptionalInt64(args, "offset") ?? 0;
                int limit = checked((int)(OptionalInt64(args, "limit") ?? 64));
                int maxBytes = checked((int)(OptionalInt64(args, "maxBytes") ?? 64 * 1024));
                string fullPath = Path.GetFullPath(path);
                string artifactPrefix = _artifactRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!fullPath.StartsWith(artifactPrefix, StringComparison.OrdinalIgnoreCase))
                    throw new UnauthorizedAccessException("trace path is outside the Worker artifact allowlist");
                string allowedRoot = Path.GetDirectoryName(fullPath) ?? throw new UnauthorizedAccessException("trace has no allowlisted parent");
                if (OptionalString(args, "allowedRoot") is string requested &&
                    !string.Equals(Path.GetFullPath(requested), allowedRoot, StringComparison.OrdinalIgnoreCase))
                    throw new UnauthorizedAccessException("caller cannot widen or replace the trace allowlist directory");
                TraceReadPage page = TraceStreamReader.ReadPage(fullPath, allowedRoot, offset, limit, maxBytes);
                return new { records = page.Records, nextOffset = page.NextOffset, done = page.Done, offset, limit, maxBytes };
            }
            default:
                throw new WorkerException("UNKNOWN_COMMAND", $"unknown Worker command '{cmd}'");
        }
    }

    private async Task<object> StartRunAsync(JsonElement args, string sessionId)
    {
        string runId = RequiredString(args, "runId");
        string skillJson = RequiredString(args, "skill");
        SceneDescriptor unbound;
        try { unbound = SceneDescriptorJson.Parse(skillJson, null); }
        catch (Exception ex) when (ex is ArgumentException or InvalidDataException or JsonException)
        { throw new WorkerException("INVALID_SKILL", ex.Message); }
        if (!args.TryGetProperty("target", out JsonElement targetJson)) throw new WorkerException("BAD_REQUEST", "target is required");
        WorkerTarget requested = WorkerTarget.Parse(targetJson);
        SceneDescriptor descriptor;
        try { descriptor = SceneDescriptorJson.Parse(skillJson, requested.Id); }
        catch (Exception ex) when (ex is ArgumentException or InvalidDataException or JsonException)
        { throw new WorkerException("INVALID_SKILL", ex.Message); }
        string modeText = OptionalString(args, "mode") ?? "shadow";
        WorkerRunMode mode = modeText switch
        {
            "shadow" => WorkerRunMode.Shadow,
            "active" => WorkerRunMode.Active,
            _ => throw new WorkerException("BAD_REQUEST", "run mode must be shadow or active"),
        };
        if (mode == WorkerRunMode.Active && requested.Kind != "hil")
            throw new ArgumentException("ACTIVE_TARGET_NOT_HIL");
        WorkerTarget target = _targets.Resolve(requested);
        AuthorizationLease? authorization = null;
        Rt.Windows.Input.DedicatedSynthTarget? dedicated = null;
        var leaseClock = new QpcClock();
        try
        {
            if (mode == WorkerRunMode.Active)
            {
                if (!args.TryGetProperty("authorization", out JsonElement authorizationJson))
                    throw new UnauthorizedAccessException("active run requires authorization");
                authorization = AuthorizationLease.Parse(authorizationJson, leaseClock);
                authorization.Validate(target.Id, leaseClock.Now);
                dedicated = _targets.VerifyDedicatedHil(target);
            }
        }
        finally { leaseClock.Dispose(); }
        long? deadlineQpc = null;
        if (OptionalInt64(args, "deadlineQpc") is long absolute)
            deadlineQpc = absolute;
        else if (OptionalInt64(args, "deadlineMs") is long duration)
        {
            if (duration <= 0 || duration > 86_400_000) throw new WorkerException("BAD_REQUEST", "deadlineMs must be in [1,86400000]");
            deadlineQpc = Qpc.Now + (long)(duration * (Qpc.Frequency / 1000.0));
        }
        string tracePath = ArtifactPath("traces", runId, ".rttr");
        var request = new RunStartRequest(sessionId, runId, mode, target.Id);
        var spec = new NativeRunSpec(target, descriptor, skillJson, authorization, dedicated, tracePath, deadlineQpc);
        _specs[(sessionId, runId)] = spec;
        try
        {
            IRunHost host = await _runs.StartAsync(request, CancellationToken.None).ConfigureAwait(false);
            return host.Status();
        }
        finally { _specs.TryRemove((sessionId, runId), out _); }
    }

    private async Task<IRunHost> CreateNativeRunAsync(RunStartRequest request, CancellationToken cancellationToken)
    {
        if (!_specs.TryGetValue((request.SessionId, request.RunId), out NativeRunSpec? spec))
            throw new InvalidOperationException("native run specification is missing");
        return await NativeRunHost.StartAsync(request, spec.Target, spec.Descriptor, spec.SkillJson, spec.Authorization,
            spec.Dedicated, spec.TracePath, (identity, payload) => EmitRunEvent(request.RunId, identity, payload),
            StopFromNativeAsync, spec.DeadlineQpc, cancellationToken).ConfigureAwait(false);
    }

    private async Task<object> CalibrateAsync(JsonElement args, string sessionId)
    {
        string skillJson = RequiredString(args, "skill");
        try { SceneDescriptorJson.Parse(skillJson, null); }
        catch (Exception ex) when (ex is ArgumentException or InvalidDataException or JsonException)
        { throw new WorkerException("INVALID_SKILL", ex.Message); }
        if (!args.TryGetProperty("target", out JsonElement targetJson)) throw new WorkerException("BAD_REQUEST", "target is required");
        WorkerTarget requested = WorkerTarget.Parse(targetJson);
        SceneDescriptor descriptor;
        try { descriptor = SceneDescriptorJson.Parse(skillJson, requested.Id); }
        catch (Exception ex) when (ex is ArgumentException or InvalidDataException or JsonException)
        { throw new WorkerException("INVALID_SKILL", ex.Message); }
        WorkerTarget target = _targets.Resolve(requested);
        string calibrationId = "calibrate-" + Guid.NewGuid().ToString("N");
        string tracePath = ArtifactPath("calibrations", calibrationId, ".rttr");
        NativeRunHost host = await NativeRunHost.StartAsync(
            new RunStartRequest(sessionId, calibrationId, WorkerRunMode.Shadow, target.Id), target, descriptor,
            skillJson, null, null, tracePath, static (_, _) => { }, static (_, _) => Task.CompletedTask,
            null, CancellationToken.None).ConfigureAwait(false);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (host.ProcessedFrames == 0)
                await Task.Delay(20, timeout.Token).ConfigureAwait(false);
            return new
            {
                ok = true, calibrated = true, target, descriptorBound = descriptor.Policy.TargetId == target.Id,
                backend = host.Backend, backendDetail = host.BackendDetail,
                observedFrames = host.ProcessedFrames, plannedActions = host.PlannedActions, policyRejections = host.PolicyRejections,
                lastFrame = host.LastFrame, recognitionAccuracy = (double?)null,
                evidence = "Real capture and descriptor processing only; no recognition-accuracy claim.",
                tracePath,
            };
        }
        catch (OperationCanceledException)
        {
            throw new WorkerException("CALIBRATION_NO_FRAME", "no real capture frame arrived within the bounded calibration interval");
        }
        finally { await host.StopAsync().ConfigureAwait(false); }
    }

    private void EmitRunEvent(string runId, RunEvent identity, object payload) =>
        WriteAsync(new
        {
            rt = "event", @event = identity.Kind, runId,
            eventSeq = identity.EventSeq, sourceEpoch = identity.SourceEpoch, payload,
        }).GetAwaiter().GetResult();

    private async Task StopFromNativeAsync(string sessionId, string runId) => await _runs.StopAsync(sessionId, runId).ConfigureAwait(false);

    private async Task HeartbeatLoopAsync()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            while (await timer.WaitForNextTickAsync(_heartbeatCancel.Token).ConfigureAwait(false))
                await WriteAsync(new { rt = "event", @event = "heartbeat", timestampQpc = Qpc.Now }).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
    }

    private async Task WriteAsync(object message)
    {
        string line = JsonSerializer.Serialize(message, Json);
        if (Encoding.UTF8.GetByteCount(line) >= MaximumControlBytes)
            throw new WorkerException("RESPONSE_TOO_LARGE", "serialized control message must be smaller than 262144 bytes");
        await _write.WaitAsync().ConfigureAwait(false);
        try { await _output.WriteLineAsync(line).ConfigureAwait(false); await _output.FlushAsync().ConfigureAwait(false); }
        finally { _write.Release(); }
    }

    private string ArtifactPath(string category, string identity, string extension)
    {
        string safe = new(identity.Select(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());
        if (safe.Length > 80) safe = safe[..80];
        string directory = Path.Combine(_artifactRoot, category);
        Directory.CreateDirectory(directory);
        return Path.Combine(directory, safe + "-" + Guid.NewGuid().ToString("N") + extension);
    }

    private string ResolveAllowedRoot(string requested)
    {
        string root = Path.GetFullPath(requested);
        string allowed = _artifactRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!root.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) && !string.Equals(root, _artifactRoot, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("trace allowlist root must be inside the Worker artifact root");
        return root;
    }

    private static string ExtractOversizedRequestId(string line)
    {
        ReadOnlySpan<char> prefix = line.AsSpan(0, Math.Min(line.Length, 4096));
        int key = prefix.IndexOf("\"id\"", StringComparison.Ordinal);
        if (key < 0) return string.Empty;
        int cursor = key + 4;
        while (cursor < prefix.Length && char.IsWhiteSpace(prefix[cursor])) cursor++;
        if (cursor >= prefix.Length || prefix[cursor++] != ':') return string.Empty;
        while (cursor < prefix.Length && char.IsWhiteSpace(prefix[cursor])) cursor++;
        if (cursor >= prefix.Length || prefix[cursor] != '\"') return string.Empty;
        int start = cursor++;
        bool escaped = false;
        for (; cursor < prefix.Length; cursor++)
        {
            char current = prefix[cursor];
            if (escaped) { escaped = false; continue; }
            if (current == '\\') { escaped = true; continue; }
            if (current != '\"') continue;
            try
            {
                if (JsonSerializer.Deserialize<string>(prefix[start..(cursor + 1)]) is { Length: > 0 and <= 256 } id)
                    return id;
            }
            catch (JsonException) { }
            break;
        }
        return string.Empty;
    }

    private static string? OptionalTargetId(JsonElement args)
    {
        if (OptionalString(args, "targetId") is string id) return id;
        return args.TryGetProperty("target", out JsonElement target) && target.ValueKind == JsonValueKind.Object
            ? WorkerTarget.Parse(target).Id : null;
    }

    private static string RequiredString(JsonElement json, string name) =>
        OptionalString(json, name) ?? throw new WorkerException("BAD_REQUEST", $"missing string argument '{name}'");

    private static string? OptionalString(JsonElement json, string name)
    {
        if (!json.TryGetProperty(name, out JsonElement value)) return null;
        if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
            throw new WorkerException("BAD_REQUEST", $"argument '{name}' must be a nonempty string");
        return value.GetString();
    }

    private static long? OptionalInt64(JsonElement json, string name)
    {
        if (!json.TryGetProperty(name, out JsonElement value)) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out long result))
            throw new WorkerException("BAD_REQUEST", $"argument '{name}' must be an integer");
        return result;
    }

    public async ValueTask DisposeAsync()
    {
        _heartbeatCancel.Cancel();
        await _runs.DisposeAsync().ConfigureAwait(false);
        try { await _heartbeatLoop.ConfigureAwait(false); } catch (OperationCanceledException) { }
        _heartbeatCancel.Dispose();
        _write.Dispose();
    }

    private sealed record NativeRunSpec(WorkerTarget Target, SceneDescriptor Descriptor, string SkillJson,
        AuthorizationLease? Authorization, Rt.Windows.Input.DedicatedSynthTarget? Dedicated,
        string TracePath, long? DeadlineQpc);
}

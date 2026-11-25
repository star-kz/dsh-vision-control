using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Runtime;
using Rt.Core.Safety;
using Rt.Core.Tracing;
using Rt.Worker;
using QpcClock = Rt.Windows.QpcClock;

namespace Rt.Tests;

public static class WorkerRuntimeTests
{
    public const string ValidDescriptor = """
    {
      "categories": [{
        "name": "noteHead",
        "color": { "b": 0, "g": 255, "r": 255, "tolerance": 4 },
        "minArea": 4, "minWidth": 1, "minHeight": 1,
        "expectedArea": 16, "minFill": 0.1
      }],
      "regions": [{ "id": "lane0", "roi": { "x": 0, "y": 0, "width": 64, "height": 64 }, "arrivalLineY": 32, "control": "key.a" }],
      "tracking": {
        "maxSamples": 8, "maxGapQpc": 100000,
        "maxAssociationDistancePixels": 20,
        "minVelocityPixelsPerSecond": 1,
        "maxVelocityPixelsPerSecond": 10000
      },
      "policy": {
        "targetId": "target-1", "minimumConfidence": 0.5,
        "planningHorizonQpc": 1000000, "lateToleranceQpc": 1000,
        "tapDurationQpc": 1000, "maximumHoldQpc": 10000,
        "planExpiryAfterQpc": 100000, "maxConcurrent": 2,
        "outputOffsetQpc": 0
      }
    }
    """;

    [RtFact]
    public static async Task Coordinator_ParallelShadowAndActiveShadowButActiveTargetIsExclusive()
    {
        await using var coordinator = new RunCoordinator((request, _) =>
            Task.FromResult<IRunHost>(new FakeRunHost(request)));
        await coordinator.StartAsync(Request("s1", "shadow-1", WorkerRunMode.Shadow, "target-1"));
        await coordinator.StartAsync(Request("s1", "shadow-2", WorkerRunMode.Shadow, "target-1"));
        await coordinator.StartAsync(Request("s2", "active-1", WorkerRunMode.Active, "target-1"));
        WorkerAssert.Equal(3, coordinator.Count, "shadow runs and active observation may coexist");
        var busy = await ThrowsAsync<ActiveTargetBusyException>(() =>
            coordinator.StartAsync(Request("s3", "active-2", WorkerRunMode.Active, "target-1")));
        WorkerAssert.Equal("target-1", busy.TargetId);
        await coordinator.StartAsync(Request("s3", "active-3", WorkerRunMode.Active, "target-2"));
        await coordinator.StartAsync(Request("other-session", "shadow-1", WorkerRunMode.Shadow, "target-1"));
        WorkerAssert.Equal(5, coordinator.Count, "run identity is sessionId + runId");
        await ThrowsAsync<DuplicateRunException>(() =>
            coordinator.StartAsync(Request("s1", "shadow-1", WorkerRunMode.Shadow, "target-1")));
    }

    [RtFact]
    public static async Task Coordinator_StopDuringStartFreezesFirstAndIsIdempotent()
    {
        var factoryEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFactory = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        FakeRunHost? host = null;
        await using var coordinator = new RunCoordinator(async (request, _) =>
        {
            factoryEntered.SetResult();
            await releaseFactory.Task;
            return host = new FakeRunHost(request, 20);
        });
        Task<IRunHost> starting = coordinator.StartAsync(Request("s", "r", WorkerRunMode.Active, "target-1"));
        await factoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Task stopping = coordinator.StopAsync("s", "r");
        WorkerAssert.True(!stopping.IsCompleted, "stop must account for an in-flight start");
        releaseFactory.SetResult();
        await starting;
        await Task.WhenAll(stopping, coordinator.StopAsync("s", "r"));
        WorkerAssert.Equal(1, host!.StopCalls, "concurrent and repeated stop share one shutdown");
        WorkerAssert.Equal("freeze,stop", string.Join(',', host.Lifecycle), "freeze precedes every blocking shutdown step");
        WorkerAssert.Equal(0, coordinator.Count);
    }

    [RtFact]
    public static void EventSequence_AllowsEqualEpochButRejectsStaleEventAndEpoch()
    {
        var sequencer = new RunEventSequencer(initialEpoch: 7);
        RunEvent first = sequencer.Emit("status", 7);
        RunEvent second = sequencer.Emit("heartbeat", 7);
        WorkerAssert.Equal(1L, first.EventSeq);
        WorkerAssert.Equal(2L, second.EventSeq);
        WorkerAssert.Equal(7L, second.SourceEpoch);
        sequencer.AdvanceEpoch(8, "invalidated");
        RunEvent third = sequencer.Emit("status", 8);
        WorkerAssert.Equal(3L, third.EventSeq);
        WorkerAssert.Equal(8L, third.SourceEpoch);
        WorkerAssert.Throws<StaleSourceEpochException>(() => sequencer.Emit("late-frame", 7));
        WorkerAssert.Throws<StaleSourceEpochException>(() => sequencer.AdvanceEpoch(8, "duplicate generation"));
    }

    [RtFact]
    public static async Task EventSequence_SerializesIdentityAndTransportOrder()
    {
        var sequencer = new RunEventSequencer(initialEpoch: 7);
        var observed = new System.Collections.Concurrent.ConcurrentQueue<long>();
        await Task.WhenAll(Enumerable.Range(0, 24).Select(index => Task.Run(() =>
            sequencer.Emit("receipt", 7, identity =>
            {
                if (index == 0) Thread.Sleep(20);
                observed.Enqueue(identity.EventSeq);
            }))));
        WorkerAssert.Equal(Enumerable.Range(1, 24).Select(x => (long)x).ToArray(), observed.ToArray(),
            "event identity and its transport callback must be one ordered critical section");
        WorkerAssert.Equal(24L, sequencer.EventSeq);
    }

    [RtFact]
    public static async Task Coordinator_NullFactoryResultFailsAndReleasesAdmission()
    {
        var coordinator = new RunCoordinator((_, _) => Task.FromResult<IRunHost>(null!));
        var request = Request("s", "null-host", WorkerRunMode.Shadow);
        await ThrowsAsync<InvalidOperationException>(() => coordinator.StartAsync(request));
        WorkerAssert.Equal(0, coordinator.Count, "null host must not remain as an eternally starting run");
        await coordinator.StopAsync("s", "null-host");
        await coordinator.DisposeAsync();
    }

    [RtFact]
    public static async Task Coordinator_FailedStopRetainsUnknownRunAndTargetExclusion()
    {
        var host = new FakeRunHost(new RunStartRequest("s", "bad", WorkerRunMode.Active, "target-1"), stopFailure: true);
        var coordinator = new RunCoordinator((_, _) => Task.FromResult<IRunHost>(host));
        await coordinator.StartAsync(new RunStartRequest("s", "bad", WorkerRunMode.Active, "target-1"));
        await ThrowsAsync<InvalidOperationException>(() => coordinator.StopAsync("s", "bad"));
        WorkerAssert.Equal(1, coordinator.Count);
        WorkerAssert.True(ReferenceEquals(host, coordinator.Get("s", "bad")), "failed stop remains queryable");
        await ThrowsAsync<ActiveTargetBusyException>(() => coordinator.StartAsync(
            new RunStartRequest("other", "other", WorkerRunMode.Active, "target-1")));
        await ThrowsAsync<InvalidOperationException>(() => coordinator.StopAsync("s", "bad"));
        try { await coordinator.DisposeAsync(); } catch (AggregateException) { }
    }

    [RtFact]
    public static async Task Coordinator_DisposeAttemptsEveryRunBeforeAggregatingFailures()
    {
        var hosts = new List<FakeRunHost>();
        var coordinator = new RunCoordinator((request, _) =>
        {
            var host = new FakeRunHost(request, stopFailure: request.RunId == "bad");
            hosts.Add(host);
            return Task.FromResult<IRunHost>(host);
        });
        await coordinator.StartAsync(new RunStartRequest("s", "bad", WorkerRunMode.Shadow, "target-1"));
        await coordinator.StartAsync(new RunStartRequest("s", "good", WorkerRunMode.Shadow, "target-2"));
        await ThrowsAsync<AggregateException>(() => coordinator.DisposeAsync().AsTask());
        WorkerAssert.Equal(2, hosts.Count);
        WorkerAssert.True(hosts.All(x => x.StopCalls == 1), "the first failure must not starve later stops");
        WorkerAssert.Equal(1, coordinator.Count);
    }

    [RtFact]
    public static void NativeReleaseEvidence_RequiresCleanQuiescentStop()
    {
        WorkerAssert.True(NativeRunHost.ComputeWorkerReleased(true, 0, 0, 0));
        WorkerAssert.True(!NativeRunHost.ComputeWorkerReleased(false, 0, 0, 0));
        WorkerAssert.True(!NativeRunHost.ComputeWorkerReleased(true, 1, 0, 0));
        WorkerAssert.True(!NativeRunHost.ComputeWorkerReleased(true, 0, 1, 0));
        WorkerAssert.True(!NativeRunHost.ComputeWorkerReleased(true, 0, 0, 1));
    }

    [RtFact]
    public static async Task NativeDeadline_StopsWithoutCallerAbort()
    {
        var clock = new QpcClock();
        using var deadline = NativeDeadline.Start(clock, TimeSpan.FromMilliseconds(25));
        await deadline.Completion.WaitAsync(TimeSpan.FromSeconds(2));
        WorkerAssert.True(deadline.IsExpired, "native QPC deadline must fire independently of Node AbortSignal");
        deadline.Cancel();
        WorkerAssert.True(deadline.IsExpired, "late cancellation cannot rewrite deadline outcome");
    }

    [RtFact]
    public static void DescriptorJson_IsStrictAndBindsPolicyTarget()
    {
        var descriptor = SceneDescriptorJson.Parse(ValidDescriptor, "target-1");
        WorkerAssert.Equal("target-1", descriptor.Policy.TargetId);
        WorkerAssert.Equal("noteHead", descriptor.Categories.Single().Name);
        WorkerAssert.Throws<InvalidDataException>(() => SceneDescriptorJson.Parse(ValidDescriptor, "other-target"));
        WorkerAssert.Throws<InvalidDataException>(() => SceneDescriptorJson.Parse("{\"categories\":[],\"regions\":[]}", null));
        string unknown = ValidDescriptor.Replace("\"categories\"", "\"unexpected\":true,\"categories\"", StringComparison.Ordinal);
        WorkerAssert.Throws<InvalidDataException>(() => SceneDescriptorJson.Parse(unknown, "target-1"));
        string duplicate = ValidDescriptor.Replace("\"regions\"", "\"policy\":null,\"regions\"", StringComparison.Ordinal);
        WorkerAssert.Throws<InvalidDataException>(() => SceneDescriptorJson.Parse(duplicate, "target-1"));
    }

    [RtFact]
    public static async Task PngSnapshot_ConvertsBgraAndReplacesAtomically()
    {
        string root = TempDirectory();
        string path = Path.Combine(root, "frame.png");
        await File.WriteAllTextAsync(path, "old");
        byte[] bgra = [255, 0, 0, 255, 0, 0, 255, 255];
        await PngSnapshotWriter.WriteAtomicAsync(path, 2, 1, 8, bgra);
        byte[] png = await File.ReadAllBytesAsync(path);
        WorkerAssert.Equal([137, 80, 78, 71, 13, 10, 26, 10], png.Take(8).ToArray());
        WorkerAssert.Equal("IHDR", Encoding.ASCII.GetString(png, 12, 4));
        int idatLength = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(33, 4));
        WorkerAssert.Equal("IDAT", Encoding.ASCII.GetString(png, 37, 4));
        using var inflated = new ZLibStream(new MemoryStream(png, 41, idatLength), CompressionMode.Decompress);
        using var raw = new MemoryStream();
        await inflated.CopyToAsync(raw);
        WorkerAssert.Equal([0, 0, 0, 255, 255, 255, 0, 0, 255], raw.ToArray());
        WorkerAssert.Equal(0, Directory.GetFiles(root, "*.tmp").Length, "no temporary artifact remains");
        WorkerAssert.True(!File.ReadAllText(path).StartsWith("old", StringComparison.Ordinal));
        await ThrowsAsync<InvalidDataException>(() => PngSnapshotWriter.WriteAtomicAsync(path, -1, 1, 4, bgra));
    }

    [RtFact]
    public static void TraceRead_IsPagedBoundedChecksCrcAndAllowlist()
    {
        string root = TempDirectory();
        string path = Path.Combine(root, "run.rttr");
        TraceFile.Write(path, Enumerable.Range(1, 5).Select(i => new TraceEnvelope(
            "Frame", i, i * 10, JsonDocument.Parse($"{{\"n\":{i}}}").RootElement)));
        TraceReadPage first = TraceStreamReader.ReadPage(path, root, offset: 0, limit: 2, maxBytes: 4096);
        TraceReadPage second = TraceStreamReader.ReadPage(path, root, first.NextOffset, limit: 2, maxBytes: 4096);
        TraceReadPage third = TraceStreamReader.ReadPage(path, root, second.NextOffset, limit: 2, maxBytes: 4096);
        WorkerAssert.Equal([1L, 2L], first.Records.Select(x => x.Sequence).ToArray());
        WorkerAssert.Equal([3L, 4L], second.Records.Select(x => x.Sequence).ToArray());
        WorkerAssert.Equal([5L], third.Records.Select(x => x.Sequence).ToArray());
        WorkerAssert.True(first.NextOffset > 0 && third.NextOffset == new FileInfo(path).Length);
        WorkerAssert.Throws<ArgumentOutOfRangeException>(() => TraceStreamReader.ReadPage(path, root, 0, 1000, 4096));
        WorkerAssert.Throws<UnauthorizedAccessException>(() => TraceStreamReader.ReadPage(path, Path.GetDirectoryName(root)!, 0, 2, 4096));
        byte[] corrupt = File.ReadAllBytes(path);
        corrupt[^1] ^= 0x5a;
        File.WriteAllBytes(path, corrupt);
        WorkerAssert.Throws<InvalidDataException>(() => TraceStreamReader.ReadPage(path, root, second.NextOffset, 1, 4096));
    }

    [RtFact]
    public static void Watchdog_JournalOwnsDownDispatchedOrUnknownAndOnlyConfirmedUpClears()
    {
        var dispatcher = new VirtualInputDispatcher();
        var clock = new VirtualClock(100);
        using var watchdog = new OwnedKeyWatchdog(dispatcher, clock, "r", 3);
        InputDispatchRequest down = new(1, "r", "a", 3, "key.a", InputEventPhase.Down, 1, 1, 1, 1, false);
        InputReceipt unknown = Receipt(down, DispatchOutcome.Unknown);
        watchdog.AfterSend([down], [unknown]);
        WorkerAssert.Equal(["key.a"], watchdog.OwnedControls.Order().ToArray());
        InputDispatchRequest up = down with { EventId = 2, Phase = InputEventPhase.Up };
        watchdog.AfterSend([up], [Receipt(up, DispatchOutcome.Unknown)]);
        WorkerAssert.Equal(1, watchdog.OwnedControls.Count, "unknown key-up retains ownership");
        watchdog.AfterSend([up], [Receipt(up, DispatchOutcome.NotDispatched)]);
        WorkerAssert.Equal(1, watchdog.OwnedControls.Count, "not-dispatched key-up cannot self-confirm release");
        watchdog.AfterSend([up], [Receipt(up, DispatchOutcome.Dispatched)]);
        WorkerAssert.Equal(0, watchdog.OwnedControls.Count);
        watchdog.AfterSend([down], [Receipt(down, DispatchOutcome.NotDispatched)]);
        WorkerAssert.Equal(0, watchdog.OwnedControls.Count, "denied key-down never becomes owned");
    }

    private static RunStartRequest Request(string session, string run, WorkerRunMode mode, string target = "target-a") =>
        new(session, run, mode, target);

    private static InputReceipt Receipt(InputDispatchRequest request, DispatchOutcome outcome) =>
        new(request.RunId, request.ActionId, request.SourceEpoch, request.Control,
            request.ScheduledQpc, request.DispatchQpc, outcome, null);

    private static string TempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "rt-worker-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static async Task<T> ThrowsAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); }
        catch (T ex) { return ex; }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private sealed class FakeRunHost : IRunHost
    {
        private readonly int _stopDelay;
        public FakeRunHost(RunStartRequest request, int stopDelay = 0, bool stopFailure = false)
        {
            SessionId = request.SessionId;
            RunId = request.RunId;
            TargetId = request.TargetId;
            Mode = request.Mode;
            _stopDelay = stopDelay;
            _stopFailure = stopFailure;
        }
        private readonly bool _stopFailure;
        public string SessionId { get; }
        public string RunId { get; }
        public string TargetId { get; }
        public WorkerRunMode Mode { get; }
        public int StopCalls { get; private set; }
        public List<string> Lifecycle { get; } = [];
        public void Freeze() => Lifecycle.Add("freeze");
        public async Task StopAsync()
        {
            StopCalls++;
            Lifecycle.Add("stop");
            if (_stopDelay > 0) await Task.Delay(_stopDelay);
            if (_stopFailure) throw new InvalidOperationException("injected stop failure");
        }
        public ValueTask DisposeAsync() => new(StopAsync());
    }
}

internal static class WorkerAssert
{
    public static void True(bool condition, string message = "Worker assertion") => Assert.True(condition, message);
    public static void Equal<T>(T expected, T actual, string message = "Worker assertion")
    {
        if (expected is System.Collections.IEnumerable expectedItems && actual is System.Collections.IEnumerable actualItems && expected is not string)
        {
            object?[] left = expectedItems.Cast<object?>().ToArray();
            object?[] right = actualItems.Cast<object?>().ToArray();
            Assert.True(left.SequenceEqual(right), message);
            return;
        }
        Assert.Equal(expected, actual, message);
    }
    public static TException Throws<TException>(Action action, string message = "Worker assertion") where TException : Exception
        => Assert.Throws<TException>(action, message);
}

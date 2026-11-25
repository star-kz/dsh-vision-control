using System.Text.Json;
using Rt.Adapters.Rhythm;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Frames;
using Rt.Core.Input;
using Rt.Core.Perception;
using Rt.Core.Runtime;
using Rt.Core.Safety;
using Rt.Core.Scheduling;
using Rt.Core.Skills;
using Rt.Core.Tracing;
using Rt.Windows;
using Rt.Windows.Capture;
using Rt.Windows.Input;

namespace Rt.Worker;

/// <summary>One real capture/perception/scheduling pipeline. Only a verified dedicated HIL may construct SendInput.</summary>
public sealed class NativeRunHost : IRunHost
{
    private readonly QpcClock _clock;
    private readonly WindowsCaptureSession _capture;
    private readonly FrameRing _frames;
    private readonly SceneSkill _skill;
    private readonly SafetyArbiter _safety;
    private readonly Scheduler _scheduler;
    private readonly ShadowOnlyInputDispatcher? _shadowDispatcher;
    private readonly SendInputDispatcher? _activeDispatcher;
    private readonly OwnedKeyWatchdog? _watchdog;
    private readonly TraceRecorder _trace;
    private readonly RunEventSequencer _events;
    private readonly Action<RunEvent, object> _emit;
    private readonly Func<string, string, Task> _ended;
    private readonly CancellationTokenSource _sceneCancel = new();
    private readonly SemaphoreSlim _frameSignal = new(0, 1);
    private readonly object _publishSync = new();
    private readonly object _stopSync = new();
    private readonly AuthorizationLease? _authorization;
    private readonly WorkerTarget _target;
    private readonly NativeDeadline? _deadline;
    private readonly Task _sceneLoop;
    private Task? _stopTask;
    private long _lastHeartbeatQpc;
    private int _frozen;
    private int _stopCompleted;
    private int _workerReleased;
    private long _processedFrames;
    private long _plannedActions;
    private long _policyRejections;
    private volatile string _state = "running";
    private string? _fault;

    private NativeRunHost(
        RunStartRequest request, WorkerTarget target, SceneDescriptor descriptor, string skillJson,
        QpcClock clock, WindowsCaptureSession capture, string backend, string backendDetail,
        AuthorizationLease? authorization, DedicatedSynthTarget? dedicated, TraceRecorder trace,
        Action<RunEvent, object> emit, Func<string, string, Task> ended, long? deadlineQpc)
    {
        SessionId = request.SessionId; RunId = request.RunId; Mode = request.Mode; TargetId = request.TargetId;
        _target = target; _clock = clock; _capture = capture; Backend = backend; BackendDetail = backendDetail;
        _authorization = authorization; _trace = trace; _emit = emit; _ended = ended;
        if (deadlineQpc is long requestedDue && requestedDue <= clock.Now)
            throw new ArgumentException("deadlineQpc must be in the future", nameof(deadlineQpc));
        Descriptor = descriptor; SkillJson = skillJson;
        _frames = new FrameRing(RunId, 3, capture.CurrentEpoch);
        _events = new RunEventSequencer(capture.CurrentEpoch);
        _lastHeartbeatQpc = clock.Now;
        _skill = new SceneSkill(new RhythmAdapter(descriptor), new LinearTracker(descriptor), new RhythmPolicy(descriptor));
        _safety = new SafetyArbiter(clock);
        if (Mode == WorkerRunMode.Active)
        {
            OwnedKeyWatchdog? watchdog = null;
            var observer = new ActiveDispatchObserver(() => watchdog, OnReceipt);
            _activeDispatcher = new SendInputDispatcher(dedicated!, _safety, _clock, observer);
            watchdog = new OwnedKeyWatchdog(_activeDispatcher, _clock, RunId, capture.CurrentEpoch);
            _watchdog = watchdog;
            _scheduler = new Scheduler(_clock, _safety, _activeDispatcher, RunId, descriptor.Policy.MaximumHoldQpc);
        }
        else
        {
            _shadowDispatcher = new ShadowOnlyInputDispatcher(OnReceipt);
            _scheduler = new Scheduler(_clock, _safety, _shadowDispatcher, RunId, descriptor.Policy.MaximumHoldQpc);
        }
        UpdateSafety();
        capture.FrameAvailable += OnFrame;
        capture.Invalidated += OnInvalidated;
        _sceneLoop = Task.Run(SceneLoopAsync);
        _watchdog?.Start(() =>
        {
            UpdateSafety();
            return Volatile.Read(ref _frozen) == 0 && HeartbeatValid;
        }, TimeSpan.FromMilliseconds(50));
        if (deadlineQpc is long due)
        {
            _deadline = NativeDeadline.Start(clock, TimeSpan.FromSeconds(Math.Max(0.001, (due - clock.Now) / (double)Qpc.Frequency)));
            _ = CompleteDeadlineAsync(_deadline.Completion);
        }
    }

    public string SessionId { get; }
    public string RunId { get; }
    public string TargetId { get; }
    public WorkerRunMode Mode { get; }
    public string Backend { get; }
    public string BackendDetail { get; }
    public SceneDescriptor Descriptor { get; }
    public string SkillJson { get; }
    public string TracePath { get; private init; } = null!;
    public long ProcessedFrames => Interlocked.Read(ref _processedFrames);
    public long PlannedActions => Interlocked.Read(ref _plannedActions);
    public long PolicyRejections => Interlocked.Read(ref _policyRejections);
    public FrameMeta? LastFrame { get; private set; }
    public int OwnedControlCount => _watchdog?.OwnedControls.Count ?? 0;
    private bool HeartbeatValid => _clock.Now - Interlocked.Read(ref _lastHeartbeatQpc) <= Qpc.Frequency * 5;

    internal static bool ComputeWorkerReleased(bool cleanupSucceeded, int pending, int held, int owned) =>
        cleanupSucceeded && pending == 0 && held == 0 && owned == 0;

    public static async Task<NativeRunHost> StartAsync(
        RunStartRequest request, WorkerTarget target, SceneDescriptor descriptor, string skillJson,
        AuthorizationLease? authorization, DedicatedSynthTarget? dedicated, string tracePath,
        Action<RunEvent, object> emit, Func<string, string, Task> ended, long? deadlineQpc,
        CancellationToken cancellationToken)
    {
        if (deadlineQpc is long absoluteDue && absoluteDue <= Qpc.Now)
            throw new ArgumentException("deadlineQpc must be in the future", nameof(deadlineQpc));
        var clock = new QpcClock();
        WindowsCaptureSession? capture = null;
        TraceRecorder? trace = null;
        try
        {
            CaptureTarget captureTarget = target.IsDedicatedHil
                ? CaptureTarget.ForAuthorizedWindow(target.Hwnd, authorization?.LeaseId ?? "shadow-hil")
                : CaptureTarget.ForMonitor(target.Monitor);
            CaptureStartResult started = await WindowsCaptureSession.StartAsync(captureTarget, null, cancellationToken).ConfigureAwait(false);
            capture = started.Session ?? throw new InvalidOperationException("real capture unavailable: " + started.Detail);
            Directory.CreateDirectory(Path.GetDirectoryName(tracePath)!);
            trace = new TraceRecorder(tracePath);
            var host = new NativeRunHost(request, target, descriptor, skillJson, clock, capture,
                started.Backend.ToString(), started.Detail, authorization, dedicated, trace, emit, ended, deadlineQpc)
            { TracePath = tracePath };
            capture = null; // host owns it
            return host;
        }
        catch
        {
            if (trace is not null) await trace.DisposeAsync().ConfigureAwait(false);
            capture?.Dispose();
            clock.Dispose();
            throw;
        }
    }

    public void Heartbeat() => Interlocked.Exchange(ref _lastHeartbeatQpc, _clock.Now);

    public object Status() => new
    {
        sessionId = SessionId, runId = RunId, mode = Mode.ToString().ToLowerInvariant(), state = _state,
        target = _target, backend = Backend, backendDetail = BackendDetail, fault = _fault,
        sourceEpoch = _events.CurrentEpoch, eventSeq = _events.EventSeq,
        frame = new { _frames.Stats.Published, _frames.Stats.Dropped, _frames.Stats.Overwritten },
        capture = new { status = _capture.Status.ToString(), detail = _capture.StatusDetail, epoch = _capture.CurrentEpoch },
        scheduler = new { pending = _scheduler.PendingCount, held = _scheduler.HeldCount, receipts = _scheduler.Receipts.Count },
        trace = new { path = TracePath, accepted = _trace.AcceptedCount, dropped = _trace.DroppedCount },
        heartbeatValid = HeartbeatValid,
        // Worker-side evidence only: a clean, quiescent stop released native input ownership.
        // releaseConfirmed remains false because no independent observer has confirmed it.
        released = Volatile.Read(ref _workerReleased) != 0, releaseConfirmed = false,
        ownedControls = _watchdog?.OwnedControls ?? Array.Empty<string>(),
    };

    public async Task<object> SnapshotAsync(string path, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _frozen) != 0) throw new InvalidOperationException("run is frozen or stopped");
        CaptureSnapshot? snapshot = await Task.Run(() => _capture.CopyLatestSnapshot(), cancellationToken).ConfigureAwait(false);
        if (snapshot is null) throw new InvalidOperationException("no current real capture frame is available");
        await PngSnapshotWriter.WriteAtomicAsync(path, snapshot.Metadata.Width, snapshot.Metadata.Height,
            snapshot.StrideBytes, snapshot.Pixels, cancellationToken).ConfigureAwait(false);
        return new
        {
            path = Path.GetFullPath(path), width = snapshot.Metadata.Width, height = snapshot.Metadata.Height,
            sourceEpoch = snapshot.Metadata.SourceEpoch, sequence = snapshot.Metadata.Sequence,
            capturedQpc = snapshot.Metadata.CapturedQpc, origin = snapshot.Origin.ToString(), inlinePixels = false,
        };
    }

    public void Freeze()
    {
        if (Interlocked.Exchange(ref _frozen, 1) != 0) return;
        _state = "frozen";
        _sceneCancel.Cancel();
        UpdateSafety();
        Record(TraceEnvelope.EStop, new { reason = "freeze" });
    }

    public Task StopAsync()
    {
        lock (_stopSync) return _stopTask ??= StopCoreAsync();
    }

    private async Task StopCoreAsync()
    {
        var failures = new List<Exception>();
        void Attempt(Action action)
        {
            try { action(); } catch (Exception ex) { failures.Add(ex); }
        }

        Attempt(Freeze);
        try { await _sceneLoop.ConfigureAwait(false); }
        catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException) { }
        catch (Exception ex) { failures.Add(ex); }
        Attempt(_scheduler.Stop);
        if (_watchdog is not null) Attempt(_watchdog.Stop);
        lock (_publishSync)
        {
            Attempt(() => _capture.FrameAvailable -= OnFrame);
            Attempt(() => _capture.Invalidated -= OnInvalidated);
            Attempt(_capture.Dispose);
            Attempt(_frameSignal.Dispose);
        }
        Interlocked.Exchange(ref _stopCompleted, 1);
        Attempt(() => _deadline?.Dispose());
        try { await _trace.DisposeAsync().ConfigureAwait(false); } catch (Exception ex) { failures.Add(ex); }
        Attempt(_sceneCancel.Dispose);
        Attempt(_clock.Dispose);
        bool cleanupSucceeded = failures.Count == 0;
        _workerReleased = ComputeWorkerReleased(cleanupSucceeded,
            _scheduler.PendingCount, _scheduler.HeldCount, _watchdog?.OwnedControls.Count ?? 0) ? 1 : 0;
        _state = cleanupSucceeded ? "stopped" : "stopped-unknown";
        try { EmitTerminal(); }
        catch (Exception ex)
        {
            failures.Add(ex);
            _workerReleased = 0;
            _state = "stopped-unknown";
        }
        if (failures.Count > 0)
        {
            _fault = "native run shutdown was incomplete: " + string.Join("; ", failures.Select(x => x.GetType().Name + ": " + x.Message));
            throw new AggregateException("native run shutdown was incomplete", failures);
        }
    }

    private void EmitTerminal()
    {
        long epoch = _events.CurrentEpoch;
        _events.Emit("terminal", epoch, identity => _emit(identity, Status()));
    }

    public async ValueTask DisposeAsync() => await StopAsync().ConfigureAwait(false);

    private void OnFrame(ShadowCaptureFrame frame)
    {
        lock (_publishSync)
        {
            // A callback may have passed an earlier check before stop won this lock.
            if (Volatile.Read(ref _frozen) != 0) return;
            bool published = _frames.TryPublish(frame.Pixels.Span, frame.Metadata.CapturedQpc, _clock.Now,
                frame.Metadata.Width, frame.Metadata.Height, FramePixelFormat.Bgra32, out _);
            if (!published) return;
            Record(TraceEnvelope.Frame, new { frame.Metadata, frame.Geometry, origin = frame.Origin.ToString() });
            if (_frameSignal.CurrentCount == 0) _frameSignal.Release();
        }
    }

    private void OnInvalidated(CaptureInvalidation invalidation)
    {
        Freeze();
        lock (_publishSync)
        {
            if (invalidation.SourceEpoch > _frames.SourceEpoch) _frames.BeginEpoch(invalidation.SourceEpoch);
            if (invalidation.SourceEpoch > _events.CurrentEpoch) _events.AdvanceEpoch(invalidation.SourceEpoch, invalidation.Reason.ToString());
        }
        _skill.Reset();
        Emit("invalidated", invalidation.SourceEpoch, new { reason = invalidation.Reason.ToString(), detail = invalidation.Detail });
    }

    private async Task SceneLoopAsync()
    {
        try
        {
            while (true)
            {
                await _frameSignal.WaitAsync(_sceneCancel.Token).ConfigureAwait(false);
                if (_sceneCancel.IsCancellationRequested) break;
                using FrameLease? lease = _frames.AcquireLatest();
                if (lease is null) continue;
                FrameMeta meta = lease.Meta;
                UpdateSafety();
                PolicyDecision decision = _skill.Process(new SceneFrame(meta, lease.Data, meta.Width * 4), _clock.Now);
                LastFrame = meta;
                Interlocked.Increment(ref _processedFrames);
                Interlocked.Add(ref _plannedActions, decision.Plans.Count);
                Interlocked.Add(ref _policyRejections, decision.Rejections.Count);
                foreach (PlannedAction planned in decision.Plans)
                {
                    if (Volatile.Read(ref _frozen) != 0) break;
                    Record(TraceEnvelope.Plan, planned);
                    Emit("plan", planned.Plan.SourceEpoch, planned);
                    UpdateSafety();
                    _scheduler.TrySchedule(planned.Plan);
                }
                foreach (PolicyRejection rejection in decision.Rejections)
                    Record("Rejection", rejection);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _fault = ex.GetType().Name + ": " + ex.Message;
            _state = "faulted";
            Freeze();
        }
    }

    private void UpdateSafety()
    {
        long epoch = _capture.CurrentEpoch;
        bool active = Mode == WorkerRunMode.Active && Volatile.Read(ref _frozen) == 0;
        WindowFacts facts = WindowFacts.Empty;
        if (active)
        {
            try { facts = new WindowsWindowFactsSource().ReadWindow(_target.Hwnd); } catch { }
        }
        WindowFacts foreground = WindowFacts.Empty;
        if (active)
        {
            try { foreground = new WindowsWindowFactsSource().ReadForeground(); } catch { }
        }
        _safety.Update(new SafetySnapshot(RunId, TargetId, epoch)
        {
            Authorized = active && _authorization?.Granted == true && _authorization.TargetId == TargetId,
            Active = active,
            Focused = active && foreground.Hwnd == _target.Hwnd,
            HeartbeatValid = active && HeartbeatValid,
            AuthorizationExpiresQpc = _authorization?.ExpiresQpc ?? -1,
            AllowedControls = Descriptor.Regions.Select(x => x.Control).ToArray(),
            SatisfiedPreconditions = Array.Empty<string>(),
            Bounds = facts.Bounds.Width > 0 ? facts.Bounds : null,
        });
    }

    private void OnReceipt(InputReceipt receipt)
    {
        Record(TraceEnvelope.Receipt, receipt);
        Emit("receipt", receipt.SourceEpoch, receipt);
    }

    private void Emit(string kind, long epoch, object payload)
    {
        if (Volatile.Read(ref _stopCompleted) != 0) return;
        try { _events.Emit(kind, epoch, identity => _emit(identity, payload)); }
        catch (StaleSourceEpochException) { /* A late producer must never emit into a newer epoch. */ }
    }

    private async Task CompleteDeadlineAsync(Task completion)
    {
        try
        {
            await completion.ConfigureAwait(false);
            if (_deadline?.IsExpired == true) await _ended(SessionId, RunId).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _fault = ex.GetType().Name + ": " + ex.Message;
            _state = "stopped-unknown";
        }
    }

    private void Record(string kind, object payload) =>
        _trace.TryRecord(kind, _clock.Now, JsonSerializer.SerializeToElement(payload));

    private sealed class ActiveDispatchObserver(Func<OwnedKeyWatchdog?> watchdog, Action<InputReceipt> receipt) : IInputDispatchObserver
    {
        public void BeforeSend(IReadOnlyList<InputDispatchRequest> requests) => watchdog()?.BeforeSend(requests);
        public void AfterSend(IReadOnlyList<InputDispatchRequest> requests, IReadOnlyList<InputReceipt> receipts)
        {
            watchdog()?.AfterSend(requests, receipts);
            foreach (InputReceipt item in receipts) receipt(item);
        }
    }
}

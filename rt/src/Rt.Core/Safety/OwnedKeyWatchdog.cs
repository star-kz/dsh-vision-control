using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;

namespace Rt.Core.Safety;

/// <summary>Run-owned key journal and forced-up watchdog. Only a Dispatched Up receipt clears ownership.</summary>
public class OwnedKeyWatchdog : IDisposable
{
    private readonly IInputDispatcher _dispatcher;
    private readonly IClock _clock;
    private readonly string _runId;
    private readonly long _sourceEpoch;
    private readonly object _sync = new();
    private readonly HashSet<string> _owned = new(StringComparer.Ordinal);
    private long _nextId;
    private long _releaseAttemptCount;
    private CancellationTokenSource? _monitor;
    private Task? _monitorTask;

    public OwnedKeyWatchdog(IInputDispatcher dispatcher, IClock clock, string runId, long sourceEpoch)
    {
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
        ArgumentException.ThrowIfNullOrEmpty(runId);
        _runId = runId;
        _sourceEpoch = sourceEpoch;
    }

    public IReadOnlyCollection<string> OwnedControls { get { lock (_sync) return _owned.ToArray(); } }
    public long ReleaseAttemptCount { get { lock (_sync) return _releaseAttemptCount; } }
    public void Register(string control) { ArgumentException.ThrowIfNullOrEmpty(control); lock (_sync) _owned.Add(control); }
    public void MarkReleased(string control) { lock (_sync) _owned.Remove(control); }
    public void BeforeSend(IReadOnlyList<InputDispatchRequest> requests) { }

    public void AfterSend(IReadOnlyList<InputDispatchRequest> requests, IReadOnlyList<InputReceipt> receipts)
    {
        ArgumentNullException.ThrowIfNull(requests);
        ArgumentNullException.ThrowIfNull(receipts);
        lock (_sync)
        {
            for (int i = 0; i < Math.Min(requests.Count, receipts.Count); i++)
            {
                InputDispatchRequest request = requests[i];
                DispatchOutcome outcome = receipts[i].Outcome;
                if (request.Phase == InputEventPhase.Down && outcome is DispatchOutcome.Dispatched or DispatchOutcome.Unknown)
                    _owned.Add(request.Control);
                else if (request.Phase == InputEventPhase.Up && outcome == DispatchOutcome.Dispatched)
                    _owned.Remove(request.Control);
            }
        }
    }

    public void OnHeartbeatLost() => ReleaseAll();
    public void Start(Func<bool> heartbeatValid, TimeSpan? pollInterval = null)
    {
        ArgumentNullException.ThrowIfNull(heartbeatValid);
        lock (_sync)
        {
            if (_monitorTask is not null) return;
            _monitor = new CancellationTokenSource();
            CancellationToken token = _monitor.Token;
            _monitorTask = Task.Run(async () =>
            {
                while (!token.IsCancellationRequested)
                {
                    if (!heartbeatValid()) ReleaseAll();
                    try { await Task.Delay(pollInterval ?? TimeSpan.FromMilliseconds(10), token).ConfigureAwait(false); }
                    catch (OperationCanceledException) { break; }
                }
            });
        }
    }

    public int ReleaseAll()
    {
        string[] controls;
        long attempt;
        lock (_sync)
        {
            controls = _owned.OrderBy(x => x, StringComparer.Ordinal).ToArray();
            if (controls.Length == 0) return 0;
            attempt = ++_nextId;
            _releaseAttemptCount += controls.Length;
        }
        long now = _clock.Now;
        InputDispatchRequest[] requests = controls.Select((control, index) => new InputDispatchRequest(
            EventId: -((attempt << 20) + index), RunId: _runId, ActionId: $"watchdog-{attempt}-{index}",
            SourceEpoch: _sourceEpoch, Control: control, Phase: InputEventPhase.Up,
            ScheduledQpc: now, DispatchQpc: now, BatchId: -attempt, BatchSize: controls.Length, Forced: true)).ToArray();
        try
        {
            IReadOnlyList<InputReceipt> receipts = _dispatcher.DispatchBatch(requests);
            AfterSend(requests, receipts);
        }
        catch { /* Unknown release delivery retains ownership for an explicit later retry. */ }
        return controls.Length;
    }

    public void Stop()
    {
        CancellationTokenSource? monitor;
        Task? task;
        lock (_sync) { monitor = _monitor; task = _monitorTask; _monitor = null; _monitorTask = null; }
        monitor?.Cancel();
        if (task is not null) { try { task.GetAwaiter().GetResult(); } catch { } }
        monitor?.Dispose();
        ReleaseAll();
    }
    public void Dispose() => Stop();
}

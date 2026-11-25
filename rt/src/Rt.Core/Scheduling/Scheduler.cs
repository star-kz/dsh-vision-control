using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;

namespace Rt.Core.Scheduling;

/// <summary>
/// Single dedicated-thread, min-heap input scheduler. All dispatch-time decisions use the
/// schedulable clock; no wall clock is consulted and no outcome other than Dispatched is retried.
/// </summary>
public sealed class Scheduler : IDisposable
{
    private readonly ISchedulableClock _clock;
    private readonly SafetyArbiter _safety;
    private readonly IInputDispatcher _dispatcher;
    private readonly string _runId;
    private readonly long _maxHoldTicks;
    private readonly HeldInputRegistry _registry;
    private readonly object _gate = new();
    private readonly PriorityQueue<ScheduledEntry, HeapPriority> _heap = new();
    private readonly Dictionary<string, PlanState> _plans = new(StringComparer.Ordinal);
    private readonly Queue<Command> _commands = new();
    private readonly List<InputReceipt> _receipts = new();
    private readonly List<GateVerdict> _verdicts = new();
    private readonly Thread _thread;
    private CancellationTokenSource _wake = new();
    private bool _accepting = true;
    private bool _running = true;
    private bool _processing;
    private bool _stopEnqueued;
    private bool _disposed;
    private int _pendingCount;
    private static long s_nextEventId;
    private long _nextSequence;
    private long _nextBatchId;
    private long _dispatchCycle;

    public Scheduler(
        ISchedulableClock clock,
        SafetyArbiter safety,
        IInputDispatcher dispatcher,
        string runId,
        long maxHoldTicks,
        HeldInputRegistry? registry = null)
    {
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
        _safety = safety ?? throw new ArgumentNullException(nameof(safety));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        ArgumentException.ThrowIfNullOrEmpty(runId);
        ArgumentOutOfRangeException.ThrowIfNegative(maxHoldTicks);
        _runId = runId;
        _maxHoldTicks = maxHoldTicks;
        _registry = registry ?? new HeldInputRegistry();
        _thread = new Thread(Run) { IsBackground = true, Name = $"RtScheduler:{runId}" };
        _thread.Start();
    }

    public bool IsAcceptingPlans { get { lock (_gate) return _accepting; } }
    public bool IsRunning { get { lock (_gate) return _running; } }
    public bool IsIdle { get { lock (_gate) return !_processing; } }
    public int PendingCount { get { lock (_gate) return _pendingCount; } }
    public int HeldCount { get { lock (_gate) return _plans.Values.Sum(plan => plan.Held.Count); } }
    public long DispatchCycle { get { lock (_gate) return _dispatchCycle; } }
    public IReadOnlyList<InputReceipt> Receipts { get { lock (_gate) return _receipts.ToArray(); } }
    public IReadOnlyList<GateVerdict> GateVerdicts { get { lock (_gate) return _verdicts.ToArray(); } }

    public bool TrySchedule(ActionPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (plan.Events.Count == 0) return false;
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_accepting || !_running || _plans.ContainsKey(plan.ActionId)) return false;
            var state = new PlanState(plan);
            foreach (InputEventSpec spec in plan.Events)
            {
                if (spec.DownQpc is not long down)
                    throw new ArgumentException("every scheduled input requires DownQpc", nameof(plan));
                long eventId = Interlocked.Increment(ref s_nextEventId);
                long cap = SaturatedAdd(down, _maxHoldTicks);
                long requestedUp = spec.UpQpc ?? cap;
                long up = Math.Max(down, Math.Min(requestedUp, cap));
                var downEntry = new ScheduledEntry(state, spec, InputEventPhase.Down, down, eventId, ++_nextSequence);
                var upEntry = new ScheduledEntry(state, spec, InputEventPhase.Up, up, eventId, ++_nextSequence);
                state.Entries.Add(downEntry);
                state.Entries.Add(upEntry);
                _heap.Enqueue(downEntry, new HeapPriority(down, downEntry.Sequence));
                _heap.Enqueue(upEntry, new HeapPriority(up, upEntry.Sequence));
                _pendingCount += 2;
            }
            _plans.Add(plan.ActionId, state);
        }
        SignalWake();
        return true;
    }

    /// <summary>Synchronously cancels one plan and releases only that plan's registered keys.</summary>
    public void Cancel(string actionId)
    {
        ArgumentException.ThrowIfNullOrEmpty(actionId);
        Command command;
        lock (_gate)
        {
            if (!_running || _stopEnqueued) return;
            if (Environment.CurrentManagedThreadId == _thread.ManagedThreadId)
                throw new InvalidOperationException("scheduler thread cannot synchronously wait for its own cancellation");
            command = new Command(CommandKind.Cancel, actionId);
            _commands.Enqueue(command);
        }
        SignalWake();
        command.Done.Wait();
        command.Done.Dispose();
    }

    public void EmergencyStop() => Stop();

    /// <summary>Freeze new plans → cancel pending → release owned keys → flush → exit.</summary>
    public void Stop()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _accepting = false;
            if (!_stopEnqueued && _running)
            {
                _stopEnqueued = true;
                _commands.Enqueue(new Command(CommandKind.Stop, null));
            }
        }
        SignalWake();
        if (_thread.IsAlive && Environment.CurrentManagedThreadId != _thread.ManagedThreadId)
            _thread.Join();
    }

    public void Dispose()
    {
        Stop();
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        _wake.Dispose();
    }

    private void Run()
    {
        while (true)
        {
            Command? command = null;
            List<ScheduledEntry>? batch = null;
            long waitDeadline = 0;
            CancellationToken waitToken = default;
            lock (_gate)
            {
                _processing = false;
                if (_commands.Count > 0)
                {
                    command = _commands.Dequeue();
                    _processing = true;
                }
                else
                {
                    DiscardCancelledHead();
                    if (_heap.Count == 0)
                    {
                        if (!_running) break;
                        Monitor.Wait(_gate);
                        continue;
                    }
                    waitDeadline = _heap.Peek().Due;
                    if (waitDeadline <= _clock.Now)
                    {
                        batch = TakeBatchCore(waitDeadline);
                        _processing = true;
                    }
                    else
                    {
                        waitToken = _wake.Token;
                    }
                }
            }

            if (command is not null)
            {
                bool exit = ProcessCommand(command);
                lock (_gate) _processing = false;
                command.Done.Set();
                if (exit) break;
                continue;
            }

            if (batch is not null)
            {
                ProcessBatch(batch);
                lock (_gate)
                {
                    _processing = false;
                    _dispatchCycle++;
                }
                continue;
            }

            try
            {
                _clock.WaitUntilAsync(waitDeadline, waitToken).AsTask().GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                // A new earlier deadline, cancellation, or stop replaced this wait.
            }
        }
    }

    private bool ProcessCommand(Command command)
    {
        if (command.Kind == CommandKind.Cancel)
        {
            PlanState? plan;
            lock (_gate) _plans.TryGetValue(command.ActionId!, out plan);
            if (plan is not null)
            {
                CancelEntries(plan);
                ReleaseHeld(TakePlanHeld(plan));
                lock (_gate) _plans.Remove(plan.Plan.ActionId);
            }
            return false;
        }

        PlanState[] plans;
        lock (_gate) plans = _plans.Values.ToArray();
        foreach (PlanState plan in plans) CancelEntries(plan);
        ReleaseHeld(TakeAllOwnedHeld());
        _dispatcher.Flush();
        lock (_gate)
        {
            _plans.Clear();
            _running = false;
            _processing = false;
        }
        return true;
    }

    private void CancelEntries(PlanState plan)
    {
        lock (_gate)
        {
            long now = _clock.Now;
            foreach (ScheduledEntry entry in plan.Entries)
            {
                if (entry.Completed) continue;
                entry.Cancelled = true;
                entry.Completed = true;
                _pendingCount--;
                if (entry.Phase == InputEventPhase.Down)
                {
                    _receipts.Add(new InputReceipt(
                        _runId, plan.Plan.ActionId, plan.Plan.SourceEpoch, entry.Spec.Control,
                        entry.Due, now, DispatchOutcome.NotDispatched, "cancelled before dispatch"));
                }
            }
        }
    }

    private List<HeldInput> TakePlanHeld(PlanState plan)
    {
        lock (_gate)
        {
            var held = plan.Held.Values.OrderBy(input => input.EventId).ToList();
            foreach (long eventId in plan.Held.Keys) _registry.TryTake(eventId, out _);
            plan.Held.Clear();
            return held;
        }
    }

    private List<HeldInput> TakeAllOwnedHeld()
    {
        lock (_gate)
        {
            var held = new List<HeldInput>();
            foreach (PlanState plan in _plans.Values)
            {
                held.AddRange(plan.Held.Values);
                foreach (long eventId in plan.Held.Keys) _registry.TryTake(eventId, out _);
                plan.Held.Clear();
            }
            return held.OrderBy(input => input.EventId).ToList();
        }
    }

    private void ReleaseHeld(IReadOnlyList<HeldInput> held)
    {
        if (held.Count == 0) return;
        long now = _clock.Now;
        long batchId = NextBatchId();
        var requests = held.Select(input => new InputDispatchRequest(
            input.EventId, _runId, input.ActionId, input.SourceEpoch, input.Control,
            InputEventPhase.Up, now, now, batchId, held.Count, Forced: true)).ToArray();
        Send(requests);
    }

    private void ProcessBatch(List<ScheduledEntry> batch)
    {
        long now = _clock.Now;
        var dispatchEntries = new List<ScheduledEntry>(batch.Count);
        foreach (ScheduledEntry entry in batch)
        {
            if (entry.Phase == InputEventPhase.Down)
            {
                IReadOnlyList<GateVerdict> verdicts = _safety.EvaluateAll(entry.Plan.Plan, entry.Spec);
                lock (_gate) _verdicts.AddRange(verdicts);
                if (verdicts.Any(verdict => !verdict.Allowed))
                {
                    Complete(entry, DispatchOutcome.NotDispatched, "safety gate denied dispatch");
                    CancelCounterpartUp(entry);
                    continue;
                }
            }
            dispatchEntries.Add(entry);
        }

        if (dispatchEntries.Count == 0)
        {
            CleanupPlans();
            return;
        }

        long batchId = NextBatchId();
        var requests = dispatchEntries.Select(entry => new InputDispatchRequest(
            entry.EventId, _runId, entry.Plan.Plan.ActionId, entry.Plan.Plan.SourceEpoch,
            entry.Spec.Control, entry.Phase, entry.Due, now, batchId,
            dispatchEntries.Count, Forced: false)).ToArray();
        InputReceipt[] receipts = Send(requests);
        var outcomes = new Dictionary<ScheduledEntry, InputReceipt>();
        for (int i = 0; i < dispatchEntries.Count; i++) outcomes.Add(dispatchEntries[i], receipts[i]);

        bool unknownDown = false;
        foreach (ScheduledEntry entry in dispatchEntries)
        {
            InputReceipt receipt = outcomes[entry];
            Complete(entry, receipt.Outcome, receipt.Error);
            if (entry.Phase == InputEventPhase.Down)
            {
                if (receipt.Outcome == DispatchOutcome.Unknown) unknownDown = true;
                if (receipt.Outcome == DispatchOutcome.NotDispatched)
                {
                    CancelCounterpartUp(entry);
                    continue;
                }

                bool upAttempted = dispatchEntries.Any(candidate =>
                    candidate.Phase == InputEventPhase.Up &&
                    ReferenceEquals(candidate.Plan, entry.Plan) &&
                    candidate.EventId == entry.EventId &&
                    outcomes[candidate].Outcome != DispatchOutcome.NotDispatched);
                if (!upAttempted) RegisterHeld(entry, now);
            }
            else if (receipt.Outcome != DispatchOutcome.NotDispatched)
            {
                // A successful or uncertain release is never blindly repeated.
                RemoveHeld(entry.Plan, entry.EventId);
            }
        }

        if (unknownDown)
        {
            // Partial/timeout outcomes make the entire down batch suspect. Do not retry any down;
            // cancel future releases and force one UP for every possibly-held key from that batch.
            foreach (ScheduledEntry entry in dispatchEntries.Where(e => e.Phase == InputEventPhase.Down))
                CancelCounterpartUp(entry);
        }

        var releaseKeys = new List<(PlanState Plan, long EventId)>();
        if (unknownDown)
        {
            foreach (ScheduledEntry entry in dispatchEntries.Where(e =>
                e.Phase == InputEventPhase.Down && outcomes[e].Outcome != DispatchOutcome.NotDispatched))
                releaseKeys.Add((entry.Plan, entry.EventId));
        }
        foreach (ScheduledEntry entry in dispatchEntries.Where(e =>
            e.Phase == InputEventPhase.Up && outcomes[e].Outcome == DispatchOutcome.NotDispatched))
            releaseKeys.Add((entry.Plan, entry.EventId));

        if (releaseKeys.Count > 0)
        {
            ReleaseHeld(TakeHeld(releaseKeys));
            // The forced release above is the only recovery attempt; no scheduled UP remains.
            foreach ((PlanState plan, long eventId) in releaseKeys)
            {
                ScheduledEntry? up = FindPendingUp(plan, eventId);
                if (up is not null) CancelEntry(up);
            }
        }
        CleanupPlans();
    }

    private InputReceipt[] Send(IReadOnlyList<InputDispatchRequest> requests)
    {
        InputReceipt[] receipts;
        try
        {
            receipts = _dispatcher.DispatchBatch(requests).ToArray();
        }
        catch (Exception ex)
        {
            receipts = requests.Select(request => new InputReceipt(
                request.RunId, request.ActionId, request.SourceEpoch, request.Control,
                request.ScheduledQpc, request.DispatchQpc, DispatchOutcome.Unknown,
                ex.GetType().Name + ": " + ex.Message)).ToArray();
        }
        if (receipts.Length != requests.Count)
        {
            var normalized = new InputReceipt[requests.Count];
            for (int i = 0; i < requests.Count; i++)
            {
                normalized[i] = i < receipts.Length ? receipts[i] : new InputReceipt(
                    requests[i].RunId, requests[i].ActionId, requests[i].SourceEpoch,
                    requests[i].Control, requests[i].ScheduledQpc, requests[i].DispatchQpc,
                    DispatchOutcome.Unknown, "driver returned no receipt; outcome is unknown");
            }
            receipts = normalized;
        }
        lock (_gate) _receipts.AddRange(receipts);
        return receipts;
    }

    private void Complete(ScheduledEntry entry, DispatchOutcome outcome, string? error)
    {
        lock (_gate)
        {
            if (entry.Completed) return;
            entry.Completed = true;
            _pendingCount--;
            if (outcome == DispatchOutcome.NotDispatched && !_receipts.Any(receipt =>
                receipt.ActionId == entry.Plan.Plan.ActionId &&
                receipt.Control == entry.Spec.Control &&
                receipt.ScheduledQpc == entry.Due))
            {
                _receipts.Add(new InputReceipt(
                    _runId, entry.Plan.Plan.ActionId, entry.Plan.Plan.SourceEpoch,
                    entry.Spec.Control, entry.Due, _clock.Now, outcome, error));
            }
        }
    }

    private void RegisterHeld(ScheduledEntry entry, long downQpc)
    {
        lock (_gate)
        {
            if (entry.Plan.Held.ContainsKey(entry.EventId)) return;
            var held = new HeldInput(entry.EventId, _runId, entry.Plan.Plan.ActionId,
                entry.Plan.Plan.SourceEpoch, entry.Spec.Control, downQpc);
            if (_registry.Register(held)) entry.Plan.Held.Add(entry.EventId, held);
        }
    }

    private void RemoveHeld(PlanState plan, long eventId)
    {
        lock (_gate)
        {
            if (plan.Held.Remove(eventId)) _registry.TryTake(eventId, out _);
        }
    }

    private List<HeldInput> TakeHeld(IEnumerable<(PlanState Plan, long EventId)> keys)
    {
        lock (_gate)
        {
            var held = new List<HeldInput>();
            var seen = new HashSet<(PlanState, long)>();
            foreach ((PlanState plan, long eventId) in keys)
            {
                if (!seen.Add((plan, eventId))) continue;
                if (plan.Held.Remove(eventId, out HeldInput input))
                {
                    _registry.TryTake(eventId, out _);
                    held.Add(input);
                }
            }
            return held;
        }
    }

    private void CancelCounterpartUp(ScheduledEntry down)
    {
        ScheduledEntry? up = FindPendingUp(down.Plan, down.EventId);
        if (up is not null) CancelEntry(up);
    }

    private ScheduledEntry? FindPendingUp(PlanState plan, long eventId)
    {
        lock (_gate)
            return plan.Entries.FirstOrDefault(entry =>
                entry.EventId == eventId && entry.Phase == InputEventPhase.Up && !entry.Completed);
    }

    private void CancelEntry(ScheduledEntry entry)
    {
        lock (_gate)
        {
            if (entry.Completed) return;
            entry.Cancelled = true;
            entry.Completed = true;
            _pendingCount--;
        }
    }

    private void CleanupPlans()
    {
        lock (_gate)
        {
            foreach (string actionId in _plans.Values
                .Where(plan => plan.Held.Count == 0 && plan.Entries.All(entry => entry.Completed))
                .Select(plan => plan.Plan.ActionId).ToArray())
                _plans.Remove(actionId);
        }
    }

    private List<ScheduledEntry> TakeBatchCore(long deadline)
    {
        var batch = new List<ScheduledEntry>();
        while (_heap.Count > 0 && _heap.Peek().Due == deadline)
        {
            ScheduledEntry entry = _heap.Dequeue();
            if (!entry.Completed) batch.Add(entry);
        }
        return batch;
    }

    private void DiscardCancelledHead()
    {
        while (_heap.Count > 0 && _heap.Peek().Completed) _heap.Dequeue();
    }

    private long NextBatchId() { lock (_gate) return ++_nextBatchId; }

    private void SignalWake()
    {
        CancellationTokenSource previous;
        lock (_gate)
        {
            previous = _wake;
            _wake = new CancellationTokenSource();
            Monitor.PulseAll(_gate);
        }
        try { previous.Cancel(); }
        finally { previous.Dispose(); }
    }

    private static long SaturatedAdd(long value, long delta) =>
        value > long.MaxValue - delta ? long.MaxValue : value + delta;

    private readonly record struct HeapPriority(long Due, long Sequence) : IComparable<HeapPriority>
    {
        public int CompareTo(HeapPriority other)
        {
            int due = Due.CompareTo(other.Due);
            return due != 0 ? due : Sequence.CompareTo(other.Sequence);
        }
    }

    private sealed class PlanState
    {
        public PlanState(ActionPlan plan) => Plan = plan;
        public ActionPlan Plan { get; }
        public List<ScheduledEntry> Entries { get; } = new();
        public Dictionary<long, HeldInput> Held { get; } = new();
    }

    private sealed class ScheduledEntry
    {
        public ScheduledEntry(PlanState plan, InputEventSpec spec, InputEventPhase phase,
            long due, long eventId, long sequence)
        {
            Plan = plan;
            Spec = spec;
            Phase = phase;
            Due = due;
            EventId = eventId;
            Sequence = sequence;
        }
        public PlanState Plan { get; }
        public InputEventSpec Spec { get; }
        public InputEventPhase Phase { get; }
        public long Due { get; }
        public long EventId { get; }
        public long Sequence { get; }
        public bool Cancelled { get; set; }
        public bool Completed { get; set; }
    }

    private enum CommandKind { Cancel, Stop }
    private sealed class Command
    {
        public Command(CommandKind kind, string? actionId) { Kind = kind; ActionId = actionId; }
        public CommandKind Kind { get; }
        public string? ActionId { get; }
        public ManualResetEventSlim Done { get; } = new(false);
    }
}

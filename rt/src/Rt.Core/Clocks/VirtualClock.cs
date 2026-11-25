namespace Rt.Core.Clocks;

/// <summary>
/// Deterministic manually-driven clock for tests and file replay. Time moves only through
/// <see cref="Advance"/>/<see cref="AdvanceTo"/>; waiters whose deadline is now due are released
/// in (deadline, registration order) — so equal deadlines complete strictly FIFO.
/// Completions happen outside the internal lock and run continuations synchronously, which makes
/// release order observable and deterministic; continuations must therefore not block.
/// The unix-time mapping is a pure function of the fixed anchor and raw ticks — the wall clock
/// (DateTime.Now/UtcNow) is never consulted anywhere in this type.
/// </summary>
public sealed class VirtualClock : ISchedulableClock
{
    private readonly object _gate = new();
    private readonly List<Waiter> _waiters = new();
    private readonly long _frequency;
    private readonly long _anchorTicks;
    private readonly DateTimeOffset _unixAnchor;
    private long _now;
    private long _nextOrder;

    /// <param name="frequency">Ticks per second this virtual clock counts (default 10 MHz).</param>
    /// <param name="initialTicks">Starting raw tick value.</param>
    /// <param name="unixAnchor">Unix time that corresponds to <paramref name="initialTicks"/>; defaults to the unix epoch.</param>
    public VirtualClock(long frequency = 10_000_000, long initialTicks = 0, DateTimeOffset? unixAnchor = null)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(frequency, 0);
        _frequency = frequency;
        _now = initialTicks;
        _anchorTicks = initialTicks;
        _unixAnchor = unixAnchor ?? DateTimeOffset.UnixEpoch;
    }

    public long Frequency => _frequency;

    public long Now
    {
        get { lock (_gate) return _now; }
    }

    /// <summary>Number of waiters currently queued (test/driver observability).</summary>
    public int PendingWaiterCount
    {
        get { lock (_gate) return _waiters.Count; }
    }

    /// <summary>Smallest deadline among queued waiters, or null when none are waiting.</summary>
    public long? EarliestPendingDeadline
    {
        get
        {
            lock (_gate)
            {
                long? earliest = null;
                foreach (Waiter waiter in _waiters)
                {
                    if (earliest is null || waiter.Deadline < earliest) earliest = waiter.Deadline;
                }
                return earliest;
            }
        }
    }

    /// <summary>Move time forward by <paramref name="ticks"/> (>= 0) and release due waiters.</summary>
    public void Advance(long ticks)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(ticks);
        AdvanceCore(ticks, relative: true);
    }

    /// <summary>Move time forward to an absolute tick value (must not be in the past) and release due waiters.</summary>
    public void AdvanceTo(long ticks) => AdvanceCore(ticks, relative: false);

    private void AdvanceCore(long ticks, bool relative)
    {
        List<Waiter> due = new();
        long newNow;
        lock (_gate)
        {
            newNow = relative ? _now + ticks : ticks;
            if (newNow < _now)
                throw new ArgumentOutOfRangeException(nameof(ticks), $"virtual time cannot move backwards (now={_now}, requested={newNow})");
            _now = newNow;

            if (_waiters.Count > 0)
            {
                _waiters.Sort(static (a, b) =>
                    a.Deadline != b.Deadline ? a.Deadline.CompareTo(b.Deadline) : a.Order.CompareTo(b.Order));
                int releaseCount = 0;
                while (releaseCount < _waiters.Count && _waiters[releaseCount].Deadline <= newNow)
                    releaseCount++;
                if (releaseCount > 0)
                {
                    due.AddRange(_waiters.GetRange(0, releaseCount));
                    _waiters.RemoveRange(0, releaseCount);
                }
            }
        }

        // Complete outside the lock, in sorted release order. Disposing the registration first
        // makes a concurrent cancel either fully happen before (waiter already removed) or never.
        foreach (Waiter waiter in due)
        {
            waiter.Registration.Dispose();
            waiter.Completion.TrySetResult(new WaitResult(waiter.Deadline, newNow, 0, 0));
        }
    }

    public ValueTask<WaitResult> WaitUntilAsync(long deadlineTicks, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Waiter waiter;
        lock (_gate)
        {
            if (deadlineTicks <= _now)
                return ValueTask.FromResult(new WaitResult(deadlineTicks, _now, 0, 0));

            waiter = new Waiter(this, deadlineTicks, _nextOrder++, cancellationToken);
            _waiters.Add(waiter);
            // Registered AFTER the add: a token cancelled in this window runs the callback
            // synchronously and removes the waiter again (the lock is re-entrant on this thread).
            waiter.Registration = cancellationToken.Register(static state => ((Waiter)state!).Cancel(), waiter);
        }
        return new ValueTask<WaitResult>(waiter.Completion.Task);
    }

    public DateTimeOffset ToUnixTime(long ticks) =>
        _unixAnchor.Add(new TimeSpan((long)((decimal)(ticks - _anchorTicks) * TimeSpan.TicksPerSecond / _frequency)));

    public long FromUnixTime(DateTimeOffset unixTime) =>
        _anchorTicks + (long)((decimal)(unixTime - _unixAnchor).Ticks * _frequency / TimeSpan.TicksPerSecond);

    public TimeSpan ToTimeSpan(long ticks) =>
        new((long)((decimal)ticks * TimeSpan.TicksPerSecond / _frequency));

    public long FromTimeSpan(TimeSpan span) =>
        (long)((decimal)span.Ticks * _frequency / TimeSpan.TicksPerSecond);

    private sealed class Waiter
    {
        private readonly VirtualClock _clock;
        private readonly CancellationToken _token;

        public Waiter(VirtualClock clock, long deadline, long order, CancellationToken token)
        {
            _clock = clock;
            Deadline = deadline;
            Order = order;
            _token = token;
            Completion = new TaskCompletionSource<WaitResult>();
        }

        public long Deadline { get; }
        public long Order { get; }
        public TaskCompletionSource<WaitResult> Completion { get; }
        public CancellationTokenRegistration Registration;

        /// <summary>Runs on the cancelling thread (possibly synchronously inside Register). Never touches Registration — disposing a registration from within its own callback deadlocks.</summary>
        public void Cancel()
        {
            lock (_clock._gate)
            {
                _clock._waiters.Remove(this);
            }
            Completion.TrySetCanceled(_token);
        }
    }
}

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Rt.Core.Clocks;

namespace Rt.Windows;

/// <summary>
/// Windows QPC-backed schedulable clock. Waits use a high-resolution waitable timer
/// (CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, falling back to a standard timer and then to
/// Task.Delay), and only the final slice before the deadline is finished with a BOUNDED spin —
/// spinning is never unbounded. This is best-effort low lateness on a non-realtime OS,
/// never a hard real-time guarantee. Every wait reports its timer and spin accounting in
/// <see cref="WaitResult"/>; timer setup failures are counted in <see cref="TimerFallbackCount"/>.
/// </summary>
public sealed class QpcClock : ISchedulableClock, IDisposable
{
    private const uint CreateWaitableTimerHighResolution = 0x2;
    private const uint TimerAllAccess = 0x1F0003;

    private readonly long _spinBudgetTicks;
    private readonly DateTimeOffset _unixAnchor;
    private readonly long _anchorQpc;
    private volatile bool _disposed;
    private int _timerFallbackCount;

    /// <param name="spinBudget">Maximum time a single wait may finish by spinning (default 1 ms). The spin is bounded by this budget (hard cap: 2x budget or 1 ms, whichever is larger).</param>
    /// <param name="unixAnchor">Unix time corresponding to construction time; defaults to DateTimeOffset.UtcNow at construction.</param>
    public QpcClock(TimeSpan? spinBudget = null, DateTimeOffset? unixAnchor = null)
    {
        TimeSpan budget = spinBudget ?? TimeSpan.FromMilliseconds(1);
        ArgumentOutOfRangeException.ThrowIfNegative(budget.Ticks);
        _spinBudgetTicks = Qpc.FromTimeSpan(budget);
        _unixAnchor = unixAnchor ?? DateTimeOffset.UtcNow;
        _anchorQpc = Qpc.Now;
        UsesHighResolutionTimer = ProbeHighResolutionTimer();
    }

    /// <summary>True when the OS accepted CREATE_WAITABLE_TIMER_HIGH_RESOLUTION at construction.</summary>
    public bool UsesHighResolutionTimer { get; }

    /// <summary>The configured per-wait spin budget.</summary>
    public TimeSpan SpinBudget => Qpc.ToTimeSpan(_spinBudgetTicks);

    /// <summary>How many waits had to fall back because a waitable timer could not be created or armed.</summary>
    public int TimerFallbackCount => Volatile.Read(ref _timerFallbackCount);

    public long Frequency => Qpc.Frequency;

    public long Now => Qpc.Now;

    public DateTimeOffset ToUnixTime(long ticks) => _unixAnchor.Add(Qpc.ToTimeSpan(ticks - _anchorQpc));

    public long FromUnixTime(DateTimeOffset unixTime) => _anchorQpc + Qpc.FromTimeSpan(unixTime - _unixAnchor);

    public TimeSpan ToTimeSpan(long ticks) => Qpc.ToTimeSpan(ticks);

    public long FromTimeSpan(TimeSpan span) => Qpc.FromTimeSpan(span);

    public async ValueTask<WaitResult> WaitUntilAsync(long deadlineTicks, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        long timerTotal = 0;
        long spinTotal = 0;
        int spinPhases = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long remaining = deadlineTicks - Qpc.Now;
            if (remaining <= 0) break;

            if (remaining <= _spinBudgetTicks && spinPhases < 8)
            {
                // Final approach: finish with a bounded spin (never longer than the hard cap).
                spinPhases++;
                spinTotal += BoundedSpin(deadlineTicks, cancellationToken);
                continue;
            }

            // Leave the spin budget for the end; if that would be a non-positive timer wait,
            // arm a short timer instead so this loop always yields the thread.
            long due = remaining - _spinBudgetTicks;
            if (due <= 0) due = Math.Min(remaining, Qpc.FromMilliseconds(0.5));
            timerTotal += await TimerWaitAsync(due, cancellationToken).ConfigureAwait(false);
        }

        return new WaitResult(deadlineTicks, Qpc.Now, timerTotal, spinTotal);
    }

    /// <summary>Spin until the deadline or until a bounded hard cap expires; returns ticks spent.</summary>
    private long BoundedSpin(long deadlineTicks, CancellationToken cancellationToken)
    {
        long start = Qpc.Now;
        long hardCap = Math.Max(_spinBudgetTicks * 2, Qpc.FromMilliseconds(1));
        int iterations = 0;
        while (true)
        {
            long now = Qpc.Now;
            if (now >= deadlineTicks || now - start > hardCap) return now - start;
            if ((++iterations & 0x3FF) == 0) cancellationToken.ThrowIfCancellationRequested();
            Thread.SpinWait(1); // PAUSE-hint spin; Thread.OnSpinWait is unavailable on net8.0 ref packs
        }
    }

    /// <summary>Block for approximately <paramref name="dueTicks"/> on a waitable timer; returns ticks spent.</summary>
    private async Task<long> TimerWaitAsync(long dueTicks, CancellationToken cancellationToken)
    {
        long start = Qpc.Now;

        SafeWaitHandle? timerHandle = CreateTimerHandle();
        if (timerHandle is null)
        {
            Interlocked.Increment(ref _timerFallbackCount);
            await Task.Delay(Qpc.ToTimeSpan(dueTicks), cancellationToken).ConfigureAwait(false);
            return Qpc.Now - start;
        }

        using var signal = new ManualResetEvent(false);
        signal.SafeWaitHandle = timerHandle; // the event now owns (and will close) the handle

        long dueHns = -(long)((decimal)dueTicks * TimeSpan.TicksPerSecond / Qpc.Frequency);
        if (dueHns > -1) dueHns = -1;
        if (!SetWaitableTimer(signal.SafeWaitHandle, ref dueHns, 0, IntPtr.Zero, IntPtr.Zero, false))
        {
            Interlocked.Increment(ref _timerFallbackCount);
            await Task.Delay(Qpc.ToTimeSpan(dueTicks), cancellationToken).ConfigureAwait(false);
            return Qpc.Now - start;
        }

        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        long guardMs = (long)Math.Ceiling(Qpc.ToMilliseconds(dueTicks)) + 5_000;
        RegisteredWaitHandle registration = ThreadPool.RegisterWaitForSingleObject(
            signal,
            static (state, timedOut) => ((TaskCompletionSource<bool>)state!).TrySetResult(!timedOut),
            completion,
            (int)Math.Min(guardMs, int.MaxValue),
            executeOnlyOnce: true);

        using CancellationTokenRegistration cancellation = cancellationToken.Register(
            static state =>
            {
                var pair = (Tuple<TaskCompletionSource<bool>, CancellationToken>)state!;
                pair.Item1.TrySetCanceled(pair.Item2);
            },
            Tuple.Create(completion, cancellationToken));

        try
        {
            // signaled == false means the guard timeout fired (pathological); the outer loop
            // re-checks the deadline, so we can never return before it either way.
            await completion.Task.ConfigureAwait(false);
        }
        finally
        {
            registration.Unregister(null);
        }
        return Qpc.Now - start;
    }

    private static SafeWaitHandle? CreateTimerHandle()
    {
        SafeWaitHandle handle = CreateWaitableTimerExW(IntPtr.Zero, null, CreateWaitableTimerHighResolution, TimerAllAccess);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();

        handle = CreateWaitableTimerExW(IntPtr.Zero, null, 0, TimerAllAccess);
        return handle.IsInvalid ? null : handle;
    }

    private static bool ProbeHighResolutionTimer()
    {
        using SafeWaitHandle probe = CreateWaitableTimerExW(IntPtr.Zero, null, CreateWaitableTimerHighResolution, TimerAllAccess);
        return !probe.IsInvalid;
    }

    public void Dispose() => _disposed = true;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle CreateWaitableTimerExW(
        IntPtr lpTimerAttributes,
        string? lpTimerName,
        uint dwFlags,
        uint dwDesiredAccess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWaitableTimer(
        SafeWaitHandle hTimer,
        ref long lpDueTime,
        int lPeriod,
        IntPtr pfnCompletionRoutine,
        IntPtr lpArgToCompletionRoutine,
        [MarshalAs(UnmanagedType.Bool)] bool fResume);
}

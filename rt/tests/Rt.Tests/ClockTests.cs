using System.Diagnostics;
using Rt.Core.Clocks;
using Rt.Windows;

namespace Rt.Tests;

/// <summary>
/// Task 1 clock tests: virtual-clock determinism first (raw ticks, deadlines, cancellation,
/// FIFO for equal deadlines, unix mapping), then the Windows QPC clock including a live
/// lateness-distribution smoke test. No wall-clock (DateTime.Now) dependency is allowed in
/// any scheduling path; the virtual tests prove determinism, the QPC tests prove bounded
/// best-effort lateness on this machine (never a hard real-time claim).
/// </summary>
public static class ClockTests
{
    private const long Freq10M = 10_000_000;

    [RtFact]
    public static void VirtualClock_Now_OnlyMovesViaAdvance()
    {
        var clock = new VirtualClock(Freq10M);
        Assert.Equal(0L, clock.Now, "virtual clock starts at initial ticks 0");
        Assert.Equal(Freq10M, clock.Frequency, "frequency is the constructor value");

        clock.Advance(1_000);
        long first = clock.Now;
        clock.Advance(2_500);
        Assert.Equal(3_500L, clock.Now, "Advance accumulates raw ticks");
        Assert.True(clock.Now >= first, "raw ticks are monotonic");

        clock.AdvanceTo(10_000);
        Assert.Equal(10_000L, clock.Now, "AdvanceTo sets absolute ticks");
        clock.Advance(0);
        Assert.Equal(10_000L, clock.Now, "Advance(0) is legal and a no-op");

        Assert.Throws<ArgumentOutOfRangeException>(() => clock.Advance(-1), "negative Advance is rejected");
        Assert.Throws<ArgumentOutOfRangeException>(() => clock.AdvanceTo(9_999), "AdvanceTo into the past is rejected");
    }

    [RtFact]
    public static async Task VirtualClock_WaitUntilAsync_DoesNotReturnBeforeDeadline()
    {
        var clock = new VirtualClock(Freq10M);
        long deadline = clock.Now + 5_000;

        ValueTask<WaitResult> wait = clock.WaitUntilAsync(deadline);
        Assert.False(wait.IsCompleted, "wait must stay pending before the deadline");
        Assert.Equal(1, clock.PendingWaiterCount, "one waiter is registered");
        Assert.Equal(deadline, clock.EarliestPendingDeadline, "earliest pending deadline is reported");

        clock.AdvanceTo(deadline);
        WaitResult result = await wait;
        Assert.Equal(deadline, result.Deadline, "result carries the requested deadline");
        Assert.Equal(deadline, result.ActualWake, "released exactly at the deadline");
        Assert.Equal(0L, result.LateTicks, "LateTicks is zero on exact release");
        Assert.Equal(0, clock.PendingWaiterCount, "waiter is removed after release");
        Assert.Null(clock.EarliestPendingDeadline, "no pending deadlines remain");
    }

    [RtFact]
    public static async Task VirtualClock_PastDeadline_CompletesImmediately()
    {
        var clock = new VirtualClock(Freq10M, initialTicks: 50_000);
        ValueTask<WaitResult> wait = clock.WaitUntilAsync(clock.Now - 1);
        Assert.True(wait.IsCompleted, "already-past deadline completes synchronously");
        WaitResult result = await wait;
        Assert.Equal(clock.Now, result.ActualWake, "ActualWake is the current virtual now");
        Assert.Equal(0, clock.PendingWaiterCount, "nothing was queued");
    }

    [RtFact]
    public static async Task VirtualClock_Advance_ReleasesOnlyDueWaiters()
    {
        var clock = new VirtualClock(Freq10M);
        long baseT = clock.Now;

        ValueTask<WaitResult> w1 = clock.WaitUntilAsync(baseT + 100);
        ValueTask<WaitResult> w2 = clock.WaitUntilAsync(baseT + 200);
        ValueTask<WaitResult> w3 = clock.WaitUntilAsync(baseT + 300);

        clock.AdvanceTo(baseT + 250);

        WaitResult r1 = await w1;
        WaitResult r2 = await w2;
        Assert.Equal(baseT + 250, r1.ActualWake, "due waiter wakes at the new now");
        Assert.Equal(baseT + 250, r2.ActualWake, "second due waiter wakes at the new now");
        Assert.Equal(50L, r2.LateTicks, "LateTicks = ActualWake - Deadline");
        Assert.False(w3.IsCompleted, "not-yet-due waiter stays pending");
        Assert.Equal(1, clock.PendingWaiterCount, "only the future waiter remains");
        Assert.Equal(baseT + 300, clock.EarliestPendingDeadline, "earliest pending deadline belongs to the remaining waiter");

        clock.Advance(50);
        WaitResult r3 = await w3;
        Assert.Equal(baseT + 300, r3.ActualWake, "remaining waiter wakes exactly at its deadline");
        Assert.Equal(0L, r3.TimerTicks, "virtual waits account zero timer ticks");
        Assert.Equal(0L, r3.SpinTicks, "virtual waits account zero spin ticks");
    }

    [RtFact]
    public static async Task VirtualClock_SameDeadline_WaitersReleasedInFifoOrder()
    {
        var clock = new VirtualClock(Freq10M);
        long deadline = clock.Now + 1_000;
        var order = new List<int>();

        Task t1 = Record(clock.WaitUntilAsync(deadline).AsTask(), 1, order);
        Task t2 = Record(clock.WaitUntilAsync(deadline).AsTask(), 2, order);
        Task t3 = Record(clock.WaitUntilAsync(deadline).AsTask(), 3, order);
        Assert.Equal(3, clock.PendingWaiterCount, "three waiters pending on the same deadline");

        clock.AdvanceTo(deadline);
        await Task.WhenAll(t1, t2, t3);

        lock (order)
        {
            Assert.Equal(3, order.Count, "all three continuations recorded");
            Assert.Equal(1, order[0], "equal deadlines release in registration order (FIFO) — first");
            Assert.Equal(2, order[1], "equal deadlines release in registration order (FIFO) — second");
            Assert.Equal(3, order[2], "equal deadlines release in registration order (FIFO) — third");
        }

        static Task Record(Task<WaitResult> wait, int id, List<int> order) =>
            wait.ContinueWith(_ => { lock (order) order.Add(id); },
                CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    [RtFact]
    public static async Task VirtualClock_Cancel_RemovesWaiterAndThrows()
    {
        var clock = new VirtualClock(Freq10M);
        using var cts = new CancellationTokenSource();
        long deadline = clock.Now + 10_000;

        Task<WaitResult> wait = clock.WaitUntilAsync(deadline, cts.Token).AsTask();
        Assert.Equal(1, clock.PendingWaiterCount, "waiter registered before cancel");

        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => wait, "cancelled waiter observes OperationCanceledException");
        Assert.Equal(0, clock.PendingWaiterCount, "cancelled waiter is removed from the queue");
        Assert.Null(clock.EarliestPendingDeadline, "no pending deadlines remain after cancel");

        clock.AdvanceTo(deadline); // must neither throw nor resurrect the cancelled waiter
        Assert.Equal(0, clock.PendingWaiterCount, "advancing past a cancelled deadline leaves the queue empty");
    }

    [RtFact]
    public static async Task VirtualClock_PreCancelledToken_ThrowsWithoutQueueing()
    {
        var clock = new VirtualClock(Freq10M);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => clock.WaitUntilAsync(clock.Now + 1_000, cts.Token).AsTask(),
            "pre-cancelled token cancels without queueing");
        Assert.Equal(0, clock.PendingWaiterCount, "nothing was queued for a pre-cancelled token");
    }

    [RtFact]
    public static void VirtualClock_UnixMapping_IsPureFunctionOfAnchorAndTicks()
    {
        var anchor = new DateTimeOffset(2026, 11, 7, 0, 0, 0, TimeSpan.Zero);
        var clock = new VirtualClock(Freq10M, initialTicks: 0, unixAnchor: anchor);

        Assert.Equal(anchor, clock.ToUnixTime(0), "tick 0 maps to the anchor");
        Assert.Equal(anchor.AddSeconds(1), clock.ToUnixTime(Freq10M), "one second of ticks maps to anchor + 1 s");
        Assert.Equal(anchor.AddTicks(1_234_567), clock.ToUnixTime(1_234_567), "sub-second mapping is exact at 10 MHz");
        Assert.Equal(Freq10M / 2, clock.FromUnixTime(anchor.AddMilliseconds(500)), "FromUnixTime inverts ToUnixTime");

        DateTimeOffset first = clock.ToUnixTime(123_456);
        Thread.Sleep(2);
        Assert.Equal(first, clock.ToUnixTime(123_456), "mapping never consults the wall clock — stable across real time");

        var defaultClock = new VirtualClock();
        Assert.Equal(10_000_000L, defaultClock.Frequency, "default frequency is 10 MHz");
        Assert.Equal(new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero), defaultClock.ToUnixTime(0), "default unix anchor is the epoch");
    }

    [RtFact]
    public static void Qpc_RawTicks_AreMonotonicAndConvertExactly()
    {
        Assert.Equal(Stopwatch.Frequency, Qpc.Frequency, "Qpc reports the performance-counter frequency");

        long previous = Qpc.Now;
        for (int i = 0; i < 10_000; i++)
        {
            long now = Qpc.Now;
            Assert.True(now >= previous, "raw QPC ticks never go backwards");
            previous = now;
        }

        long sample = Qpc.Now;
        TimeSpan span = Qpc.ToTimeSpan(sample);
        long back = Qpc.FromTimeSpan(span);
        Assert.LessOrEqual(Math.Abs(back - sample), 1L, "ToTimeSpan/FromTimeSpan round-trip within one tick");

        double ms = Qpc.ToMilliseconds(sample);
        long fromMs = Qpc.FromMilliseconds(ms);
        Assert.LessOrEqual(Math.Abs(fromMs - sample), Qpc.Frequency / 1_000, "millisecond round-trip within 1 ms worth of ticks");

        Assert.Equal(TimeSpan.FromSeconds(1), Qpc.ToTimeSpan(Qpc.Frequency), "one second of QPC ticks maps to exactly 1 s");
    }

    [RtFact]
    public static async Task QpcClock_WaitUntilAsync_DoesNotReturnEarly()
    {
        using var clock = new QpcClock();
        long deadline = clock.Now + Qpc.FromMilliseconds(30);
        WaitResult r = await clock.WaitUntilAsync(deadline);
        Assert.True(r.ActualWake >= deadline, "real clock must never return before the deadline");
        Assert.LessOrEqual(Qpc.ToMilliseconds(r.LateTicks), 20.0, "30 ms wait lands within 20 ms after the deadline on an idle machine");
        Assert.True(r.TimerTicks + r.SpinTicks > 0, "wait effort (timer + spin) is accounted in the result");
    }

    [RtFact]
    public static async Task QpcClock_PastDeadline_ReturnsImmediately()
    {
        using var clock = new QpcClock();
        long before = Qpc.Now;
        WaitResult r = await clock.WaitUntilAsync(clock.Now - 1_000);
        long after = Qpc.Now;
        Assert.True(r.ActualWake >= before && r.ActualWake <= after, "past-deadline wait completes without sleeping");
    }

    [RtFact]
    public static async Task QpcClock_WaitUntilAsync_HonoursCancellation()
    {
        using var clock = new QpcClock();
        using var cts = new CancellationTokenSource();
        long deadline = clock.Now + Qpc.FromMilliseconds(5_000);
        Task<WaitResult> wait = clock.WaitUntilAsync(deadline, cts.Token).AsTask();

        await Task.Delay(50);
        cts.Cancel();
        var stopwatch = Stopwatch.StartNew();
        await Assert.ThrowsAsync<OperationCanceledException>(() => wait, "cancelled QPC wait throws OperationCanceledException");
        stopwatch.Stop();
        Assert.LessOrEqual(stopwatch.ElapsedMilliseconds, 2_000L, "cancellation takes effect promptly, not at the deadline");
    }

    [RtFact]
    public static void QpcClock_UnixMapping_RoundTrips()
    {
        using var clock = new QpcClock();
        long now = clock.Now;
        DateTimeOffset unix = clock.ToUnixTime(now);
        Assert.LessOrEqual(Math.Abs(clock.FromUnixTime(unix) - now), Qpc.FromMilliseconds(1), "unix mapping round-trips within 1 ms");

        DateTimeOffset plusOneSecond = clock.ToUnixTime(now + clock.Frequency);
        long deltaTicks = (plusOneSecond - unix).Ticks;
        Assert.LessOrEqual(Math.Abs(deltaTicks - TimeSpan.TicksPerSecond), 2L, "one second of QPC ticks maps to 1 s of unix time (±2 ticks)");
    }

    [RtFact]
    public static async Task QpcClock_WaitAfterDispose_Throws()
    {
        var clock = new QpcClock();
        clock.Dispose();
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => clock.WaitUntilAsync(Qpc.Now + Qpc.FromMilliseconds(10)).AsTask(),
            "waiting on a disposed clock throws ObjectDisposedException");
    }

    [RtFact(Category = "timing")]
    public static async Task QpcClock_ScheduleWait_LatenessDistribution()
    {
        using var clock = new QpcClock();

        // Warm up JIT, the thread pool and the timer path before measuring.
        for (int i = 0; i < 20; i++)
            await clock.WaitUntilAsync(clock.Now + Qpc.FromMilliseconds(1));

        const int Iterations = 150;
        double[] lateUs = new double[Iterations];
        double[] timerUs = new double[Iterations];
        double[] spinUs = new double[Iterations];
        int resyncs = 0;

        long cursor = clock.Now + Qpc.FromMilliseconds(10);
        for (int i = 0; i < Iterations; i++)
        {
            WaitResult r = await clock.WaitUntilAsync(cursor);
            lateUs[i] = Qpc.ToMilliseconds(r.LateTicks) * 1_000.0;
            timerUs[i] = Qpc.ToMilliseconds(r.TimerTicks) * 1_000.0;
            spinUs[i] = Qpc.ToMilliseconds(r.SpinTicks) * 1_000.0;

            cursor += Qpc.FromMilliseconds(5);
            if (cursor - clock.Now < Qpc.FromMilliseconds(1))
            {
                // The schedule fell behind (huge outlier or preemption): re-sync and count it
                // honestly instead of silently measuring past-deadline no-ops.
                cursor = clock.Now + Qpc.FromMilliseconds(5);
                resyncs++;
            }
        }

        Array.Sort(lateUs);
        Array.Sort(timerUs);
        Array.Sort(spinUs);

        Console.WriteLine("       QpcClock smoke: high-resolution timer = " + clock.UsesHighResolutionTimer +
                          ", spin budget = " + clock.SpinBudget.TotalMilliseconds.ToString("F3") + " ms" +
                          ", iterations = " + Iterations + ", cursor stride = 5 ms, resyncs = " + resyncs);
        Console.WriteLine("       lateness  us: P50=" + Percentile(lateUs, 0.50).ToString("F1") +
                          " P95=" + Percentile(lateUs, 0.95).ToString("F1") +
                          " P99=" + Percentile(lateUs, 0.99).ToString("F1") +
                          " max=" + lateUs[Iterations - 1].ToString("F1"));
        Console.WriteLine("       timer wait us: P50=" + Percentile(timerUs, 0.50).ToString("F1") +
                          " P95=" + Percentile(timerUs, 0.95).ToString("F1") +
                          " P99=" + Percentile(timerUs, 0.99).ToString("F1") +
                          " max=" + timerUs[Iterations - 1].ToString("F1"));
        Console.WriteLine("       spin time  us: P50=" + Percentile(spinUs, 0.50).ToString("F1") +
                          " P95=" + Percentile(spinUs, 0.95).ToString("F1") +
                          " P99=" + Percentile(spinUs, 0.99).ToString("F1") +
                          " max=" + spinUs[Iterations - 1].ToString("F1"));

        Assert.LessOrEqual(Percentile(lateUs, 0.95), 1_000.0,
            "schedule-wait lateness P95 target <= 1 ms (best-effort on a non-realtime OS; data is kept and reported either way)");
    }

    private static double Percentile(double[] sortedAscending, double p)
    {
        int idx = (int)Math.Ceiling(p * sortedAscending.Length) - 1;
        return sortedAscending[Math.Clamp(idx, 0, sortedAscending.Length - 1)];
    }
}

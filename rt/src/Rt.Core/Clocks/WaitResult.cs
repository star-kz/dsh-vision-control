namespace Rt.Core.Clocks;

/// <summary>
/// What a scheduled wait actually cost. All values are raw clock ticks:
/// TimerTicks = time spent blocked in OS timers, SpinTicks = time spent in bounded spin.
/// </summary>
/// <param name="Deadline">The requested deadline.</param>
/// <param name="ActualWake">Raw tick value observed when the wait finished.</param>
/// <param name="TimerTicks">Ticks attributed to OS timer waits.</param>
/// <param name="SpinTicks">Ticks attributed to bounded spinning.</param>
public readonly record struct WaitResult(long Deadline, long ActualWake, long TimerTicks, long SpinTicks)
{
    /// <summary>How far after the deadline the wait actually returned (0 = exact, negative impossible by contract).</summary>
    public long LateTicks => ActualWake - Deadline;
}

using System.Diagnostics;

namespace Rt.Core.Clocks;

/// <summary>
/// Raw performance-counter (QPC) access and exact conversions. Static and allocation-free.
/// Conversions use decimal arithmetic so round-trips stay within one tick.
/// </summary>
public static class Qpc
{
    /// <summary>QPC ticks per second (Stopwatch.Frequency).</summary>
    public static long Frequency { get; } = Stopwatch.Frequency;

    /// <summary>Current raw QPC timestamp; monotonic, unaffected by wall-clock changes.</summary>
    public static long Now => Stopwatch.GetTimestamp();

    /// <summary>Convert a QPC tick count to the equivalent TimeSpan.</summary>
    public static TimeSpan ToTimeSpan(long qpcTicks) =>
        new((long)((decimal)qpcTicks * TimeSpan.TicksPerSecond / Frequency));

    /// <summary>Convert a TimeSpan to the equivalent QPC tick count.</summary>
    public static long FromTimeSpan(TimeSpan span) =>
        (long)((decimal)span.Ticks * Frequency / TimeSpan.TicksPerSecond);

    /// <summary>Convert a QPC tick count to milliseconds.</summary>
    public static double ToMilliseconds(long qpcTicks) => (double)qpcTicks * 1_000.0 / Frequency;

    /// <summary>Convert milliseconds to the equivalent QPC tick count.</summary>
    public static long FromMilliseconds(double milliseconds) =>
        (long)((decimal)milliseconds * Frequency / 1_000m);
}

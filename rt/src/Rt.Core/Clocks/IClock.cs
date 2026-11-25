namespace Rt.Core.Clocks;

/// <summary>
/// Time source contract: raw monotonic ticks plus pure conversions. Implementations must never
/// consult the wall clock for scheduling decisions; unix mapping is an explicit anchored function.
/// </summary>
public interface IClock
{
    /// <summary>Tick frequency (ticks per second) of <see cref="Now"/>.</summary>
    long Frequency { get; }

    /// <summary>Current raw tick value; monotonic, never adjusted.</summary>
    long Now { get; }

    /// <summary>Map a raw tick value to unix time using this clock's fixed anchor.</summary>
    DateTimeOffset ToUnixTime(long ticks);

    /// <summary>Inverse of <see cref="ToUnixTime"/> using this clock's fixed anchor.</summary>
    long FromUnixTime(DateTimeOffset unixTime);

    /// <summary>Convert a raw tick count (delta) to a TimeSpan.</summary>
    TimeSpan ToTimeSpan(long ticks);

    /// <summary>Convert a TimeSpan (delta) to raw ticks of this clock's frequency.</summary>
    long FromTimeSpan(TimeSpan span);
}

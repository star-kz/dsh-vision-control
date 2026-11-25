namespace Rt.Core.Clocks;

/// <summary>A clock that can suspend a caller until a raw-tick deadline.</summary>
public interface ISchedulableClock : IClock
{
    /// <summary>
    /// Wait until <paramref name="deadlineTicks"/> (raw clock ticks). Never returns before the
    /// deadline. Cancellation throws <see cref="OperationCanceledException"/>.
    /// </summary>
    ValueTask<WaitResult> WaitUntilAsync(long deadlineTicks, CancellationToken cancellationToken = default);
}

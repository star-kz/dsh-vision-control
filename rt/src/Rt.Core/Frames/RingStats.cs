namespace Rt.Core.Frames;

/// <summary>
/// Immutable snapshot of <see cref="FrameRing"/> counters. Publishes that find every slot leased are
/// counted as <see cref="Dropped"/> and consume no sequence number, so
/// <c>SeqHighWater == Published</c> always holds.
/// </summary>
public readonly record struct RingStats(
    long Published,
    long Dropped,
    long Overwritten,
    long SeqHighWater,
    int OutstandingLeases,
    long AcquireContentions,
    long EpochChanges);

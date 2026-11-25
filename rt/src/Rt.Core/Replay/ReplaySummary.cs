namespace Rt.Core.Replay;

/// <summary>Outcome of one <see cref="ReplayFramePublisher"/> run, in injected-clock ticks.</summary>
public readonly record struct ReplaySummary(
    int FramesRead,
    int Published,
    int Dropped,
    int EpochChanges,
    long FirstSequence,
    long LastSequence,
    long StartClock,
    long EndClock);

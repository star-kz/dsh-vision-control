namespace Rt.Core.Replay;

/// <summary>How a replay paces its frames.</summary>
public enum ReplaySpeedMode
{
    /// <summary>Frames are published at their recorded capture offsets, paced by the injected clock.</summary>
    OriginalTimeline = 0,

    /// <summary>Frames are published back-to-back with no waiting; still fully deterministic.</summary>
    AsFastAsPossible = 1,
}

namespace Rt.Core.Contracts;

/// <summary>Immutable metadata for one published frame. Versioned for cross-process logs.</summary>
public readonly record struct FrameMeta(
    long Sequence,
    string SourceId,
    long SourceEpoch,
    long CapturedQpc,
    long ReceivedQpc,
    int Width,
    int Height,
    FramePixelFormat Format)
{
    /// <summary>Schema version for serialized forms; bump on any field change.</summary>
    public const int SchemaVersion = 1;
}

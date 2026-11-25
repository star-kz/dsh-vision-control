using Rt.Core.Contracts;

namespace Rt.Core.Replay;

/// <summary>
/// One recorded frame in a deterministic replay file: the source epoch it belonged to,
/// its capture offset from the start of the recording, geometry/format metadata and the raw payload.
/// </summary>
public sealed record ReplayFrame(
    long SourceEpoch,
    TimeSpan CaptureOffset,
    string SourceId,
    int Width,
    int Height,
    FramePixelFormat Format,
    byte[] Payload)
{
    public const int SchemaVersion = 1;

    /// <summary>Byte-exact payload comparison (record equality would only compare array references).</summary>
    public bool PayloadEquals(ReplayFrame? other) =>
        other is not null
        && Payload.Length == other.Payload.Length
        && Payload.AsSpan().SequenceEqual(other.Payload);
}

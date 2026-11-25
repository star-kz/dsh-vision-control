using Rt.Core.Contracts;

namespace Rt.Windows.Capture;

public enum CaptureFrameOrigin : byte
{
    WindowsGraphicsCapture = 1,
    DxgiDesktopDuplication = 2,
}

public enum CaptureSnapshotFormat : byte
{
    /// <summary>Tightly packed, row-major B,G,R,A bytes; no file container or static-image fallback.</summary>
    Bgra32Raw = 1,
}

/// <summary>One immutable-by-convention latest-frame publication from the real WGC producer.</summary>
public sealed class ShadowCaptureFrame
{
    public ShadowCaptureFrame(
        FrameMeta metadata,
        CaptureGeometry geometry,
        ReadOnlyMemory<byte> pixels,
        CaptureFrameOrigin origin)
    {
        ArgumentNullException.ThrowIfNull(geometry);
        if (metadata.Format != FramePixelFormat.Bgra32)
            throw new ArgumentException("Shadow capture publishes BGRA32 only.", nameof(metadata));
        if (metadata.Width != geometry.RoiPixels.Width || metadata.Height != geometry.RoiPixels.Height)
            throw new ArgumentException("Frame metadata dimensions must match the physical ROI.", nameof(metadata));
        int expectedLength = checked(metadata.Width * metadata.Height * 4);
        if (pixels.Length != expectedLength)
            throw new ArgumentException($"Expected {expectedLength} tightly packed BGRA bytes, got {pixels.Length}.", nameof(pixels));
        Metadata = metadata;
        Geometry = geometry;
        Pixels = pixels;
        Origin = origin;
    }

    public FrameMeta Metadata { get; }
    public CaptureGeometry Geometry { get; }
    public ReadOnlyMemory<byte> Pixels { get; }
    public CaptureFrameOrigin Origin { get; }
}

/// <summary>A detached slow-loop copy. It has no file container and is never synthesized from a static screenshot.</summary>
public sealed record CaptureSnapshot(
    FrameMeta Metadata,
    CaptureGeometry Geometry,
    ReadOnlyMemory<byte> Pixels,
    int StrideBytes,
    CaptureSnapshotFormat Format,
    CaptureFrameOrigin Origin);

/// <summary>Single-slot latest-frame coalescing for native producers and slow snapshot consumers.</summary>
public sealed class LatestCaptureFrameBuffer
{
    private readonly CaptureEpochTracker _epochs;
    private readonly Func<ReadOnlyMemory<byte>, byte[]> _pixelCopier;
    private readonly object _sync = new();
    private ShadowCaptureFrame? _latest;

    public LatestCaptureFrameBuffer(CaptureEpochTracker epochs)
        : this(epochs, static pixels => pixels.ToArray()) { }

    internal LatestCaptureFrameBuffer(
        CaptureEpochTracker epochs,
        Func<ReadOnlyMemory<byte>, byte[]> pixelCopier)
    {
        _epochs = epochs ?? throw new ArgumentNullException(nameof(epochs));
        _pixelCopier = pixelCopier ?? throw new ArgumentNullException(nameof(pixelCopier));
    }

    /// <summary>
    /// Called synchronously after the buffer lock is released. Handlers must be fast and non-blocking;
    /// schedule slow work elsewhere and recheck SourceEpoch when consuming, scheduling and executing it.
    /// </summary>
    public event Action<ShadowCaptureFrame>? FrameAvailable;

    public ShadowCaptureFrame? Latest
    {
        get
        {
            lock (_sync)
            {
                if (_latest is not null && !_epochs.IsCurrent(_latest.Metadata.SourceEpoch)) _latest = null;
                return _latest;
            }
        }
    }

    public bool Publish(ShadowCaptureFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);
        lock (_sync)
        {
            if (!_epochs.IsCurrent(frame.Metadata.SourceEpoch)) return false;
            if (_latest is { } latest &&
                latest.Metadata.SourceEpoch == frame.Metadata.SourceEpoch &&
                frame.Metadata.Sequence <= latest.Metadata.Sequence)
                return false;
            _latest = frame;
        }

        if (_epochs.IsCurrent(frame.Metadata.SourceEpoch)) FrameAvailable?.Invoke(frame);
        return true;
    }

    public CaptureSnapshot? CopyLatestSnapshot()
    {
        ShadowCaptureFrame? frame;
        lock (_sync)
        {
            if (_latest is null || !_epochs.IsCurrent(_latest.Metadata.SourceEpoch))
            {
                _latest = null;
                return null;
            }
            frame = _latest;
        }

        // Producers own a fresh byte[] for every frame, so copying the retained reference cannot race texture readback.
        // Do not hold the epoch or buffer lock across this potentially large copy.
        byte[] copy = _pixelCopier(frame.Pixels);
        // Snapshot linearization point: this post-copy epoch check. Any invalidation observed here
        // rejects the copy. A later invalidation is a subsequent race, so every consumer/scheduler/
        // executor must recheck SourceEpoch instead of treating this snapshot as permanently valid.
        if (!_epochs.IsCurrent(frame.Metadata.SourceEpoch)) return null;
        return new CaptureSnapshot(
            frame.Metadata,
            frame.Geometry,
            copy,
            checked(frame.Metadata.Width * 4),
            CaptureSnapshotFormat.Bgra32Raw,
            frame.Origin);
    }
}

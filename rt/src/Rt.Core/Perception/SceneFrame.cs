using Rt.Core.Contracts;

namespace Rt.Core.Perception;

/// <summary>A validated, tightly described BGRA view. The caller retains ownership of the pixel memory.</summary>
public readonly struct SceneFrame
{
    public SceneFrame(FrameMeta meta, ReadOnlyMemory<byte> bgra, int strideBytes)
    {
        if (meta.Format != FramePixelFormat.Bgra32)
            throw new ArgumentException("The classic scene adapter requires BGRA32 pixels.", nameof(meta));
        if (meta.Width <= 0 || meta.Height <= 0)
            throw new ArgumentOutOfRangeException(nameof(meta), "Frame dimensions must be positive.");
        int rowBytes = checked(meta.Width * 4);
        if (strideBytes < rowBytes)
            throw new ArgumentOutOfRangeException(nameof(strideBytes), "Stride is smaller than one BGRA row.");
        int required = checked((meta.Height - 1) * strideBytes + rowBytes);
        if (bgra.Length < required)
            throw new ArgumentException("The BGRA buffer is truncated.", nameof(bgra));
        Meta = meta;
        Bgra = bgra;
        StrideBytes = strideBytes;
    }

    public FrameMeta Meta { get; }
    public ReadOnlyMemory<byte> Bgra { get; }
    public int StrideBytes { get; }
}

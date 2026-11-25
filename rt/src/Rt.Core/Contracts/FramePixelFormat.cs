namespace Rt.Core.Contracts;

/// <summary>Wire-stable pixel formats. Values must never be renumbered.</summary>
public enum FramePixelFormat : byte
{
    Unknown = 0,
    Bgra32 = 1,
    Rgba32 = 2,
    Gray8 = 3,
}

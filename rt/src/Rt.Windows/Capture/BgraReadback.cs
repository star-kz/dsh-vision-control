using System.Runtime.InteropServices;

namespace Rt.Windows.Capture;

/// <summary>Converts a D3D11 mapped BGRA texture to the stable, tightly packed ROI representation.</summary>
internal static class BgraReadback
{
    internal static byte[] CopyRoi(
        byte[] source,
        int sourceWidth,
        int sourceHeight,
        int sourceStrideBytes,
        CapturePixelRect roi)
    {
        ArgumentNullException.ThrowIfNull(source);
        Validate(sourceWidth, sourceHeight, sourceStrideBytes, roi, source.Length);
        byte[] destination = new byte[checked(roi.Width * roi.Height * 4)];
        int rowBytes = roi.Width * 4;
        for (int y = 0; y < roi.Height; y++)
            Buffer.BlockCopy(source, (roi.Y + y) * sourceStrideBytes + roi.X * 4, destination, y * rowBytes, rowBytes);
        return destination;
    }

    internal static byte[] CopyRoi(
        nint source,
        int sourceWidth,
        int sourceHeight,
        int sourceStrideBytes,
        CapturePixelRect roi)
    {
        if (source == 0) throw new ArgumentNullException(nameof(source));
        Validate(sourceWidth, sourceHeight, sourceStrideBytes, roi, sourceLength: null);
        byte[] destination = new byte[checked(roi.Width * roi.Height * 4)];
        int rowBytes = roi.Width * 4;
        for (int y = 0; y < roi.Height; y++)
        {
            nint row = nint.Add(source, (roi.Y + y) * sourceStrideBytes + roi.X * 4);
            Marshal.Copy(row, destination, y * rowBytes, rowBytes);
        }
        return destination;
    }

    private static void Validate(
        int sourceWidth,
        int sourceHeight,
        int sourceStrideBytes,
        CapturePixelRect roi,
        int? sourceLength)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sourceWidth);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sourceHeight);
        int fullRowBytes = checked(sourceWidth * 4);
        if (sourceStrideBytes < fullRowBytes)
            throw new ArgumentException("Native BGRA row pitch cannot be smaller than a full row.", nameof(sourceStrideBytes));
        if (roi.X < 0 || roi.Y < 0 || roi.Width <= 0 || roi.Height <= 0 ||
            roi.X + roi.Width > sourceWidth || roi.Y + roi.Height > sourceHeight)
            throw new ArgumentOutOfRangeException(nameof(roi), "ROI must lie inside the native texture.");
        if (sourceLength is { } length)
        {
            int required = checked((sourceHeight - 1) * sourceStrideBytes + fullRowBytes);
            if (length < required) throw new ArgumentException("The mapped BGRA buffer is truncated.", nameof(sourceLength));
        }
    }
}

using System.Buffers.Binary;
using System.Runtime.InteropServices;
using SharpDX.DXGI;

namespace Rt.Windows.Capture;

/// <summary>
/// Converts real DXGI Desktop Duplication pixels to the common tight BGRA representation.
/// HDR/scRGB half-float frames are linearly converted and clipped to SDR; HDR metadata is not preserved.
/// </summary>
internal static class DxgiReadback
{
    internal static byte[] CopyRoi(
        byte[] source,
        int sourceWidth,
        int sourceHeight,
        int sourceStrideBytes,
        CapturePixelRect roi,
        Format format)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (format == Format.B8G8R8A8_UNorm || format == Format.B8G8R8A8_UNorm_SRgb)
            return BgraReadback.CopyRoi(source, sourceWidth, sourceHeight, sourceStrideBytes, roi);
        ValidateFloat(sourceWidth, sourceHeight, sourceStrideBytes, roi, source.Length);
        byte[] destination = new byte[checked(roi.Width * roi.Height * 4)];
        for (int y = 0; y < roi.Height; y++)
        {
            int sourceOffset = (roi.Y + y) * sourceStrideBytes + roi.X * 8;
            ConvertFloatRow(source.AsSpan(sourceOffset, roi.Width * 8), destination.AsSpan(y * roi.Width * 4, roi.Width * 4));
        }
        return destination;
    }

    internal static byte[] CopyRoi(
        nint source,
        int sourceWidth,
        int sourceHeight,
        int sourceStrideBytes,
        CapturePixelRect roi,
        Format format)
    {
        if (source == 0) throw new ArgumentNullException(nameof(source));
        if (format == Format.B8G8R8A8_UNorm || format == Format.B8G8R8A8_UNorm_SRgb)
            return BgraReadback.CopyRoi(source, sourceWidth, sourceHeight, sourceStrideBytes, roi);
        if (format != Format.R16G16B16A16_Float)
            throw new NotSupportedException($"DXGI Desktop Duplication format {format} is not a supported BGRA/scRGB stream.");
        ValidateFloat(sourceWidth, sourceHeight, sourceStrideBytes, roi, sourceLength: null);
        byte[] destination = new byte[checked(roi.Width * roi.Height * 4)];
        byte[] nativeRow = new byte[checked(roi.Width * 8)];
        int destinationStride = roi.Width * 4;
        for (int y = 0; y < roi.Height; y++)
        {
            nint native = nint.Add(source, (roi.Y + y) * sourceStrideBytes + roi.X * 8);
            Marshal.Copy(native, nativeRow, 0, nativeRow.Length);
            ConvertFloatRow(nativeRow, destination.AsSpan(y * destinationStride, destinationStride));
        }
        return destination;
    }

    private static void ConvertFloatRow(ReadOnlySpan<byte> source, Span<byte> destination)
    {
        for (int x = 0; x < destination.Length / 4; x++)
        {
            int sourceOffset = x * 8;
            destination[x * 4] = LinearToSrgbByte(ReadHalf(source, sourceOffset + 4));
            destination[x * 4 + 1] = LinearToSrgbByte(ReadHalf(source, sourceOffset + 2));
            destination[x * 4 + 2] = LinearToSrgbByte(ReadHalf(source, sourceOffset));
            destination[x * 4 + 3] = UnitToByte(ReadHalf(source, sourceOffset + 6));
        }
    }

    private static float ReadHalf(ReadOnlySpan<byte> source, int offset) =>
        (float)BitConverter.UInt16BitsToHalf(BinaryPrimitives.ReadUInt16LittleEndian(source.Slice(offset, 2)));

    private static byte LinearToSrgbByte(float linear)
    {
        if (float.IsNaN(linear) || linear <= 0) return 0;
        if (linear >= 1) return 255;
        double srgb = linear <= 0.0031308f
            ? linear * 12.92
            : 1.055 * Math.Pow(linear, 1.0 / 2.4) - 0.055;
        return UnitToByte((float)srgb);
    }

    private static byte UnitToByte(float value)
    {
        if (float.IsNaN(value) || value <= 0) return 0;
        if (value >= 1) return 255;
        return (byte)Math.Clamp((int)MathF.Round(value * 255f), 0, 255);
    }

    private static void ValidateFloat(int width, int height, int stride, CapturePixelRect roi, int? sourceLength)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(width);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(height);
        int fullRowBytes = checked(width * 8);
        if (stride < fullRowBytes) throw new ArgumentException("Native RGBA16F row pitch is truncated.", nameof(stride));
        if (roi.X < 0 || roi.Y < 0 || roi.Width <= 0 || roi.Height <= 0 ||
            roi.X + roi.Width > width || roi.Y + roi.Height > height)
            throw new ArgumentOutOfRangeException(nameof(roi), "ROI must lie inside the native DXGI texture.");
        if (sourceLength is { } length && length < checked((height - 1) * stride + fullRowBytes))
            throw new ArgumentException("The mapped RGBA16F buffer is truncated.", nameof(sourceLength));
    }
}

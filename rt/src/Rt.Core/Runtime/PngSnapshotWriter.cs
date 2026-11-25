using System.Buffers.Binary;
using System.IO.Compression;

namespace Rt.Core.Runtime;

/// <summary>Bounded BGRA-to-RGBA PNG encoding and same-directory atomic replacement. Pixel bytes never enter JSON.</summary>
public static class PngSnapshotWriter
{
    private static readonly byte[] Signature = [137, 80, 78, 71, 13, 10, 26, 10];
    public const int MaximumPixelBytes = 64 * 1024 * 1024;

    public static async Task WriteAtomicAsync(string path, int width, int height, int strideBytes,
        ReadOnlyMemory<byte> bgra, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (width <= 0 || height <= 0) throw new InvalidDataException("snapshot dimensions must be positive");
        int rowBytes = checked(width * 4);
        int required = checked((height - 1) * strideBytes + rowBytes);
        if (strideBytes < rowBytes || required > MaximumPixelBytes || bgra.Length < required)
            throw new InvalidDataException("snapshot BGRA buffer is invalid or exceeds the bounded pixel limit");
        string fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        string temporary = fullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] raw = EncodeRgbaScanlines(bgra, width, height, strideBytes);
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                64 * 1024, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(Signature, cancellationToken);
                byte[] ihdr = new byte[13];
                BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(0), width);
                BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), height);
                ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
                await WriteChunk(stream, "IHDR", ihdr, cancellationToken);
                using var compressed = new MemoryStream();
                await using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                    await zlib.WriteAsync(raw, cancellationToken);
                await WriteChunk(stream, "IDAT", compressed.ToArray(), cancellationToken);
                await WriteChunk(stream, "IEND", [], cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(true);
            }
            if (File.Exists(fullPath)) File.Replace(temporary, fullPath, null);
            else File.Move(temporary, fullPath);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static byte[] EncodeRgbaScanlines(ReadOnlyMemory<byte> bgra, int width, int height, int strideBytes)
    {
        int rowBytes = checked(width * 4);
        byte[] raw = new byte[checked((rowBytes + 1) * height)];
        for (int y = 0; y < height; y++)
        {
            int destination = y * (rowBytes + 1);
            raw[destination] = 0;
            ReadOnlySpan<byte> source = bgra.Span.Slice(y * strideBytes, rowBytes);
            for (int x = 0; x < width; x++)
            {
                int s = x * 4;
                int d = destination + 1 + s;
                raw[d] = source[s + 2];
                raw[d + 1] = source[s + 1];
                raw[d + 2] = source[s];
                raw[d + 3] = source[s + 3];
            }
        }
        return raw;
    }

    private static async Task WriteChunk(Stream stream, string type, byte[] data, CancellationToken cancellationToken)
    {
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
        await stream.WriteAsync(length, cancellationToken);
        byte[] typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        await stream.WriteAsync(typeBytes, cancellationToken);
        await stream.WriteAsync(data, cancellationToken);
        uint crc = uint.MaxValue;
        foreach (byte value in typeBytes) crc = Step(crc, value);
        foreach (byte value in data) crc = Step(crc, value);
        byte[] crcBytes = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(crcBytes, ~crc);
        await stream.WriteAsync(crcBytes, cancellationToken);
    }

    private static uint Step(uint crc, byte value)
    {
        crc ^= value;
        for (int i = 0; i < 8; i++) crc = (crc & 1) != 0 ? 0xedb88320U ^ (crc >> 1) : crc >> 1;
        return crc;
    }
}

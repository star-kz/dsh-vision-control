using System.Buffers.Binary;
using Rt.Core.Tracing;

namespace Rt.Core.Runtime;

public sealed record TraceReadPage(IReadOnlyList<TraceEnvelope> Records, long NextOffset, bool Done);

public static class TraceStreamReader
{
    public const int MaximumPageRecords = 256;
    public const int MaximumPageBytes = 256 * 1024;

    public static TraceReadPage ReadPage(string path, string allowedRoot, long offset, int limit, int maxBytes)
    {
        if (limit <= 0 || limit > MaximumPageRecords) throw new ArgumentOutOfRangeException(nameof(limit));
        if (maxBytes <= 0 || maxBytes > MaximumPageBytes) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        if (offset < 0) throw new ArgumentOutOfRangeException(nameof(offset));
        string fullPath = Path.GetFullPath(path);
        string root = Path.GetFullPath(allowedRoot);
        string parent = Path.GetDirectoryName(fullPath) ?? string.Empty;
        if (!string.Equals(parent.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("trace path must be an immediate child of the configured Worker allowlist directory");
        using var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (offset > stream.Length) throw new ArgumentOutOfRangeException(nameof(offset));
        stream.Position = offset;
        var records = new List<TraceEnvelope>();
        int consumed = 0;
        while (records.Count < limit && stream.Position < stream.Length)
        {
            long recordStart = stream.Position;
            byte[] prefixBytes = new byte[4];
            ReadExact(stream, prefixBytes);
            int length = BinaryPrimitives.ReadInt32LittleEndian(prefixBytes);
            if (length < 12 || length > TraceFile.MaximumRecordBytes) throw new InvalidDataException($"invalid record length {length} at offset {recordStart}");
            int total = checked(length + 4);
            if (consumed + total > maxBytes)
            {
                if (records.Count == 0) throw new InvalidDataException($"one trace record exceeds page byte budget {maxBytes}");
                stream.Position = recordStart;
                break;
            }
            byte[] encoded = new byte[total];
            prefixBytes.CopyTo(encoded, 0);
            ReadExact(stream, encoded.AsSpan(4));
            // Reuse the canonical strict RTTR parser, including magic/schema/envelope validation and CRC32.
            records.Add(TraceFile.Read(new MemoryStream(encoded, writable: false)).Single());
            consumed += total;
        }
        return new TraceReadPage(records, stream.Position, stream.Position == stream.Length);
    }

    private static void ReadExact(Stream stream, Span<byte> destination)
    {
        int read = 0;
        while (read < destination.Length)
        {
            int count = stream.Read(destination[read..]);
            if (count == 0) throw new EndOfStreamException("truncated RTTR record");
            read += count;
        }
    }
    private static void ReadExact(Stream stream, byte[] destination) => ReadExact(stream, destination.AsSpan());
}

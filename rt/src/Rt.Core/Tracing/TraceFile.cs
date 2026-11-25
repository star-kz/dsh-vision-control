using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace Rt.Core.Tracing;

/// <summary>
/// Strict RTTR schema-1 reader/writer. Every record is
/// [int32 length][magic RTTR][int32 schema][JSON envelope][uint32 CRC32].
/// Length includes everything after the prefix; CRC covers magic through JSON, excluding itself.
/// </summary>
public static class TraceFile
{
    public const int SchemaVersion = 1;
    public const int MaximumRecordBytes = 16 * 1024 * 1024;
    private static readonly byte[] Magic = "RTTR"u8.ToArray();

    public static byte[] Encode(TraceEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        byte[] json;
        using (var buffer = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteString("kind", envelope.Kind);
                writer.WriteNumber("sequence", envelope.Sequence);
                writer.WriteNumber("timestampQpc", envelope.TimestampQpc);
                writer.WritePropertyName("payload");
                envelope.Payload.WriteTo(writer);
                if (envelope.Extensions is JsonElement extensions)
                {
                    writer.WritePropertyName("extensions");
                    extensions.WriteTo(writer);
                }
                writer.WriteEndObject();
            }
            json = buffer.ToArray();
        }

        int length = checked(Magic.Length + sizeof(int) + json.Length + sizeof(uint));
        if (length > MaximumRecordBytes)
            throw new InvalidDataException($"record length {length} exceeds the {MaximumRecordBytes}-byte limit");
        byte[] bytes = new byte[checked(length + sizeof(int))];
        BinaryPrimitives.WriteInt32LittleEndian(bytes, length);
        Magic.CopyTo(bytes, sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(8), SchemaVersion);
        json.CopyTo(bytes, 12);
        uint crc = Crc32.Compute(bytes.AsSpan(4, bytes.Length - 8));
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(bytes.Length - 4), crc);
        return bytes;
    }

    public static void Write(string path, IEnumerable<TraceEnvelope> envelopes)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        ArgumentNullException.ThrowIfNull(envelopes);
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        foreach (TraceEnvelope envelope in envelopes)
        {
            byte[] record = Encode(envelope);
            stream.Write(record, 0, record.Length);
        }
    }

    public static IReadOnlyList<TraceEnvelope> Read(string path)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Read(stream);
    }

    public static IReadOnlyList<TraceEnvelope> Read(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var records = new List<TraceEnvelope>();
        byte[] prefix = new byte[4];
        int recordIndex = 0;
        while (true)
        {
            int prefixBytes = ReadPrefix(stream, prefix);
            if (prefixBytes == 0)
            {
                if (recordIndex == 0) throw new InvalidDataException("truncated trace: no records");
                return records;
            }
            if (prefixBytes != prefix.Length)
                throw new InvalidDataException($"truncated length prefix at record {recordIndex}");

            int length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
            if (length < 12 || length > MaximumRecordBytes)
                throw new InvalidDataException($"invalid record length {length} at record {recordIndex}");
            byte[] record = new byte[length];
            ReadBody(stream, record, recordIndex);

            if (!record.AsSpan(0, 4).SequenceEqual(Magic))
                throw new InvalidDataException($"bad trace magic at record {recordIndex}");
            int version = BinaryPrimitives.ReadInt32LittleEndian(record.AsSpan(4));
            if (version != SchemaVersion)
                throw new InvalidDataException($"unsupported trace version {version} at record {recordIndex}; expected {SchemaVersion}");
            uint expected = Crc32.Compute(record.AsSpan(0, record.Length - 4));
            uint actual = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(record.Length - 4));
            if (expected != actual)
                throw new InvalidDataException($"trace checksum mismatch at record {recordIndex}: expected {expected:x8}, found {actual:x8}");

            try
            {
                records.Add(ParseEnvelope(record.AsMemory(8, record.Length - 12)));
            }
            catch (InvalidDataException) { throw; }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException or OverflowException)
            {
                throw new InvalidDataException($"invalid trace envelope at record {recordIndex}", ex);
            }
            recordIndex++;
        }
    }

    private static TraceEnvelope ParseEnvelope(ReadOnlyMemory<byte> json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("trace envelope root must be an object");
        if (!root.TryGetProperty("kind", out JsonElement kindElement) || kindElement.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("trace envelope kind must be a string");
        string kind = kindElement.GetString()!;
        if (string.IsNullOrWhiteSpace(kind)) throw new InvalidDataException("trace envelope kind cannot be empty");
        if (!root.TryGetProperty("sequence", out JsonElement sequence) || !sequence.TryGetInt64(out long sequenceValue))
            throw new InvalidDataException("trace envelope sequence must be an Int64");
        if (!root.TryGetProperty("timestampQpc", out JsonElement timestamp) || !timestamp.TryGetInt64(out long timestampValue))
            throw new InvalidDataException("trace envelope timestampQpc must be an Int64");
        if (!root.TryGetProperty("payload", out JsonElement payload))
            throw new InvalidDataException("trace envelope payload is required");
        JsonElement? extensions = null;
        if (root.TryGetProperty("extensions", out JsonElement extension))
        {
            if (extension.ValueKind is not JsonValueKind.Object and not JsonValueKind.Null)
                throw new InvalidDataException("trace envelope extensions must be an object or null");
            extensions = extension.Clone();
        }
        return new TraceEnvelope(kind, sequenceValue, timestampValue, payload.Clone(), extensions);
    }

    private static int ReadPrefix(Stream stream, byte[] prefix)
    {
        int total = 0;
        while (total < prefix.Length)
        {
            int read = stream.Read(prefix, total, prefix.Length - total);
            if (read == 0) return total;
            total += read;
        }
        return total;
    }

    private static void ReadBody(Stream stream, byte[] body, int recordIndex)
    {
        int total = 0;
        while (total < body.Length)
        {
            int read = stream.Read(body, total, body.Length - total);
            if (read == 0) throw new InvalidDataException($"truncated record {recordIndex}: needed {body.Length} bytes, found {total}");
            total += read;
        }
    }
}

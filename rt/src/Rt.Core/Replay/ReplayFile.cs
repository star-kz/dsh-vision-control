using System.Text;
using Rt.Core.Contracts;

namespace Rt.Core.Replay;

/// <summary>
/// Binary container for <see cref="ReplayFrame"/> sequences: "RTRP" magic, uint16 schema version,
/// int32 frame count, then per frame (int64 epoch, int64 offset ticks, length-prefixed UTF-8 source id,
/// int32 width, int32 height, byte format, int32 payload length, payload). Read validates every header
/// and field and rejects corrupt or truncated files with <see cref="InvalidDataException"/>.
/// Writing the same parsed frames twice yields byte-identical files.
/// </summary>
public static class ReplayFile
{
    public const string Magic = "RTRP";
    public const ushort SchemaVersion = 1;
    public const int MaxFrameCount = 16_000_000;
    public const int MaxPayloadBytes = 256 * 1024 * 1024;

    public static void Write(string path, IReadOnlyList<ReplayFrame> frames)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        ArgumentNullException.ThrowIfNull(frames);

        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        using var writer = new BinaryWriter(stream, new UTF8Encoding(false, true), leaveOpen: false);

        writer.Write(Encoding.ASCII.GetBytes(Magic));
        writer.Write(SchemaVersion);
        writer.Write(frames.Count);
        foreach (ReplayFrame frame in frames)
        {
            ArgumentNullException.ThrowIfNull(frame);
            writer.Write(frame.SourceEpoch);
            writer.Write(frame.CaptureOffset.Ticks);
            writer.Write(frame.SourceId); // 7-bit-length-prefixed UTF-8
            writer.Write(frame.Width);
            writer.Write(frame.Height);
            writer.Write((byte)frame.Format);
            writer.Write(frame.Payload.Length);
            writer.Write(frame.Payload);
        }
        writer.Flush();
    }

    public static IReadOnlyList<ReplayFrame> Read(string path)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            using var reader = new BinaryReader(stream, new UTF8Encoding(false, true), leaveOpen: false);

            string magic = Encoding.ASCII.GetString(ReadExact(reader, 4));
            if (magic != Magic)
            {
                throw new InvalidDataException($"Bad replay file magic '{magic}' (expected '{Magic}').");
            }

            ushort version = reader.ReadUInt16();
            if (version != SchemaVersion)
            {
                throw new InvalidDataException($"Unsupported replay file version {version} (expected {SchemaVersion}).");
            }

            int count = reader.ReadInt32();
            if (count < 0 || count > MaxFrameCount)
            {
                throw new InvalidDataException($"Replay frame count {count} out of range 0..{MaxFrameCount}.");
            }

            var frames = new List<ReplayFrame>(count);
            for (int i = 0; i < count; i++)
            {
                long epoch = reader.ReadInt64();
                long offsetTicks = reader.ReadInt64();
                string sourceId = reader.ReadString();
                int width = reader.ReadInt32();
                int height = reader.ReadInt32();
                byte format = reader.ReadByte();
                int payloadLength = reader.ReadInt32();

                if (epoch < 1)
                {
                    throw new InvalidDataException($"Frame {i}: source epoch {epoch} must be >= 1.");
                }
                if (offsetTicks < 0)
                {
                    throw new InvalidDataException($"Frame {i}: capture offset ticks {offsetTicks} must be >= 0.");
                }
                if (width < 0 || height < 0)
                {
                    throw new InvalidDataException($"Frame {i}: geometry {width}x{height} is invalid.");
                }
                if (!Enum.IsDefined(typeof(FramePixelFormat), format))
                {
                    throw new InvalidDataException($"Frame {i}: unknown pixel format {format}.");
                }
                if (payloadLength < 0 || payloadLength > MaxPayloadBytes)
                {
                    throw new InvalidDataException($"Frame {i}: payload length {payloadLength} out of range 0..{MaxPayloadBytes}.");
                }

                byte[] payload = ReadExact(reader, payloadLength);
                frames.Add(new ReplayFrame(epoch, new TimeSpan(offsetTicks), sourceId, width, height, (FramePixelFormat)format, payload));
            }

            if (stream.Position != stream.Length)
            {
                throw new InvalidDataException($"Replay file has {stream.Length - stream.Position} trailing byte(s).");
            }

            return frames;
        }
        catch (EndOfStreamException)
        {
            throw new InvalidDataException("Replay file is truncated.");
        }
    }

    private static byte[] ReadExact(BinaryReader reader, int byteCount)
    {
        byte[] buffer = reader.ReadBytes(byteCount);
        if (buffer.Length != byteCount)
        {
            throw new InvalidDataException($"Replay file is truncated (expected {byteCount} bytes, got {buffer.Length}).");
        }
        return buffer;
    }
}

using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Rt.Core.Tracing;

namespace Rt.Tests;

/// <summary>Task 4 RED: versioned/checksummed envelopes and loss-bounded asynchronous recording.</summary>
public static class TraceTests
{
    private static readonly string[] RequiredKinds =
        { "Frame", "Detections", "Tracks", "Plan", "Receipt", "Gate", "EStop" };

    private static string TempDir()
    {
        string dir = Path.Combine(Path.GetTempPath(), "rt-trace-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static TraceEnvelope Envelope(string kind, long sequence, string payload = "{\"value\":7}") =>
        new(kind, sequence, sequence * 10 + 3,
            JsonDocument.Parse(payload).RootElement.Clone(),
            JsonDocument.Parse("{\"vendor.extension\":{\"enabled\":true}}").RootElement.Clone());

    [RtFact]
    public static void TraceFile_RoundTripsRequiredAndExtensionEnvelopes_ByteStable()
    {
        string dir = TempDir();
        try
        {
            string path = Path.Combine(dir, "roundtrip.rtt");
            var envelopes = RequiredKinds.Select((kind, i) => Envelope(kind, i)).ToArray();
            TraceFile.Write(path, envelopes);
            IReadOnlyList<TraceEnvelope> read = TraceFile.Read(path);

            Assert.Equal(envelopes.Length, read.Count, "every required envelope kind must survive");
            for (int i = 0; i < envelopes.Length; i++)
            {
                Assert.Equal(envelopes[i].Kind, read[i].Kind, $"kind {i}");
                Assert.Equal(envelopes[i].Sequence, read[i].Sequence, $"sequence {i}");
                Assert.Equal(envelopes[i].TimestampQpc, read[i].TimestampQpc, $"timestamp {i}");
                Assert.Equal(envelopes[i].Payload.GetRawText(), read[i].Payload.GetRawText(), $"payload {i}");
                Assert.Equal(envelopes[i].Extensions?.GetRawText(), read[i].Extensions?.GetRawText(), $"extensions {i}");
            }

            string second = Path.Combine(dir, "second.rtt");
            TraceFile.Write(second, read);
            Assert.True(File.ReadAllBytes(path).AsSpan().SequenceEqual(File.ReadAllBytes(second)),
                "decode/encode must preserve canonical trace bytes");

            string extensionPath = Path.Combine(dir, "extension.rtt");
            TraceFile.Write(extensionPath, new[] { Envelope("Vendor.Custom", 99) });
            Assert.Equal("Vendor.Custom", TraceFile.Read(extensionPath)[0].Kind,
                "same-schema extension envelope kinds must not be rejected");
        }
        finally { Directory.Delete(dir, true); }
    }

    [RtFact]
    public static void TraceFile_Layout_HasLengthMagicSchemaAndRealCrc32()
    {
        string dir = TempDir();
        try
        {
            string path = Path.Combine(dir, "layout.rtt");
            TraceFile.Write(path, new[] { Envelope("Frame", 0) });
            byte[] bytes = File.ReadAllBytes(path);
            Assert.Equal(bytes.Length - 4, BinaryPrimitives.ReadInt32LittleEndian(bytes), "length prefix covers everything after itself");
            Assert.Equal("RTTR", Encoding.ASCII.GetString(bytes, 4, 4), "magic offset");
            Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(8)), "schema offset");
            uint expected = IndependentCrc32(bytes.AsSpan(4, bytes.Length - 8));
            uint stored = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(bytes.Length - 4));
            Assert.Equal(expected, stored, "last four bytes must be the IEEE CRC32 of magic/schema/body");
        }
        finally { Directory.Delete(dir, true); }
    }

    [RtFact]
    public static void TraceFile_RejectsBadMagicVersionChecksumAndEveryTruncation()
    {
        string dir = TempDir();
        try
        {
            string source = Path.Combine(dir, "valid.rtt");
            TraceFile.Write(source, new[] { Envelope("Frame", 0), Envelope("Plan", 1) });
            byte[] valid = File.ReadAllBytes(source);

            AssertRejected("bad-magic", Mutate(valid, b => b[4] ^= 0x40), "magic");
            AssertRejected("bad-version", Mutate(valid, b => BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(8), 99)), "version");
            AssertRejected("bad-checksum", Mutate(valid, b => b[^5] ^= 0x80), "checksum");

            int firstLength = BinaryPrimitives.ReadInt32LittleEndian(valid) + 4;
            foreach (int cut in new[] { 0, 1, 3, 4, 7, 11, firstLength - 1, firstLength + 2, valid.Length - 1 })
            {
                string path = Path.Combine(dir, $"cut-{cut}.rtt");
                File.WriteAllBytes(path, valid.AsSpan(0, cut).ToArray());
                Assert.Throws<InvalidDataException>(() => TraceFile.Read(path), $"truncation at {cut} must be rejected");
            }

            void AssertRejected(string name, byte[] bytes, string messagePart)
            {
                string path = Path.Combine(dir, name + ".rtt");
                File.WriteAllBytes(path, bytes);
                var ex = Assert.Throws<InvalidDataException>(() => TraceFile.Read(path), name);
                Assert.True(ex.Message.Contains(messagePart, StringComparison.OrdinalIgnoreCase),
                    $"{name} error should name {messagePart}: {ex.Message}");
            }
        }
        finally { Directory.Delete(dir, true); }
    }

    [RtFact]
    public static async Task TraceRecorder_BlockedIo_DropsWithoutBlockingProducer()
    {
        var stream = new BlockingWriteStream();
        await using var recorder = new TraceRecorder(stream, capacity: 2, leaveOpen: true);
        Assert.True(recorder.TryRecord("Frame", 10, JsonDocument.Parse("{\"n\":0}").RootElement.Clone()), "first envelope accepted");
        await stream.FirstWriteStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var producer = Task.Run(() =>
        {
            bool second = recorder.TryRecord("Gate", 11, JsonDocument.Parse("{}").RootElement.Clone());
            bool third = recorder.TryRecord("EStop", 12, JsonDocument.Parse("{}").RootElement.Clone());
            bool overflow = recorder.TryRecord("Plan", 13, JsonDocument.Parse("{}").RootElement.Clone());
            return (second, third, overflow);
        });
        Task completed = await Task.WhenAny(producer, Task.Delay(1000));
        Assert.True(ReferenceEquals(completed, producer), "a full queue and blocked I/O must not block TryRecord");
        var accepted = await producer;
        Assert.True(accepted.second && accepted.third, "bounded queue holds two waiting envelopes");
        Assert.False(accepted.overflow, "overflow is explicitly rejected");
        Assert.Equal(1L, recorder.DroppedCount, "dropped envelope is counted");
        Assert.Equal(3L, recorder.AcceptedCount, "accepted count excludes the dropped envelope");

        stream.Release.TrySetResult();
        await recorder.CompleteAsync();
        byte[] bytes = stream.ToArray();
        using var replay = new MemoryStream(bytes, writable: false);
        IReadOnlyList<TraceEnvelope> read = TraceFile.Read(replay);
        Assert.Equal(3, read.Count, "all accepted envelopes flush after I/O resumes");
        Assert.Equal("Frame,Gate,EStop", string.Join(',', read.Select(e => e.Kind)), "accepted FIFO order");
        Assert.Equal("0,1,2", string.Join(',', read.Select(e => e.Sequence)), "recorder owns contiguous accepted sequence numbers");
    }

    private static byte[] Mutate(byte[] source, Action<byte[]> mutation)
    {
        byte[] copy = source.ToArray();
        mutation(copy);
        return copy;
    }

    private static uint IndependentCrc32(ReadOnlySpan<byte> bytes)
    {
        uint crc = uint.MaxValue;
        foreach (byte b in bytes)
        {
            crc ^= b;
            for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xEDB88320U & (uint)-(int)(crc & 1));
        }
        return ~crc;
    }

    private sealed class BlockingWriteStream : MemoryStream
    {
        private int _blocked;
        public TaskCompletionSource FirstWriteStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Exchange(ref _blocked, 1) == 0)
            {
                FirstWriteStarted.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            await base.WriteAsync(buffer, cancellationToken);
        }
    }
}
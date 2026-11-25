using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Frames;
using Rt.Core.Replay;

namespace Rt.Tests;

/// <summary>
/// Task 2 RED tests for deterministic file replay: lossless container round-trip with
/// corruption/truncation rejection, in-order frame sources, and identical replays of the
/// same input in both speed modes — OriginalTimeline paced by a VirtualClock (no wall clock).
/// </summary>
public static class ReplayTests
{
    private static byte[] Xorshift64(long salt, int len)
    {
        ulong state = (ulong)salt;
        if (state == 0) state = 0x9E3779B97F4A7C15UL;
        var buffer = new byte[len];
        for (int i = 0; i < len; i++)
        {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            buffer[i] = (byte)(state >> 21);
        }
        return buffer;
    }

    private static IReadOnlyList<ReplayFrame> SampleFrames() => new[]
    {
        new ReplayFrame(1, TimeSpan.FromMilliseconds(0),   "replay-src", 64, 32, FramePixelFormat.Bgra32, Xorshift64(1, 48)),
        new ReplayFrame(1, TimeSpan.FromMilliseconds(40),  "replay-src", 64, 32, FramePixelFormat.Bgra32, Xorshift64(2, 48)),
        new ReplayFrame(2, TimeSpan.FromMilliseconds(80),  "replay-src", 64, 32, FramePixelFormat.Bgra32, Xorshift64(3, 64)),
        new ReplayFrame(2, TimeSpan.FromMilliseconds(120), "replay-src", 32, 16, FramePixelFormat.Gray8,  Xorshift64(4, 24)),
        new ReplayFrame(3, TimeSpan.FromMilliseconds(200), "replay-src", 32, 16, FramePixelFormat.Gray8,  Xorshift64(5, 24)),
    };

    private static string Fnv1A(ReadOnlySpan<byte> data)
    {
        ulong hash = 14695981039346656037UL;
        foreach (byte b in data)
        {
            hash ^= b;
            hash *= 1099511628211UL;
        }
        return hash.ToString("x16");
    }

    private static string TempDir()
    {
        string dir = Path.Combine(Path.GetTempPath(), "rt-replay-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    [RtFact]
    public static void ReplayFile_RoundTrip_PreservesEveryField_AndIsByteStable()
    {
        string dir = TempDir();
        try
        {
            IReadOnlyList<ReplayFrame> frames = SampleFrames();
            string pathA = Path.Combine(dir, "a.rtr");
            string pathB = Path.Combine(dir, "b.rtr");

            ReplayFile.Write(pathA, frames);
            var read = ReplayFile.Read(pathA);
            Assert.Equal(frames.Count, read.Count, "frame count must round-trip");
            for (int i = 0; i < frames.Count; i++)
            {
                Assert.Equal(frames[i].SourceEpoch, read[i].SourceEpoch, $"frame {i} epoch");
                Assert.Equal(frames[i].CaptureOffset.Ticks, read[i].CaptureOffset.Ticks, $"frame {i} capture offset");
                Assert.Equal(frames[i].SourceId, read[i].SourceId, $"frame {i} source id");
                Assert.Equal(frames[i].Width, read[i].Width, $"frame {i} width");
                Assert.Equal(frames[i].Height, read[i].Height, $"frame {i} height");
                Assert.Equal(frames[i].Format, read[i].Format, $"frame {i} format");
                Assert.True(read[i].PayloadEquals(frames[i]), $"frame {i} payload must round-trip byte-exact");
            }

            ReplayFile.Write(pathB, read);
            byte[] bytesA = File.ReadAllBytes(pathA);
            byte[] bytesB = File.ReadAllBytes(pathB);
            Assert.True(bytesA.AsSpan().SequenceEqual(bytesB), "rewriting a parsed file must be byte-identical");
            Console.WriteLine($"       replay file: {bytesA.Length} bytes for {frames.Count} frames");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static void ReplayFile_RejectsCorruptMagic()
    {
        string dir = TempDir();
        try
        {
            string path = Path.Combine(dir, "bad-magic.rtr");
            ReplayFile.Write(path, SampleFrames());
            byte[] bytes = File.ReadAllBytes(path);
            bytes[0] = (byte)'X';
            File.WriteAllBytes(path, bytes);
            var ex = Assert.Throws<InvalidDataException>(() => ReplayFile.Read(path), "corrupt magic must be rejected");
            Assert.True(ex.Message.Contains("magic", StringComparison.OrdinalIgnoreCase), $"message should name the magic, got: {ex.Message}");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static void ReplayFile_RejectsUnknownVersion()
    {
        string dir = TempDir();
        try
        {
            string path = Path.Combine(dir, "bad-version.rtr");
            ReplayFile.Write(path, SampleFrames());
            byte[] bytes = File.ReadAllBytes(path);
            BitConverter.GetBytes((ushort)99).CopyTo(bytes, 4);
            File.WriteAllBytes(path, bytes);
            var ex = Assert.Throws<InvalidDataException>(() => ReplayFile.Read(path), "unknown version must be rejected");
            Assert.True(ex.Message.Contains("version", StringComparison.OrdinalIgnoreCase), $"message should name the version, got: {ex.Message}");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static void ReplayFile_RejectsTruncatedAndEmptyFiles()
    {
        string dir = TempDir();
        try
        {
            string source = Path.Combine(dir, "full.rtr");
            ReplayFile.Write(source, SampleFrames());
            byte[] full = File.ReadAllBytes(source);

            foreach (int cut in new[] { 0, 1, 9, 64, full.Length - 8 })
            {
                string path = Path.Combine(dir, $"cut-{cut}.rtr");
                File.WriteAllBytes(path, full.AsSpan(0, cut).ToArray());
                var ex = Assert.Throws<InvalidDataException>(() => ReplayFile.Read(path), $"truncated file (first {cut} bytes) must be rejected");
                Console.WriteLine($"       cut {cut,4} bytes -> {ex.Message}");
            }
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static void ReplayFrameSource_YieldsInOrder_ThenExhausts()
    {
        var frames = SampleFrames();
        var source = new ReplayFrameSource(frames);
        Assert.Equal(frames.Count, source.FrameCount, "frame count");
        Assert.Equal(0, source.Position, "fresh source starts at 0");
        for (int i = 0; i < frames.Count; i++)
        {
            Assert.True(source.TryGetNext(out ReplayFrame? frame), $"frame {i} must be available");
            var actual = Assert.NotNull(frame, $"frame {i} non-null");
            Assert.Equal(frames[i].SourceEpoch, actual.SourceEpoch, $"frame {i} epoch in order");
            Assert.True(actual.PayloadEquals(frames[i]), $"frame {i} payload in order");
            Assert.Equal(i + 1, source.Position, $"position after {i + 1} reads");
        }
        Assert.False(source.TryGetNext(out ReplayFrame? exhausted), "exhausted source must return false");
        Assert.Null(exhausted, "exhausted source yields a null frame");
        Assert.Equal(frames.Count, source.Position, "position stays at the end");
    }

    [RtFact]
    public static async Task Replay_AsFastAsPossible_FromFile_TwiceIdentical()
    {
        string dir = TempDir();
        try
        {
            string path = Path.Combine(dir, "asfast.rtr");
            ReplayFile.Write(path, SampleFrames());
            var frames = ReplayFile.Read(path);

            string run1 = await RunAsFast(frames);
            string run2 = await RunAsFast(frames);
            Console.WriteLine($"       as-fast fingerprint: {run1}");
            Assert.Equal(run1, run2, "the same replay input must produce the identical output sequence");
            Assert.True(run1.StartsWith("read=5|pub=5|drop=0|epochs=2|first=1|last=5|", StringComparison.Ordinal), $"unexpected summary in fingerprint: {run1}");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    private static async Task<string> RunAsFast(IReadOnlyList<ReplayFrame> frames)
    {
        var clock = new VirtualClock();
        var ring = new FrameRing("replay-src");
        var publisher = new ReplayFramePublisher(ring, new ReplayFrameSource(frames), clock, ReplaySpeedMode.AsFastAsPossible);
        ReplaySummary summary = await publisher.RunAsync();

        Assert.Equal(5, summary.FramesRead, "all frames read");
        Assert.Equal(5, summary.Published, "all frames published");
        Assert.Equal(0, summary.Dropped, "no drops without consumers");
        Assert.Equal(2, summary.EpochChanges, "epochs 1->2->3");
        Assert.Equal(1L, summary.FirstSequence, "first sequence");
        Assert.Equal(5L, summary.LastSequence, "last sequence");
        Assert.Equal(3L, ring.SourceEpoch, "ring follows the last frame epoch");

        var lease = Assert.NotNull(ring.AcquireLatest(), "final frame must be acquirable");
        string fingerprint = $"read={summary.FramesRead}|pub={summary.Published}|drop={summary.Dropped}|epochs={summary.EpochChanges}|first={summary.FirstSequence}|last={summary.LastSequence}|start={summary.StartClock}|end={summary.EndClock}|seq={lease.Sequence}|epoch={lease.Meta.SourceEpoch}|received={lease.Meta.ReceivedQpc}|hash={Fnv1A(lease.Data.Span)}";
        lease.Release();
        Assert.Equal(0, ring.Stats.OutstandingLeases, "no leaked leases");
        return fingerprint;
    }

    [RtFact]
    public static async Task Replay_OriginalTimeline_VirtualClock_IsDeterministic()
    {
        var frames = new[]
        {
            new ReplayFrame(1, TimeSpan.Zero, "det-src", 4, 2, FramePixelFormat.Bgra32, new byte[] { 10, 11, 12 }),
            new ReplayFrame(1, TimeSpan.FromMilliseconds(100), "det-src", 4, 2, FramePixelFormat.Bgra32, new byte[] { 20, 21, 22 }),
            new ReplayFrame(2, TimeSpan.FromMilliseconds(250), "det-src", 4, 2, FramePixelFormat.Bgra32, new byte[] { 30, 31, 32 }),
        };

        string run1 = await RunOriginalTimeline(frames);
        string run2 = await RunOriginalTimeline(frames);
        Console.WriteLine("       original-timeline records:");
        foreach (string line in run1.Split('\n')) Console.WriteLine("         " + line);
        Assert.Equal(run1, run2, "original-timeline replay on a virtual clock must be deterministic");

        Assert.True(run1.Contains("before@1000000:seq=1"), $"frame 2 must not exist before its deadline; records: {run1}");
        Assert.True(run1.Contains("at@1000000:seq=2,epoch=1,received=1000000"), $"frame 2 must land exactly at its deadline; records: {run1}");
        Assert.True(run1.Contains("before@2500000:seq=2"), $"frame 3 must not exist before its deadline; records: {run1}");
        Assert.True(run1.Contains("at@2500000:seq=3,epoch=2,received=2500000"), $"frame 3 must land exactly at its deadline with the new epoch; records: {run1}");
    }

    private static async Task<string> RunOriginalTimeline(IReadOnlyList<ReplayFrame> frames)
    {
        var clock = new VirtualClock(frequency: 10_000_000);
        var ring = new FrameRing("det-src");
        var publisher = new ReplayFramePublisher(ring, new ReplayFrameSource(frames), clock, ReplaySpeedMode.OriginalTimeline);
        Task<ReplaySummary> run = publisher.RunAsync();

        var records = new List<string>();
        for (int guard = 0; guard < 16; guard++)
        {
            Spin.WaitForCondition(() => clock.PendingWaiterCount > 0 || run.IsCompleted, "publisher to park on a deadline or finish");
            if (run.IsCompleted) break;
            if (clock.EarliestPendingDeadline is not long deadline)
            {
                Assert.Fail("a waiter is pending but no deadline is visible");
                break;
            }

            records.Add($"before@{deadline}:seq={SampleLatest(ring)}");
            int expectedPublished = frames.Count(frame => clock.FromTimeSpan(frame.CaptureOffset) <= deadline);
            clock.AdvanceTo(deadline);
            int expected = expectedPublished;
            Spin.WaitForCondition(() => ring.Stats.Published >= expected, $"published >= {expected} after advancing to {deadline}");
            records.Add($"at@{deadline}:{SampleLatestFull(ring, clock)}");
        }

        Assert.True(run.IsCompleted, "publisher must finish once every deadline has been reached");
        ReplaySummary summary = await run;
        Assert.Equal(3, summary.FramesRead, "frames read");
        Assert.Equal(3, summary.Published, "frames published");
        Assert.Equal(0, summary.Dropped, "no drops");
        Assert.Equal(1, summary.EpochChanges, "epoch 1 -> 2");
        Assert.Equal(1L, summary.FirstSequence, "first sequence");
        Assert.Equal(3L, summary.LastSequence, "last sequence");
        Assert.Equal(0L, summary.StartClock, "virtual clock starts at 0");
        Assert.Equal(2_500_000L, summary.EndClock, "replay ends at the last frame deadline");
        records.Add($"summary:read={summary.FramesRead},pub={summary.Published},drop={summary.Dropped},epochs={summary.EpochChanges},first={summary.FirstSequence},last={summary.LastSequence},start={summary.StartClock},end={summary.EndClock}");
        Assert.Equal(0, ring.Stats.OutstandingLeases, "no leaked leases");
        return string.Join("\n", records);
    }

    private static long SampleLatest(FrameRing ring)
    {
        var lease = ring.AcquireLatest();
        if (lease is null) return 0;
        long seq = lease.Sequence;
        lease.Dispose();
        return seq;
    }

    private static string SampleLatestFull(FrameRing ring, VirtualClock clock)
    {
        var lease = ring.AcquireLatest();
        if (lease is null) return "none";
        string record = $"seq={lease.Sequence},epoch={lease.Meta.SourceEpoch},received={lease.Meta.ReceivedQpc},hash={Fnv1A(lease.Data.Span)},now={clock.Now}";
        lease.Dispose();
        return record;
    }

    [RtFact]
    public static void ReplayFile_RejectsNegativePayloadLength()
    {
        string dir = TempDir();
        try
        {
            ReplayFrame frame = SampleFrames()[0];
            string path = Path.Combine(dir, "negative-payload.rtr");
            ReplayFile.Write(path, new[] { frame });
            byte[] bytes = File.ReadAllBytes(path);
            int payloadLengthOffset = 10 + 8 + 8 + 1 + frame.SourceId.Length + 4 + 4 + 1;
            BitConverter.GetBytes(-1).CopyTo(bytes, payloadLengthOffset);
            File.WriteAllBytes(path, bytes);
            var ex = Assert.Throws<InvalidDataException>(() => ReplayFile.Read(path), "negative payload length must be rejected");
            Assert.True(ex.Message.Contains("payload", StringComparison.OrdinalIgnoreCase), $"message should name the payload, got: {ex.Message}");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static void ReplayFile_RejectsUnknownPixelFormat()
    {
        string dir = TempDir();
        try
        {
            ReplayFrame frame = SampleFrames()[0];
            string path = Path.Combine(dir, "bad-format.rtr");
            ReplayFile.Write(path, new[] { frame });
            byte[] bytes = File.ReadAllBytes(path);
            int formatOffset = 10 + 8 + 8 + 1 + frame.SourceId.Length + 4 + 4;
            bytes[formatOffset] = 0xFF;
            File.WriteAllBytes(path, bytes);
            var ex = Assert.Throws<InvalidDataException>(() => ReplayFile.Read(path), "unknown pixel format must be rejected");
            Assert.True(ex.Message.Contains("format", StringComparison.OrdinalIgnoreCase), $"message should name the format, got: {ex.Message}");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static void ReplayFile_RejectsTrailingData()
    {
        string dir = TempDir();
        try
        {
            string path = Path.Combine(dir, "trailing.rtr");
            ReplayFile.Write(path, new[] { SampleFrames()[0] });
            byte[] valid = File.ReadAllBytes(path);
            byte[] corrupt = new byte[valid.Length + 1];
            valid.CopyTo(corrupt, 0);
            corrupt[^1] = 0x7F;
            File.WriteAllBytes(path, corrupt);
            var ex = Assert.Throws<InvalidDataException>(() => ReplayFile.Read(path), "trailing bytes must be rejected");
            Assert.True(ex.Message.Contains("trailing", StringComparison.OrdinalIgnoreCase), $"message should name trailing data, got: {ex.Message}");
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [RtFact]
    public static async Task Replay_OriginalTimeline_Cancellation_StopsPromptly()
    {
        var frames = new[]
        {
            new ReplayFrame(1, TimeSpan.Zero, "cancel-src", 4, 2, FramePixelFormat.Gray8, new byte[] { 1 }),
            new ReplayFrame(1, TimeSpan.FromSeconds(30), "cancel-src", 4, 2, FramePixelFormat.Gray8, new byte[] { 2 }),
        };
        var clock = new VirtualClock(frequency: 10_000_000);
        var ring = new FrameRing("cancel-src");
        var publisher = new ReplayFramePublisher(ring, new ReplayFrameSource(frames), clock, ReplaySpeedMode.OriginalTimeline);
        using var cts = new CancellationTokenSource();

        Task<ReplaySummary> run = publisher.RunAsync(cts.Token);
        Spin.WaitForCondition(() => clock.PendingWaiterCount > 0 || run.IsCompleted, "publisher to park on the 30 s deadline");
        Assert.False(run.IsCompleted, "publisher must still be waiting on the 30 s frame");
        Assert.Equal(1L, ring.Stats.Published, "only the immediate frame is published while parked");

        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => run, "cancellation must surface as OperationCanceledException");
        Assert.Equal(1L, ring.Stats.Published, "no frames published after cancellation");
        Assert.Equal(0, ring.Stats.OutstandingLeases, "no leaked leases after cancellation");
    }
}

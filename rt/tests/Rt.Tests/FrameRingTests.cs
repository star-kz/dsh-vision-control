using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Frames;
using Rt.Windows;

namespace Rt.Tests;

/// <summary>
/// Task 2 RED tests for the fixed 3-slot latest-frame ring: 240 fps producer behaviour,
/// slow consumers always seeing the newest complete frame, explicit lease ownership,
/// bounded memory via buffer reuse, source-epoch switches and lock-free stress.
/// </summary>
public static class FrameRingTests
{
    private const int PayloadLength = 32;

    private static byte[] Payload(long seq, int len = PayloadLength)
    {
        var buffer = new byte[len];
        BitConverter.TryWriteBytes(buffer.AsSpan(0, 8), seq);
        for (int i = 8; i < len; i++) buffer[i] = (byte)(seq + i);
        return buffer;
    }

    private static bool PayloadValid(long seq, ReadOnlySpan<byte> data)
    {
        if (data.Length != PayloadLength) return false;
        long read = BitConverter.ToInt64(data.Slice(0, 8));
        if (read != seq) return false;
        for (int i = 8; i < data.Length; i++)
        {
            if (data[i] != (byte)(seq + i)) return false;
        }
        return true;
    }

    private static long Percentile(List<long> values, double p)
    {
        var sorted = values.OrderBy(v => v).ToList();
        int index = Math.Clamp((int)Math.Ceiling(p * sorted.Count) - 1, 0, sorted.Count - 1);
        return sorted[index];
    }

    [RtFact]
    public static void FrameRing_NewRing_IsEmptyWithDefaults()
    {
        var ring = new FrameRing("cam-default");
        Assert.Equal("cam-default", ring.SourceId, "source id must round-trip");
        Assert.Equal(FrameRing.DefaultCapacity, ring.Capacity, "default capacity must be 3");
        Assert.Equal(3, ring.Capacity, "default capacity literal");
        Assert.Equal(1L, ring.SourceEpoch, "initial epoch defaults to 1");
        Assert.Equal(0L, ring.SeqHighWater, "empty ring has no sequences");
        Assert.Null(ring.AcquireLatest(), "empty ring must yield no lease");

        var stats = ring.Stats;
        Assert.Equal(0L, stats.Published, "published starts at 0");
        Assert.Equal(0L, stats.Dropped, "dropped starts at 0");
        Assert.Equal(0L, stats.Overwritten, "overwritten starts at 0");
        Assert.Equal(0L, stats.SeqHighWater, "stats high water starts at 0");
        Assert.Equal(0, stats.OutstandingLeases, "no leases outstanding");
        Assert.Equal(0L, stats.AcquireContentions, "no contentions yet");
        Assert.Equal(0L, stats.EpochChanges, "no epoch changes yet");

        Assert.Throws<ArgumentOutOfRangeException>(() => new FrameRing("x", 0), "capacity 0 must be rejected");
        Assert.Throws<ArgumentOutOfRangeException>(() => new FrameRing("x", 65), "capacity 65 must be rejected");
        Assert.Throws<ArgumentOutOfRangeException>(() => new FrameRing("x", 3, 0), "epoch 0 must be rejected");
        Assert.Throws<ArgumentException>(() => new FrameRing(null!), "null source id must be rejected");
    }

    [RtFact]
    public static void FrameRing_PublishAcquire_RoundTripsMetaAndPayload()
    {
        var ring = new FrameRing("cam-a");
        byte[] payload = Payload(1);
        bool ok = ring.TryPublish(payload, capturedQpc: 111, receivedQpc: 222, 640, 480, FramePixelFormat.Bgra32, out FrameMeta meta);
        Assert.True(ok, "publish into an empty ring must succeed");
        Assert.Equal(1L, meta.Sequence, "first sequence is 1");
        Assert.Equal("cam-a", meta.SourceId, "meta carries source id");
        Assert.Equal(1L, meta.SourceEpoch, "meta carries epoch");
        Assert.Equal(111L, meta.CapturedQpc, "meta carries capture timestamp");
        Assert.Equal(222L, meta.ReceivedQpc, "meta carries receive timestamp");
        Assert.Equal(640, meta.Width, "meta carries width");
        Assert.Equal(480, meta.Height, "meta carries height");
        Assert.Equal(FramePixelFormat.Bgra32, meta.Format, "meta carries format");

        var lease = Assert.NotNull(ring.AcquireLatest(), "lease must be available after publish");
        Assert.Equal(1L, lease.Sequence, "lease sequence matches publish");
        Assert.Equal(meta, lease.Meta, "lease meta equals the published meta");
        Assert.True(payload.AsSpan().SequenceEqual(lease.Data.Span), "payload bytes must round-trip exactly");
        Assert.Equal(1L, ring.SeqHighWater, "high water after one publish");
        Assert.Equal(1L, ring.Stats.Published, "stats published");
        Assert.Equal(1, ring.Stats.OutstandingLeases, "one lease outstanding");

        lease.Dispose();
        Assert.Equal(0, ring.Stats.OutstandingLeases, "lease returned after dispose");
    }

    [RtFact]
    public static void FrameRing_ConsumerAlwaysGetsLatest_NoBacklog()
    {
        var ring = new FrameRing("cam-burst");
        for (long seq = 1; seq <= 5; seq++)
        {
            Assert.True(ring.TryPublish(Payload(seq), seq * 10, seq * 10 + 1, 64, 32, FramePixelFormat.Bgra32, out _), $"publish {seq} must succeed");
        }

        var lease1 = Assert.NotNull(ring.AcquireLatest(), "first acquire");
        var lease2 = Assert.NotNull(ring.AcquireLatest(), "second acquire");
        Assert.Equal(5L, lease1.Sequence, "consumer must see only the latest frame");
        Assert.Equal(5L, lease2.Sequence, "no backlog re-fire: second acquire is also the latest");
        Assert.Equal(2, ring.Stats.OutstandingLeases, "two leases on the same slot");

        Assert.Equal(5L, ring.Stats.Published, "all five publishes counted");
        Assert.Equal(0L, ring.Stats.Dropped, "unleased slots are overwritten, never dropped");
        Assert.Equal(2L, ring.Stats.Overwritten, "seq4/seq5 overwrote seq1/seq2 slots");
        Assert.Equal(5L, ring.SeqHighWater, "high water is 5");

        lease1.Release();
        lease2.Release();
        Assert.Equal(0, ring.Stats.OutstandingLeases, "all leases returned");
    }

    [RtFact]
    public static void FrameLease_Ownership_ReleaseSemantics()
    {
        var ring = new FrameRing("cam-own");
        Assert.True(ring.TryPublish(Payload(1), 1, 1, 8, 8, FramePixelFormat.Gray8, out _), "publish 1");
        var lease = Assert.NotNull(ring.AcquireLatest(), "acquire lease");

        lease.Release();
        Assert.True(lease.IsReleased, "IsReleased after Release");
        var ex = Assert.Throws<InvalidOperationException>(() => lease.Release(), "double release must fail loudly");
        Assert.True(ex.Message.Contains("twice", StringComparison.Ordinal), $"double-release message should mention ownership, got: {ex.Message}");
        Assert.Throws<ObjectDisposedException>(() => { var _ = lease.Meta; return; }, "Meta after release must throw");
        Assert.Throws<ObjectDisposedException>(() => { var _ = lease.Data; return; }, "Data after release must throw");
        Assert.Throws<ObjectDisposedException>(() => { var _ = lease.Sequence; return; }, "Sequence after release must throw");
        lease.Dispose(); // Dispose after Release must be a safe no-op
        Assert.Equal(0, ring.Stats.OutstandingLeases, "slot returned exactly once");

        Assert.True(ring.TryPublish(Payload(2), 2, 2, 8, 8, FramePixelFormat.Gray8, out _), "publish 2");
        var lease2 = Assert.NotNull(ring.AcquireLatest(), "acquire lease 2");
        lease2.Dispose();
        Assert.True(lease2.IsReleased, "Dispose marks released");
        lease2.Dispose(); // idempotent
        Assert.Equal(0, ring.Stats.OutstandingLeases, "dispose path returned the slot once");
    }

    [RtFact]
    public static void FrameRing_ReusesSlotBuffers_BoundedMemory()
    {
        var ring = new FrameRing("cam-reuse", 3, 1, 4096);
        Assert.True(ring.TryPublish(Payload(1), 1, 1, 8, 8, FramePixelFormat.Gray8, out _), "publish 1");
        var lease1 = Assert.NotNull(ring.AcquireLatest(), "lease 1");
        Assert.True(MemoryMarshal.TryGetArray(lease1.Data, out ArraySegment<byte> seg1), "data must expose the backing array");
        byte[]? array1 = seg1.Array;
        Assert.NotNull(array1, "backing array exists");
        lease1.Release();

        Assert.True(ring.TryPublish(Payload(2), 2, 2, 8, 8, FramePixelFormat.Gray8, out _), "publish 2");
        Assert.True(ring.TryPublish(Payload(3), 3, 3, 8, 8, FramePixelFormat.Gray8, out _), "publish 3");
        Assert.True(ring.TryPublish(Payload(4), 4, 4, 8, 8, FramePixelFormat.Gray8, out _), "publish 4 wraps to slot 0");

        var lease4 = Assert.NotNull(ring.AcquireLatest(), "lease 4");
        Assert.Equal(4L, lease4.Sequence, "latest is seq 4");
        Assert.True(MemoryMarshal.TryGetArray(lease4.Data, out ArraySegment<byte> seg4), "data exposes backing array");
        Assert.Same(array1, seg4.Array, "slot buffer must be reused — bounded memory, no per-frame allocation");
        Assert.Equal(0, seg4.Offset, "payload starts at buffer offset 0");
        Assert.True(PayloadValid(4, lease4.Data.Span), "reused buffer carries a valid payload");
        lease4.Release();

        byte[] big = Payload(5, 9000);
        Assert.True(ring.TryPublish(big, 5, 5, 8, 8, FramePixelFormat.Gray8, out _), "oversized publish must grow the slot buffer");
        var lease5 = Assert.NotNull(ring.AcquireLatest(), "lease 5");
        Assert.Equal(9000, lease5.Data.Length, "grown payload length");
        Assert.True(big.AsSpan().SequenceEqual(lease5.Data.Span), "grown payload bytes round-trip");
        lease5.Release();

        Assert.True(ring.TryPublish(Payload(6), 6, 6, 8, 8, FramePixelFormat.Gray8, out _), "small publish after growth");
        var lease6 = Assert.NotNull(ring.AcquireLatest(), "lease 6");
        Assert.Equal(PayloadLength, lease6.Data.Length, "payload length shrinks with the frame, buffer stays grown");
        lease6.Release();
        Assert.Equal(0, ring.Stats.OutstandingLeases, "no leaked leases");
    }

    [RtFact]
    public static void FrameRing_AllSlotsLeased_DropsPublish_ThenRecovers()
    {
        var ring = new FrameRing("cam-drop", 3);
        Assert.True(ring.TryPublish(Payload(1), 1, 1, 8, 8, FramePixelFormat.Gray8, out _), "publish 1");
        var a = Assert.NotNull(ring.AcquireLatest(), "lease A on seq 1");
        Assert.True(ring.TryPublish(Payload(2), 2, 2, 8, 8, FramePixelFormat.Gray8, out _), "publish 2");
        var b = Assert.NotNull(ring.AcquireLatest(), "lease B on seq 2");
        Assert.True(ring.TryPublish(Payload(3), 3, 3, 8, 8, FramePixelFormat.Gray8, out _), "publish 3");
        var c = Assert.NotNull(ring.AcquireLatest(), "lease C on seq 3");

        bool blocked = ring.TryPublish(Payload(4), 4, 4, 8, 8, FramePixelFormat.Gray8, out FrameMeta blockedMeta);
        Assert.False(blocked, "publish must drop (not block, not corrupt) while every slot is leased");
        Assert.Equal(0L, blockedMeta.Sequence, "dropped publish yields no sequence");
        Assert.Equal(1L, ring.Stats.Dropped, "drop counted");
        Assert.Equal(3L, ring.SeqHighWater, "dropped publish must not consume a sequence number");

        b.Release();
        Assert.True(ring.TryPublish(Payload(4), 4, 4, 8, 8, FramePixelFormat.Gray8, out FrameMeta meta4), "publish succeeds once a slot frees");
        Assert.Equal(4L, meta4.Sequence, "next sequence after recovery");
        var d = Assert.NotNull(ring.AcquireLatest(), "latest after recovery");
        Assert.Equal(4L, d.Sequence, "consumer sees the recovered frame");
        Assert.True(PayloadValid(4, d.Data.Span), "recovered frame payload intact");

        Assert.Equal(4L, ring.Stats.Published, "four frames published");
        Assert.Equal(1L, ring.Stats.Dropped, "one drop total");
        Assert.Equal(4L, ring.SeqHighWater, "high water equals published (drops consume nothing)");
        Assert.Equal(1L, ring.Stats.Overwritten, "seq 4 overwrote seq 2's slot");

        a.Release();
        c.Release();
        d.Release();
        Assert.Equal(0, ring.Stats.OutstandingLeases, "all slots returned");
    }

    [RtFact]
    public static void FrameRing_SlowConsumer_SeesOnlyLatest_240Burst()
    {
        var ring = new FrameRing("cam-240");
        const int rounds = 240;
        for (int round = 0; round < rounds; round++)
        {
            for (int k = 1; k <= 4; k++)
            {
                long seq = 4L * round + k;
                Assert.True(ring.TryPublish(Payload(seq), seq, seq, 64, 32, FramePixelFormat.Bgra32, out _), $"publish {seq}");
            }

            var lease = Assert.NotNull(ring.AcquireLatest(), $"slow consumer must get a frame at round {round}");
            long expected = 4L * (round + 1);
            Assert.Equal(expected, lease.Sequence, $"slow consumer at round {round} must see only the newest frame");
            Assert.True(PayloadValid(lease.Sequence, lease.Data.Span), $"torn payload at seq {lease.Sequence}");
            lease.Dispose();
        }

        var stats = ring.Stats;
        Assert.Equal(960L, stats.Published, "240 rounds x 4 frames");
        Assert.Equal(0L, stats.Dropped, "slow consumer never blocks the producer");
        Assert.Equal(957L, stats.Overwritten, "every publish after the first three overwrote a slot");
        Assert.Equal(960L, stats.SeqHighWater, "high water");
        Assert.Equal(0, stats.OutstandingLeases, "no leaked leases");
    }

    [RtFact]
    public static void FrameRing_EpochChange_InvalidatesLatest_AndSparesHeldLeases()
    {
        var ring = new FrameRing("cam-epoch", 3, 1);
        Assert.True(ring.TryPublish(Payload(1), 1, 1, 8, 8, FramePixelFormat.Gray8, out FrameMeta meta1), "publish epoch-1 frame");
        Assert.Equal(1L, meta1.SourceEpoch, "frame stamped with epoch 1");
        var held = Assert.NotNull(ring.AcquireLatest(), "lease held across the epoch change");

        ring.BeginEpoch(2);
        Assert.Equal(2L, ring.SourceEpoch, "ring epoch advanced");
        Assert.Equal(1L, ring.Stats.EpochChanges, "epoch change counted");
        Assert.Null(ring.AcquireLatest(), "previous-epoch frames must not be handed out after a source switch");

        Assert.Equal(1L, held.Meta.SourceEpoch, "held lease keeps its old-epoch meta");
        Assert.Equal(1L, held.Sequence, "held lease keeps its sequence");
        Assert.True(PayloadValid(1, held.Data.Span), "held lease payload survives the epoch change");

        Assert.Throws<ArgumentOutOfRangeException>(() => ring.BeginEpoch(2), "same epoch must be rejected");
        Assert.Throws<ArgumentOutOfRangeException>(() => ring.BeginEpoch(1), "backwards epoch must be rejected");

        Assert.True(ring.TryPublish(Payload(2), 2, 2, 8, 8, FramePixelFormat.Gray8, out FrameMeta meta2), "publish after epoch change");
        Assert.Equal(2L, meta2.SourceEpoch, "new frames carry epoch 2");
        Assert.Equal(2L, meta2.Sequence, "sequence numbering continues across epochs");
        var lease2 = Assert.NotNull(ring.AcquireLatest(), "lease after epoch change");
        Assert.Equal(2L, lease2.Meta.SourceEpoch, "consumer sees epoch-2 frame");

        held.Release();
        lease2.Release();
        Assert.Equal(0, ring.Stats.OutstandingLeases, "no leaks across epoch change");
    }

    [RtFact(Category = "stress")]
    public static void FrameRing_Burst_ProducerWithTwoConsumers_NoCorruption()
    {
        var ring = new FrameRing("cam-stress", 3);
        const int attempts = 20_000;
        var errors = new ConcurrentQueue<string>();
        long observedTotal = 0;
        long[] observedPerConsumer = new long[2];
        bool stop = false;
        using var startGate = new ManualResetEventSlim(false);

        var consumers = new Thread[2];
        for (int id = 0; id < consumers.Length; id++)
        {
            int consumerId = id;
            consumers[id] = new Thread(() =>
            {
                if (!startGate.Wait(TimeSpan.FromSeconds(5)))
                {
                    errors.Enqueue($"consumer {consumerId}: start gate timed out");
                    return;
                }
                long lastSeen = 0;
                long observed = 0;
                while (!Volatile.Read(ref stop))
                {
                    var lease = ring.AcquireLatest();
                    if (lease is null)
                    {
                        Thread.SpinWait(64);
                        continue;
                    }
                    long seq = lease.Sequence;
                    if (!PayloadValid(seq, lease.Data.Span)) errors.Enqueue($"consumer {consumerId}: torn payload at seq {seq}");
                    if (seq < lastSeen) errors.Enqueue($"consumer {consumerId}: went backwards {lastSeen} -> {seq}");
                    lastSeen = seq;
                    observed++;
                    lease.Dispose();
                }
                observedPerConsumer[consumerId] = observed;
                Interlocked.Add(ref observedTotal, observed);
            })
            { IsBackground = true, Name = $"ring-consumer-{id}" };
            consumers[id].Start();
        }

        startGate.Set();
        for (long attempt = 1; attempt <= attempts; attempt++)
        {
            long expected = ring.SeqHighWater + 1;
            if (ring.TryPublish(Payload(expected), expected, expected, 64, 64, FramePixelFormat.Gray8, out FrameMeta meta))
            {
                Assert.Equal(expected, meta.Sequence, "single producer must see contiguous sequences");
            }
        }
        Volatile.Write(ref stop, true);

        foreach (Thread thread in consumers)
        {
            Assert.True(thread.Join(TimeSpan.FromSeconds(15)), $"consumer thread {thread.Name} did not stop — deadlock?");
        }

        Assert.True(errors.IsEmpty, "consumer errors: " + string.Join(" | ", errors));
        var stats = ring.Stats;
        Assert.Equal(attempts, stats.Published + stats.Dropped, "every attempt is accounted as published or dropped");
        Assert.Equal(stats.Published, stats.SeqHighWater, "high water equals published (drops consume no sequence)");
        Assert.Equal(0, stats.OutstandingLeases, "no unreleased slots after the burst");
        Assert.GreaterOrEqual(Interlocked.Read(ref observedTotal), 100L, "consumers must actually observe frames");

        var final = Assert.NotNull(ring.AcquireLatest(), "final frame must be acquirable");
        Assert.Equal(ring.SeqHighWater, final.Sequence, "final lease is the newest frame");
        Assert.True(PayloadValid(final.Sequence, final.Data.Span), "final payload intact");
        final.Release();

        Console.WriteLine($"       ring stress: published={stats.Published} dropped={stats.Dropped} overwritten={stats.Overwritten} seqHighWater={stats.SeqHighWater} contentions={stats.AcquireContentions} observed={observedTotal} (c0={observedPerConsumer[0]}, c1={observedPerConsumer[1]})");
        Assert.Equal(0, ring.Stats.OutstandingLeases, "final lease returned");
    }

    [RtFact(Category = "timing")]
    public static async Task FrameRing_LivePaced_240HzProducer_60HzConsumer()
    {
        using var clock = new QpcClock();
        var ring = new FrameRing("cam-live", 3);
        var errors = new ConcurrentQueue<string>();
        var staleness = new List<long>();
        long lastSeen = 0;

        long start = clock.Now;
        long end = start + Qpc.FromMilliseconds(500);
        long producerStride = Qpc.FromMilliseconds(1000.0 / 240.0);
        long consumerStride = Qpc.FromMilliseconds(1000.0 / 60.0);

        var producer = Task.Run(async () =>
        {
            long cursor = start;
            long seq = 0;
            while (true)
            {
                cursor += producerStride;
                if (cursor >= end) break;
                if (cursor > clock.Now) await clock.WaitUntilAsync(cursor).ConfigureAwait(false);
                seq++;
                if (!ring.TryPublish(Payload(seq), cursor, clock.Now, 64, 64, FramePixelFormat.Bgra32, out _))
                    errors.Enqueue($"producer dropped at seq {seq}");
            }
        });

        var consumer = Task.Run(async () =>
        {
            long cursor = start;
            while (true)
            {
                cursor += consumerStride;
                if (cursor >= end) break;
                if (cursor > clock.Now) await clock.WaitUntilAsync(cursor).ConfigureAwait(false);
                var lease = ring.AcquireLatest();
                if (lease is null) continue;
                long seq = lease.Sequence;
                if (!PayloadValid(seq, lease.Data.Span)) errors.Enqueue($"consumer saw torn payload at seq {seq}");
                lock (staleness) staleness.Add(ring.SeqHighWater - seq);
                long current;
                while (seq > (current = Volatile.Read(ref lastSeen)))
                {
                    if (Interlocked.CompareExchange(ref lastSeen, seq, current) == current) break;
                }
                lease.Dispose();
            }
        });

        await Task.WhenAll(producer, consumer).ConfigureAwait(false);

        Assert.True(errors.IsEmpty, "live errors: " + string.Join(" | ", errors));
        var stats = ring.Stats;
        Assert.Equal(0L, stats.Dropped, "paced 240 Hz producer must never drop with a 60 Hz consumer");
        Assert.GreaterOrEqual(stats.Published, 100L, "500 ms at 240 Hz must produce at least 100 frames");
        Assert.GreaterOrEqual(lastSeen, ring.SeqHighWater - 12, "60 Hz consumer must stay within ~50 ms of the producer");
        Assert.Equal(0, stats.OutstandingLeases, "all leases returned");

        long p50, p95, max;
        lock (staleness)
        {
            Assert.GreaterOrEqual(staleness.Count, 10, "consumer must have sampled the ring repeatedly");
            p50 = Percentile(staleness, 0.50);
            p95 = Percentile(staleness, 0.95);
            max = Percentile(staleness, 1.00);
        }
        Console.WriteLine($"       live 240Hz/60Hz: published={stats.Published} overwritten={stats.Overwritten} samples={staleness.Count} staleness(frames) P50={p50} P95={p95} max={max} contentions={stats.AcquireContentions}");
    }
}

using Rt.Core.Contracts;

namespace Rt.Core.Frames;

/// <summary>
/// Fixed-capacity (default 3), single-producer / multi-consumer latest-frame ring.
/// The producer never blocks and never allocates per frame: a publish either overwrites the
/// oldest unleased slot or is dropped when every slot is currently leased. Consumers always
/// see the newest complete frame — never a backlog — and hold it via an explicit
/// <see cref="FrameLease"/> that pins the slot against overwriting.
/// </summary>
/// <remarks>
/// Concurrency protocol (single producer, N consumers):
/// <list type="bullet">
/// <item>The producer claims a slot with a CAS on <c>WriteClaim</c>, then reads <c>RefCount</c>.
/// A consumer increments <c>RefCount</c> (interlocked, full fence), then reads <c>WriteClaim</c>
/// and re-checks <c>_latestIdx</c>. This Dekker-style handshake means a claim and a reference
/// can never both go unseen: either the consumer observes the in-flight write and backs off, or
/// the producer observes the lease on its next claim and skips the slot.</item>
/// <item>Slot payload/meta writes happen before the release-ordered <c>Version</c>/<c>_latestIdx</c>
/// updates and <c>WriteClaim = 0</c>, so any consumer that passes the claim check reads a complete frame.</item>
/// <item>Dropped publishes consume no sequence number, so <c>SeqHighWater == Published</c> always holds.</item>
/// </list>
/// No hard real-time guarantees are made or needed here: this type is allocation-free on the hot path
/// but makes no scheduling claims.
/// </remarks>
public sealed class FrameRing
{
    /// <summary>Default number of slots: triple buffering.</summary>
    public const int DefaultCapacity = 3;

    private const int MaxCapacity = 64;
    private const int MaxAcquireAttempts = 64;

    internal sealed class Slot
    {
        internal byte[] Buffer;
        internal int PayloadLength;
        internal FrameMeta Meta;
        internal long Version;   // sequence of last completed publish; 0 = never published
        internal int RefCount;   // number of outstanding leases on this slot
        internal int WriteClaim; // 1 while the producer is writing this slot

        internal Slot(int initialBufferBytes)
        {
            Buffer = new byte[initialBufferBytes];
            PayloadLength = 0;
            Meta = default;
            Version = 0;
            RefCount = 0;
            WriteClaim = 0;
        }
    }

    private readonly Slot[] _slots;
    private readonly string _sourceId;

    private long _seqHighWater;        // interlocked
    private long _epoch;               // interlocked
    private int _latestIdx = -1;       // interlocked; index of newest complete frame, -1 = none
    private int _writeIdx;             // producer-thread-only rotation cursor
    private long _published;           // producer-side only (TryPublish)
    private long _dropped;             // producer-side only (TryPublish)
    private long _overwritten;         // producer-side only (TryPublish)
    private long _epochChanges;        // producer-side only (BeginEpoch)
    private int _outstandingLeases;    // interlocked
    private long _acquireContentions;  // interlocked

    public FrameRing(string sourceId, int capacity = DefaultCapacity, long initialEpoch = 1, int initialBufferBytes = 4096)
    {
        ArgumentException.ThrowIfNullOrEmpty(sourceId);
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1, nameof(capacity));
        ArgumentOutOfRangeException.ThrowIfGreaterThan(capacity, MaxCapacity, nameof(capacity));
        ArgumentOutOfRangeException.ThrowIfLessThan(initialEpoch, 1, nameof(initialEpoch));
        ArgumentOutOfRangeException.ThrowIfLessThan(initialBufferBytes, 1, nameof(initialBufferBytes));

        _sourceId = sourceId;
        _slots = new Slot[capacity];
        for (int i = 0; i < capacity; i++)
        {
            _slots[i] = new Slot(initialBufferBytes);
        }
        _epoch = initialEpoch;
    }

    public string SourceId => _sourceId;

    public int Capacity => _slots.Length;

    /// <summary>Current source epoch. Increases monotonically via <see cref="BeginEpoch"/>.</summary>
    public long SourceEpoch => Interlocked.Read(ref _epoch);

    /// <summary>Highest sequence number ever published. Dropped publishes do not consume one.</summary>
    public long SeqHighWater => Interlocked.Read(ref _seqHighWater);

    public RingStats Stats => new(
        Volatile.Read(ref _published),
        Volatile.Read(ref _dropped),
        Volatile.Read(ref _overwritten),
        Interlocked.Read(ref _seqHighWater),
        Volatile.Read(ref _outstandingLeases),
        Interlocked.Read(ref _acquireContentions),
        Volatile.Read(ref _epochChanges));

    /// <summary>
    /// Publish one frame. Single-producer contract: only one thread may call this (and
    /// <see cref="BeginEpoch"/>) at a time. Never blocks; returns false when every slot is leased.
    /// Buffers grow (never shrink) to fit larger payloads, keeping memory bounded by the largest frame seen.
    /// </summary>
    public bool TryPublish(ReadOnlySpan<byte> payload, long capturedQpc, long receivedQpc, int width, int height, FramePixelFormat format, out FrameMeta meta)
    {
        int cap = _slots.Length;
        int start = Volatile.Read(ref _writeIdx);
        for (int probe = 0; probe < cap; probe++)
        {
            int idx = (start + probe) % cap;
            Slot slot = _slots[idx];

            // Dekker pair, step 1: claim before checking readers (Interlocked = full fence).
            if (Interlocked.CompareExchange(ref slot.WriteClaim, 1, 0) != 0)
            {
                continue; // defensive: another claim in flight (cannot happen single-producer)
            }
            if (Volatile.Read(ref slot.RefCount) > 0)
            {
                Volatile.Write(ref slot.WriteClaim, 0);
                continue; // leased — skip, never wait
            }

            if (slot.Buffer.Length < payload.Length)
            {
                // Safe to replace: slot is claimed and unreferenced, so no reader can see either array.
                slot.Buffer = new byte[Math.Max(payload.Length, slot.Buffer.Length * 2)];
            }
            payload.CopyTo(slot.Buffer);
            slot.PayloadLength = payload.Length;

            long seq = Interlocked.Increment(ref _seqHighWater);
            slot.Meta = new FrameMeta(seq, _sourceId, Interlocked.Read(ref _epoch), capturedQpc, receivedQpc, width, height, format);

            if (Volatile.Read(ref slot.Version) != 0)
            {
                _overwritten++;
            }
            Volatile.Write(ref slot.Version, seq);
            Interlocked.Exchange(ref _latestIdx, idx); // release: payload/meta writes precede this
            Volatile.Write(ref slot.WriteClaim, 0);

            _writeIdx = (idx + 1) % cap;
            _published++;
            meta = slot.Meta;
            return true;
        }

        _dropped++;
        meta = default;
        return false;
    }

    /// <summary>
    /// Lease the newest complete frame, or null when none is available. Never blocks and never
    /// returns a frame that is mid-write or has been superseded during acquisition.
    /// </summary>
    public FrameLease? AcquireLatest()
    {
        for (int attempt = 0; attempt < MaxAcquireAttempts; attempt++)
        {
            int idx = Volatile.Read(ref _latestIdx);
            if (idx < 0)
            {
                return null; // nothing published yet, or epoch just changed
            }
            Slot slot = _slots[idx];

            // Dekker pair, step 2: reference before validating the claim (Interlocked = full fence).
            Interlocked.Increment(ref slot.RefCount);

            if (Volatile.Read(ref slot.WriteClaim) != 0 || Volatile.Read(ref _latestIdx) != idx)
            {
                // Producer is mid-write on this slot, or a newer frame (or epoch change) landed
                // while we were grabbing it — back off and retry.
                Interlocked.Decrement(ref slot.RefCount);
                Interlocked.Increment(ref _acquireContentions);
                continue;
            }

            Interlocked.Increment(ref _outstandingLeases);
            return new FrameLease(this, slot, slot.Meta);
        }

        return null; // pathological contention; caller retries later
    }

    /// <summary>
    /// Switch to a new source epoch (camera restart, pipeline reconfigure). Invalidates the latest-frame
    /// pointer so consumers cannot mix streams; already-held leases stay valid with their old-epoch meta.
    /// Producer-side call. <paramref name="newEpoch"/> must be strictly greater than the current epoch.
    /// </summary>
    public void BeginEpoch(long newEpoch)
    {
        long current = Interlocked.Read(ref _epoch);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(newEpoch, current, nameof(newEpoch));

        Interlocked.Exchange(ref _latestIdx, -1);
        Interlocked.Exchange(ref _epoch, newEpoch);
        _epochChanges++;
    }

    internal void ReleaseSlot(Slot slot)
    {
        int remaining = Interlocked.Decrement(ref slot.RefCount);
        if (remaining < 0)
        {
            Interlocked.Increment(ref slot.RefCount); // restore for diagnostics
            throw new InvalidOperationException(
                $"FrameRing slot refcount underflow (slot version {Volatile.Read(ref slot.Version)}).");
        }
        Interlocked.Decrement(ref _outstandingLeases);
    }
}

using Rt.Core.Contracts;

namespace Rt.Core.Frames;

/// <summary>
/// Exclusive, explicit ownership token for one <see cref="FrameRing"/> slot. While a lease is held,
/// the producer will neither overwrite nor drop that slot, so <see cref="Data"/> stays stable for the
/// holder. Reading <see cref="Meta"/>/<see cref="Sequence"/>/<see cref="Data"/> after release throws
/// <see cref="ObjectDisposedException"/>, a second <see cref="Release"/> throws
/// <see cref="InvalidOperationException"/>, and <see cref="Dispose"/> is an idempotent release.
/// </summary>
public sealed class FrameLease : IDisposable
{
    private FrameRing? _ring;              // nulled on release so ReturnToRing is idempotent
    private readonly FrameRing.Slot _slot;
    private readonly FrameMeta _meta;      // captured at acquire time; survives epoch changes
    private int _released;

    internal FrameLease(FrameRing ring, FrameRing.Slot slot, FrameMeta meta)
    {
        _ring = ring;
        _slot = slot;
        _meta = meta;
    }

    /// <summary>Frame metadata captured when the lease was acquired.</summary>
    public FrameMeta Meta
    {
        get
        {
            ThrowIfReleased();
            return _meta;
        }
    }

    public long Sequence => Meta.Sequence;

    /// <summary>The frame payload. Zero-copy view over the ring slot buffer; valid only while leased.</summary>
    public ReadOnlyMemory<byte> Data
    {
        get
        {
            ThrowIfReleased();
            return _slot.Buffer.AsMemory(0, Volatile.Read(ref _slot.PayloadLength));
        }
    }

    public bool IsReleased => Volatile.Read(ref _released) == 1;

    /// <summary>Explicit release. Throws if the lease was already released or disposed — ownership is exclusive.</summary>
    public void Release()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0)
        {
            throw new InvalidOperationException("FrameLease released twice — ownership is exclusive.");
        }
        ReturnToRing();
    }

    /// <summary>Idempotent release for using-scopes; never throws on double dispose.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) == 0)
        {
            ReturnToRing();
        }
    }

    private void ReturnToRing()
    {
        FrameRing? ring = Interlocked.Exchange(ref _ring, null);
        ring?.ReleaseSlot(_slot);
    }

    private void ThrowIfReleased() => ObjectDisposedException.ThrowIf(Volatile.Read(ref _released) == 1, this);
}

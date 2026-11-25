namespace Rt.Windows.Capture;

public enum CaptureInvalidationReason : byte
{
    ItemClosed = 1,
    SizeChanged = 2,
    DpiChanged = 3,
    TopologyChanged = 4,
    AccessLost = 5,
    PositionChanged = 6,
    BackendFaulted = 7,
}

/// <summary>Observed native state that determines whether a capture plan is still valid.</summary>
public readonly record struct CaptureItemState(
    nint Handle,
    int PhysicalWidth,
    int PhysicalHeight,
    int DpiX,
    int DpiY,
    long TopologyVersion,
    bool IsClosed = false,
    bool AccessLost = false,
    int PhysicalX = 0,
    int PhysicalY = 0);

/// <summary>Thread-safe source-epoch tracker. Any observed native mutation invalidates earlier plans.</summary>
public sealed class CaptureEpochTracker
{
    private readonly object _sync = new();
    private CaptureItemState _lastState;
    private long _currentEpoch = 1;

    public CaptureEpochTracker(CaptureItemState initialState) => _lastState = initialState;

    public long CurrentEpoch => Volatile.Read(ref _currentEpoch);

    public CaptureInvalidationReason? LastInvalidationReason { get; private set; }

    public bool IsCurrent(long epoch) => epoch == CurrentEpoch;

    public CaptureInvalidationReason? Observe(CaptureItemState current)
    {
        lock (_sync)
        {
            if (current == _lastState) return null;
            var reason = Classify(_lastState, current);
            _lastState = current;
            Advance(reason);
            return reason;
        }
    }

    public void Invalidate(CaptureInvalidationReason reason)
    {
        lock (_sync)
        {
            _lastState = reason switch
            {
                CaptureInvalidationReason.ItemClosed => _lastState with { IsClosed = true },
                CaptureInvalidationReason.AccessLost => _lastState with { AccessLost = true },
                _ => _lastState,
            };
            Advance(reason);
        }
    }

    private static CaptureInvalidationReason Classify(CaptureItemState previous, CaptureItemState current)
    {
        if (current.IsClosed && !previous.IsClosed) return CaptureInvalidationReason.ItemClosed;
        if (current.AccessLost && !previous.AccessLost) return CaptureInvalidationReason.AccessLost;
        if (current.Handle != previous.Handle || current.TopologyVersion != previous.TopologyVersion)
            return CaptureInvalidationReason.TopologyChanged;
        if (current.PhysicalWidth != previous.PhysicalWidth || current.PhysicalHeight != previous.PhysicalHeight)
            return CaptureInvalidationReason.SizeChanged;
        if (current.DpiX != previous.DpiX || current.DpiY != previous.DpiY)
            return CaptureInvalidationReason.DpiChanged;
        if (current.PhysicalX != previous.PhysicalX || current.PhysicalY != previous.PhysicalY)
            return CaptureInvalidationReason.PositionChanged;
        // Defensive: a newly-set terminal flag is still an invalidation even if a caller supplied an unusual initial state.
        if (current.IsClosed) return CaptureInvalidationReason.ItemClosed;
        if (current.AccessLost) return CaptureInvalidationReason.AccessLost;
        return CaptureInvalidationReason.TopologyChanged;
    }

    private void Advance(CaptureInvalidationReason reason)
    {
        _currentEpoch = checked(_currentEpoch + 1);
        LastInvalidationReason = reason;
    }
}

namespace Rt.Core.Runtime;

public sealed record RunEvent(long EventSeq, long SourceEpoch, string Kind, string? Reason = null);

public sealed class StaleSourceEpochException(long suppliedEpoch, long currentEpoch) :
    InvalidOperationException($"stale source epoch {suppliedEpoch}; current epoch is {currentEpoch}")
{
    public long SuppliedEpoch { get; } = suppliedEpoch;
    public long CurrentEpoch { get; } = currentEpoch;
}

/// <summary>Per-run monotonic event identity. Equal source epochs are valid; stale epochs never emit.</summary>
public sealed class RunEventSequencer
{
    private readonly object _sync = new();
    private long _eventSeq;
    private long _sourceEpoch;

    public RunEventSequencer(long initialEpoch)
    {
        if (initialEpoch < 0) throw new ArgumentOutOfRangeException(nameof(initialEpoch));
        _sourceEpoch = initialEpoch;
    }

    public long CurrentEpoch { get { lock (_sync) return _sourceEpoch; } }
    public long EventSeq { get { lock (_sync) return _eventSeq; } }

    public RunEvent Emit(string kind, long sourceEpoch, string? reason = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        lock (_sync)
        {
            if (sourceEpoch != _sourceEpoch) throw new StaleSourceEpochException(sourceEpoch, _sourceEpoch);
            return new RunEvent(++_eventSeq, sourceEpoch, kind, reason);
        }
    }

    /// <summary>Assign identity and perform its transport emission atomically with respect to other producers.</summary>
    public void Emit(string kind, long sourceEpoch, Action<RunEvent> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        lock (_sync)
        {
            if (sourceEpoch != _sourceEpoch) throw new StaleSourceEpochException(sourceEpoch, _sourceEpoch);
            var identity = new RunEvent(++_eventSeq, sourceEpoch, kind);
            emit(identity);
        }
    }

    public void AdvanceEpoch(long newEpoch, string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        lock (_sync)
        {
            if (newEpoch <= _sourceEpoch) throw new StaleSourceEpochException(newEpoch, _sourceEpoch);
            _sourceEpoch = newEpoch;
        }
    }
}

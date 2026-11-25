namespace Rt.Core.Safety;

public readonly record struct HeldInput(
    long EventId,
    string RunId,
    string ActionId,
    long SourceEpoch,
    string Control,
    long DownQpc);

/// <summary>Per-scheduler registry. No process-wide physical-key release is possible.</summary>
public sealed class HeldInputRegistry
{
    private readonly object _gate = new();
    private readonly Dictionary<long, HeldInput> _held = new();

    public int Count { get { lock (_gate) return _held.Count; } }

    public bool Register(HeldInput input)
    {
        lock (_gate) return _held.TryAdd(input.EventId, input);
    }

    public bool Contains(long eventId) { lock (_gate) return _held.ContainsKey(eventId); }

    public bool TryTake(long eventId, out HeldInput input)
    {
        lock (_gate) return _held.Remove(eventId, out input);
    }

    public IReadOnlyList<HeldInput> TakeAll()
    {
        lock (_gate)
        {
            var all = _held.Values.OrderBy(input => input.EventId).ToArray();
            _held.Clear();
            return all;
        }
    }
}

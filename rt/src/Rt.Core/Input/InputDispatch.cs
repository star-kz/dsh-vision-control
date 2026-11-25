using Rt.Core.Contracts;

namespace Rt.Core.Input;

public enum InputEventPhase { Down = 0, Up = 1 }

public readonly record struct InputDispatchRequest(
    long EventId,
    string RunId,
    string ActionId,
    long SourceEpoch,
    string Control,
    InputEventPhase Phase,
    long ScheduledQpc,
    long DispatchQpc,
    long BatchId,
    int BatchSize,
    bool Forced);

public readonly record struct VirtualInputEvent(
    long EventId,
    string RunId,
    string ActionId,
    long SourceEpoch,
    string Control,
    InputEventPhase Phase,
    long ScheduledQpc,
    long DispatchQpc,
    long BatchId,
    bool Forced,
    int ThreadId);

public interface IInputDispatcher
{
    IReadOnlyList<InputReceipt> DispatchBatch(IReadOnlyList<InputDispatchRequest> requests);
    void Flush();
}

/// <summary>Deterministic input driver double; outcomes and thread ids are fully auditable.</summary>
public sealed class VirtualInputDispatcher : IInputDispatcher
{
    private readonly object _gate = new();
    private readonly List<InputDispatchRequest> _attempts = new();
    private readonly List<VirtualInputEvent> _events = new();
    private readonly List<InputReceipt> _receipts = new();

    public Func<InputDispatchRequest, DispatchOutcome>? Handler { get; set; }
    public int BatchCount { get; private set; }
    public int FlushCount { get; private set; }
    public IReadOnlyList<InputDispatchRequest> Attempts { get { lock (_gate) return _attempts.ToArray(); } }
    public IReadOnlyList<VirtualInputEvent> Events { get { lock (_gate) return _events.ToArray(); } }
    public IReadOnlyList<InputReceipt> Receipts { get { lock (_gate) return _receipts.ToArray(); } }

    public IReadOnlyList<InputReceipt> DispatchBatch(IReadOnlyList<InputDispatchRequest> requests)
    {
        ArgumentNullException.ThrowIfNull(requests);
        if (requests.Count == 0) return Array.Empty<InputReceipt>();
        var receipts = new List<InputReceipt>(requests.Count);
        lock (_gate)
        {
            BatchCount++;
            foreach (InputDispatchRequest request in requests)
            {
                _attempts.Add(request);
                DispatchOutcome outcome;
                string? error = null;
                try
                {
                    outcome = Handler?.Invoke(request) ?? DispatchOutcome.Dispatched;
                }
                catch (Exception ex)
                {
                    // Once the driver was invoked, failure cannot prove that no input reached the OS.
                    outcome = DispatchOutcome.Unknown;
                    error = ex.GetType().Name + ": " + ex.Message;
                }

                if (outcome == DispatchOutcome.Dispatched)
                {
                    _events.Add(new VirtualInputEvent(
                        request.EventId, request.RunId, request.ActionId, request.SourceEpoch,
                        request.Control, request.Phase, request.ScheduledQpc, request.DispatchQpc,
                        request.BatchId, request.Forced, Environment.CurrentManagedThreadId));
                }
                var receipt = new InputReceipt(
                    request.RunId, request.ActionId, request.SourceEpoch, request.Control,
                    request.ScheduledQpc, request.DispatchQpc, outcome, error);
                _receipts.Add(receipt);
                receipts.Add(receipt);
            }
        }
        return receipts;
    }

    public void Flush() { lock (_gate) FlushCount++; }
}

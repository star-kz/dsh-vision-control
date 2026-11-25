using Rt.Core.Contracts;
using Rt.Core.Input;

namespace Rt.Core.Runtime;

/// <summary>A shadow dispatcher that records intent and proves that no OS input was sent.</summary>
public sealed class ShadowOnlyInputDispatcher : IInputDispatcher
{
    private readonly object _sync = new();
    private readonly List<InputDispatchRequest> _attempts = [];
    private readonly List<InputReceipt> _receipts = [];
    private readonly Action<InputReceipt>? _receipt;

    public ShadowOnlyInputDispatcher(Action<InputReceipt>? receipt = null) => _receipt = receipt;
    public IReadOnlyList<InputDispatchRequest> Attempts { get { lock (_sync) return _attempts.ToArray(); } }
    public IReadOnlyList<InputReceipt> Receipts { get { lock (_sync) return _receipts.ToArray(); } }

    public IReadOnlyList<InputReceipt> DispatchBatch(IReadOnlyList<InputDispatchRequest> requests)
    {
        ArgumentNullException.ThrowIfNull(requests);
        var result = new List<InputReceipt>(requests.Count);
        lock (_sync)
        {
            foreach (InputDispatchRequest request in requests)
            {
                _attempts.Add(request);
                var receipt = new InputReceipt(request.RunId, request.ActionId, request.SourceEpoch,
                    request.Control, request.ScheduledQpc, request.DispatchQpc,
                    DispatchOutcome.NotDispatched, "shadow-only");
                _receipts.Add(receipt);
                result.Add(receipt);
            }
        }
        foreach (InputReceipt receipt in result) _receipt?.Invoke(receipt);
        return result;
    }

    public void Flush() { }
}

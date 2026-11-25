using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Windows.Input;

namespace Rt.Harness;

/// <summary>Worker receipt/ownership trace. File observation is fail-closed at the dispatcher boundary.</summary>
internal sealed class HilObserver : IInputDispatchObserver
{
    private readonly string _tracePath;
    private readonly string? _ownershipPath;
    private readonly object _sync = new();
    public HilObserver(string tracePath, string? ownershipPath)
    {
        _tracePath = tracePath;
        _ownershipPath = ownershipPath;
        if (!File.Exists(_tracePath)) File.WriteAllText(_tracePath, string.Empty);
    }
    public OwnedKeyWatchdog? Watchdog { get; set; }
    public void BeforeSend(IReadOnlyList<InputDispatchRequest> requests) { }
    public void AfterSend(IReadOnlyList<InputDispatchRequest> requests, IReadOnlyList<InputReceipt> receipts)
    {
        lock (_sync)
        {
            for (int i = 0; i < requests.Count; i++)
            {
                InputDispatchRequest request = requests[i];
                InputReceipt receipt = receipts[i];
                var row = new
                {
                    actionId = request.ActionId,
                    control = request.Control,
                    phase = request.Phase.ToString(),
                    scheduledQpc = request.ScheduledQpc,
                    dispatchQpc = receipt.DispatchQpc,
                    outcome = receipt.Outcome.ToString(),
                    forced = request.Forced,
                    batchId = request.BatchId,
                    error = receipt.Error,
                };
                RealHilRunner.AppendJsonLine(_tracePath, row);
                if (_ownershipPath is not null) RealHilRunner.AppendJsonLine(_ownershipPath, row);
                if (request.Phase == InputEventPhase.Down && receipt.Outcome != DispatchOutcome.NotDispatched)
                    Watchdog?.Register(request.Control);
                else if (request.Phase == InputEventPhase.Up && receipt.Outcome == DispatchOutcome.Dispatched)
                    Watchdog?.MarkReleased(request.Control);
            }
        }
    }
}

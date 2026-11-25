namespace Rt.Core.Contracts;

/// <summary>
/// Receipt for one dispatched input event. The fail-safe default outcome is
/// <see cref="DispatchOutcome.NotDispatched"/>, and <see cref="DefinitelyNotSent"/> is true only
/// for that proven-not-sent state — Unknown never claims the event was not sent.
/// </summary>
public readonly record struct InputReceipt(
    string RunId,
    string ActionId,
    long SourceEpoch,
    string Control,
    long ScheduledQpc,
    long DispatchQpc,
    DispatchOutcome Outcome,
    string? Error = null)
{
    /// <summary>Schema version for serialized forms; bump on any field change.</summary>
    public const int SchemaVersion = 1;

    /// <summary>True only when the event is proven never to have reached the OS.</summary>
    public bool DefinitelyNotSent => Outcome == DispatchOutcome.NotDispatched;
}

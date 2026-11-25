namespace Rt.Core.Contracts;

/// <summary>
/// Decision of one safety gate, with the run/epoch/action context needed for audit logs.
/// </summary>
public readonly record struct GateVerdict(
    string Gate,
    bool Allowed,
    string Reason,
    string? RunId = null,
    long? SourceEpoch = null,
    string? ActionId = null)
{
    /// <summary>Schema version for serialized forms; bump on any field change.</summary>
    public const int SchemaVersion = 1;

    /// <summary>Create an allowing verdict.</summary>
    public static GateVerdict Allow(string gate, string reason, string? runId = null, long? sourceEpoch = null, string? actionId = null) =>
        new(gate, true, reason, runId, sourceEpoch, actionId);

    /// <summary>Create a denying verdict.</summary>
    public static GateVerdict Deny(string gate, string reason, string? runId = null, long? sourceEpoch = null, string? actionId = null) =>
        new(gate, false, reason, runId, sourceEpoch, actionId);
}

namespace Rt.Core.Contracts;

/// <summary>What is known about whether an input event reached the OS. Wire-stable values.</summary>
public enum DispatchOutcome : byte
{
    /// <summary>Proven not dispatched (fail-safe default).</summary>
    NotDispatched = 0,

    /// <summary>Dispatch call completed.</summary>
    Dispatched = 1,

    /// <summary>Outcome unknown (e.g. process died mid-dispatch); must never be reported as not-sent.</summary>
    Unknown = 2,
}

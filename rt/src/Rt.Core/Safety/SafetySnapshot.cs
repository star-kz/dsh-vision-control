namespace Rt.Core.Safety;

/// <summary>Immutable authorization facts supplied by trusted runtime state, never OCR text.</summary>
public sealed record SafetySnapshot(string? RunId, string? TargetId, long SourceEpoch)
{
    public bool Authorized { get; init; }
    public bool Active { get; init; }
    public bool Focused { get; init; }
    public bool HeartbeatValid { get; init; }
    public long AuthorizationExpiresQpc { get; init; } = -1;
    public IReadOnlyList<string>? AllowedControls { get; init; }
    public IReadOnlyList<string>? SatisfiedPreconditions { get; init; }
    public CoordinateBounds? Bounds { get; init; }
}

/// <summary>Screen bounds in absolute pixels; right and bottom edges are exclusive.</summary>
public readonly record struct CoordinateBounds(int Left, int Top, int Width, int Height);

public static class SafetyGate
{
    public const string Authorization = "authorization";
    public const string ActiveMode = "active-mode";
    public const string Focus = "focus";
    public const string Heartbeat = "heartbeat";
    public const string SourceEpoch = "source-epoch";
    public const string AuthorizationExpiry = "authorization-expiry";
    public const string Target = "target";
    public const string Control = "control";
    public const string Preconditions = "preconditions";
    public const string PlanExpiry = "plan-expiry";
    public const string LatestQpc = "latest-qpc";
    public const string Coordinates = "coordinates";
}

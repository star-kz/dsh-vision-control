namespace Rt.Windows.Capture;

/// <summary>A shadow-only request. Window authorization is established by CaptureTarget, not by a picker.</summary>
public sealed record CaptureRequest(CaptureLogicalRect? RoiLogical = null);

public enum CaptureSessionStatus : byte
{
    Starting = 1,
    Streaming = 2,
    Invalidated = 3,
    Stopped = 4,
    Faulted = 5,
}

public sealed record CaptureStartResult(
    CaptureBackendKind Backend,
    string Detail,
    WindowsCaptureSession? Session);

public sealed record CaptureInvalidation(
    long SourceEpoch,
    CaptureInvalidationReason Reason,
    string Detail);

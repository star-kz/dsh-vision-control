namespace Rt.Windows.Capture;

/// <summary>The kind of native item captured by Windows Graphics Capture.</summary>
public enum CaptureTargetKind : byte
{
    Monitor = 1,
    Window = 2,
}

/// <summary>A native capture target. Window targets retain the caller's explicit authorization identity.</summary>
public sealed record CaptureTarget
{
    private CaptureTarget(CaptureTargetKind kind, nint handle, string? authorizationId)
    {
        Kind = kind;
        Handle = handle;
        AuthorizationId = authorizationId;
    }

    public CaptureTargetKind Kind { get; }

    public nint Handle { get; }

    public string? AuthorizationId { get; }

    public static CaptureTarget ForMonitor(nint handle)
    {
        if (handle == 0) throw new ArgumentOutOfRangeException(nameof(handle));
        return new CaptureTarget(CaptureTargetKind.Monitor, handle, null);
    }

    public static CaptureTarget ForAuthorizedWindow(nint handle, string authorizationId)
    {
        if (handle == 0) throw new ArgumentOutOfRangeException(nameof(handle));
        if (string.IsNullOrWhiteSpace(authorizationId)) throw new ArgumentException("An explicit authorization identity is required for window capture.", nameof(authorizationId));
        return new CaptureTarget(CaptureTargetKind.Window, handle, authorizationId);
    }
}

/// <summary>A rectangle in physical display pixels.</summary>
public readonly record struct CapturePixelRect(int X, int Y, int Width, int Height);

/// <summary>A rectangle in logical (96-DPI) coordinates.</summary>
public readonly record struct CaptureLogicalRect(double X, double Y, double Width, double Height);

/// <summary>Physical and logical geometry for one captured item and its ROI.</summary>
public sealed record CaptureGeometry(
    CapturePixelRect ItemPixels,
    CapturePixelRect RoiPixels,
    CaptureLogicalRect ItemLogical,
    CaptureLogicalRect RoiLogical,
    int DpiX,
    int DpiY);

namespace Rt.Windows.Capture;

public enum CaptureBackendKind : byte
{
    Unavailable = 0,
    WindowsGraphicsCapture = 1,
    DxgiDesktopDuplication = 2,
    // Deliberately no StaticScreenshot member: a still image must never impersonate a frame stream.
}

public sealed record CaptureBackendSelection(CaptureBackendKind Backend, string Detail)
{
    public bool IsStreaming => Backend is CaptureBackendKind.WindowsGraphicsCapture or CaptureBackendKind.DxgiDesktopDuplication;
}

public static class CaptureBackendSelector
{
    public static CaptureBackendSelection Select(
        bool isWindows,
        bool isWindowsGraphicsCaptureSupported,
        CaptureTargetKind targetKind = CaptureTargetKind.Monitor)
    {
        if (!isWindows)
            return new CaptureBackendSelection(CaptureBackendKind.Unavailable, "WGC/DXGI capture requires Windows; this operating system is not Windows.");
        if (!isWindowsGraphicsCaptureSupported)
        {
            return targetKind == CaptureTargetKind.Monitor
                ? new CaptureBackendSelection(
                    CaptureBackendKind.DxgiDesktopDuplication,
                    "WGC is not supported; use a real continuous DXGI Desktop Duplication monitor stream with D3D11 BGRA32 readback, never a static screenshot.")
                : new CaptureBackendSelection(
                    CaptureBackendKind.Unavailable,
                    "Capture Unavailable: WGC is not supported for the authorized window. DXGI Desktop Duplication cannot impersonate arbitrary window capture, so no monitor or static stream is substituted.");
        }
        return new CaptureBackendSelection(CaptureBackendKind.WindowsGraphicsCapture, "Real Windows Graphics Capture stream (D3D11 BGRA32 readback).");
    }
}

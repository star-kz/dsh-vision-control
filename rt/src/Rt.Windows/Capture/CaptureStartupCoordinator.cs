namespace Rt.Windows.Capture;

/// <summary>Coordinates only real native backends; no static or cross-target stream substitution.</summary>
internal static class CaptureStartupCoordinator
{
    internal static CaptureStartResult Start(
        CaptureTarget target,
        bool isWindows,
        bool isWindowsGraphicsCaptureSupported,
        Func<CaptureStartResult> startWgc,
        Func<CaptureStartResult> startDxgi)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(startWgc);
        ArgumentNullException.ThrowIfNull(startDxgi);
        var selection = CaptureBackendSelector.Select(isWindows, isWindowsGraphicsCaptureSupported, target.Kind);
        if (!selection.IsStreaming)
            return new CaptureStartResult(CaptureBackendKind.Unavailable, selection.Detail, null);
        if (selection.Backend == CaptureBackendKind.DxgiDesktopDuplication)
            return startDxgi();

        var primary = startWgc();
        if (primary.Session is not null) return primary;
        if (target.Kind != CaptureTargetKind.Monitor) return primary;
        var fallback = startDxgi();
        return fallback with { Detail = $"{primary.Detail} {fallback.Detail}" };
    }
}

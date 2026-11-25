using System.ComponentModel;

namespace Rt.Windows.Capture;

/// <summary>Capture cannot provide trustworthy physical/logical coordinates.</summary>
public sealed class CaptureUnavailableException : InvalidOperationException
{
    public CaptureUnavailableException(string message) : base(message) { }
}

/// <summary>Strict DPI awareness decision with injectable native probes for deterministic tests.</summary>
internal static class DpiAwarenessEnsurer
{
    internal static readonly nint PerMonitorV2Context = new(-4);

    public static void Ensure(
        Func<bool> setPerMonitorV2,
        Func<int> getLastError,
        Func<nint> getThreadContext,
        Func<nint, nint, bool> contextsEqual)
    {
        ArgumentNullException.ThrowIfNull(setPerMonitorV2);
        ArgumentNullException.ThrowIfNull(getLastError);
        ArgumentNullException.ThrowIfNull(getThreadContext);
        ArgumentNullException.ThrowIfNull(contextsEqual);

        if (setPerMonitorV2()) return;
        int error = getLastError();
        const int ErrorAccessDenied = 5;
        if (error != ErrorAccessDenied)
            throw new Win32Exception(error, "SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) failed.");

        nint threadContext = getThreadContext();
        if (threadContext != 0 && contextsEqual(threadContext, PerMonitorV2Context)) return;

        throw new CaptureUnavailableException(
            $"Capture Unavailable: SetProcessDpiAwarenessContext returned ACCESS_DENIED and the existing thread awareness context 0x{threadContext:X} is not PerMonitorV2. Physical/logical mapping would be untrustworthy; reconfigure the host DPI awareness before capture.");
    }
}

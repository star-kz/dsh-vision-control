namespace Rt.Windows.Input;

public sealed record HilTargetVerification(bool Ok, string Reason, WindowFacts Facts)
{
    public static HilTargetVerification Denied(string reason, WindowFacts facts) =>
        new(false, reason, facts);
}

/// <summary>Read-only, fail-closed verification of the exact self-built HIL target.</summary>
public sealed class HilTargetVerifier(IWindowFactsSource windows)
{
    public HilTargetVerification Verify(DedicatedSynthTarget requested)
    {
        WindowFacts facts;
        try { facts = windows.ReadWindow(requested.Hwnd); }
        catch (Exception ex) { return HilTargetVerification.Denied("window observation failed: " + ex.Message, WindowFacts.Empty); }

        if (facts.Hwnd != requested.Hwnd || facts.ProcessId != requested.ProcessId)
            return HilTargetVerification.Denied("hwnd or process id changed", facts);
        if (!string.Equals(facts.ProcessName, DedicatedSynthTarget.RequiredProcessName, StringComparison.Ordinal))
            return HilTargetVerification.Denied("process is not Rt.SynthWindow", facts);
        if (!string.Equals(facts.Title, requested.Title, StringComparison.Ordinal))
            return HilTargetVerification.Denied("dedicated HIL title changed", facts);
        if (!facts.IsVisible || facts.IsMinimized)
            return HilTargetVerification.Denied("dedicated HIL window is hidden or minimized", facts);
        if (facts.Bounds.Width <= 0 || facts.Bounds.Height <= 0)
            return HilTargetVerification.Denied("dedicated HIL bounds are empty", facts);
        return new HilTargetVerification(true, "verified", facts);
    }
}

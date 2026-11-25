using Rt.Core.Safety;
using Rt.Windows.Input;

namespace Rt.Tests;

public static class TargetVerifierTests
{
    private static readonly nint Hwnd = new(0x1234);
    private static DedicatedSynthTarget Target() =>
        new(Hwnd, 4242, DedicatedSynthTarget.RequiredTitleMagic + "|run-1");
    private static WindowFacts ValidFacts() =>
        new(Hwnd, 4242, DedicatedSynthTarget.RequiredProcessName, Target().Title,
            new CoordinateBounds(10, 20, 800, 600), true, false);

    private sealed class FakeWindows : IWindowFactsSource
    {
        public WindowFacts Next { get; set; } = ValidFacts();
        public Exception? ReadWindowFailure { get; set; }
        public WindowFacts ReadForeground() => Next;
        public WindowFacts ReadWindow(nint hwnd) => ReadWindowFailure is null ? Next : throw ReadWindowFailure;
    }

    [RtFact]
    public static void HilVerifier_AcceptsOnlyCurrentExactVisibleDedicatedFacts()
    {
        var windows = new FakeWindows();
        HilTargetVerification result = new HilTargetVerifier(windows).Verify(Target());
        Assert.True(result.Ok, result.Reason);
        Assert.Equal(ValidFacts(), result.Facts, "verified facts must come from the native observer");
    }

    [RtFact]
    public static void HilVerifier_RejectsChangedIdentityVisibilityAndBounds()
    {
        var windows = new FakeWindows();
        var verifier = new HilTargetVerifier(windows);
        WindowFacts[] invalid =
        [
            ValidFacts() with { Hwnd = 0 },
            ValidFacts() with { ProcessId = 999 },
            ValidFacts() with { ProcessName = "not-synth" },
            ValidFacts() with { Title = DedicatedSynthTarget.RequiredTitleMagic + "|other" },
            ValidFacts() with { IsVisible = false },
            ValidFacts() with { IsMinimized = true },
            ValidFacts() with { Bounds = default },
        ];
        foreach (WindowFacts facts in invalid)
        {
            windows.Next = facts;
            HilTargetVerification result = verifier.Verify(Target());
            Assert.False(result.Ok, "changed or unusable native facts must fail closed");
            Assert.False(string.IsNullOrWhiteSpace(result.Reason), "denial needs a diagnostic");
        }
    }

    [RtFact]
    public static void HilVerifier_ObservationFailureFailsClosed()
    {
        var windows = new FakeWindows { ReadWindowFailure = new InvalidOperationException("window observer failed") };
        HilTargetVerification result = new HilTargetVerifier(windows).Verify(Target());
        Assert.False(result.Ok, "observer exceptions must fail closed");
        Assert.True(result.Reason.Contains("window observer failed", StringComparison.Ordinal), result.Reason);
    }
}

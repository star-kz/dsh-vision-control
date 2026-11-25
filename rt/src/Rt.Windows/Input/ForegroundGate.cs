using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;

namespace Rt.Windows.Input;

/// <summary>Revalidates both live Win32 identity and run safety immediately around SendInput.</summary>
public sealed class ForegroundGate
{
    public const string Hwnd = "synth-hwnd";
    public const string Process = "synth-process";
    public const string MagicTitle = "synth-magic-title";
    public const string Focus = "synth-focus";
    public const string WindowState = "synth-window-state";
    public const string Bounds = "synth-bounds";
    public const string Run = "synth-run";

    private readonly DedicatedSynthTarget _target;
    private readonly SafetyArbiter _safety;
    private readonly IClock _clock;
    private readonly IWindowFactsSource _windows;

    public ForegroundGate(
        DedicatedSynthTarget target,
        SafetyArbiter safety,
        IClock clock,
        IWindowFactsSource windows)
    {
        _target = target ?? throw new ArgumentNullException(nameof(target));
        _safety = safety ?? throw new ArgumentNullException(nameof(safety));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
        _windows = windows ?? throw new ArgumentNullException(nameof(windows));
    }

    public IReadOnlyList<GateVerdict> EvaluateAll(InputDispatchRequest request)
    {
        WindowFacts target = _windows.ReadWindow(_target.Hwnd);
        WindowFacts foreground = _windows.ReadForeground();
        SafetySnapshot snapshot = _safety.Snapshot;
        var verdicts = new List<GateVerdict>(16);

        Add(Hwnd, target.Hwnd == _target.Hwnd && target.Hwnd != 0,
            "live hwnd must equal the registered dedicated hwnd");
        Add(Process, target.ProcessId == _target.ProcessId &&
            string.Equals(target.ProcessName, DedicatedSynthTarget.RequiredProcessName, StringComparison.Ordinal),
            "live PID and fixed process name must match the dedicated synth process");
        Add(MagicTitle, string.Equals(target.Title, _target.Title, StringComparison.Ordinal) &&
            target.Title.StartsWith(DedicatedSynthTarget.RequiredTitleMagic + "|", StringComparison.Ordinal),
            "live title must equal the registered title containing the unforgeable test-run magic");
        Add(Focus, ExactTarget(foreground),
            "foreground hwnd/process/title must all be the dedicated synth window");
        Add(WindowState, target.IsVisible && !target.IsMinimized,
            "target must be visible and not minimized");
        bool boundsMatch = target.Bounds.Width > 0 && target.Bounds.Height > 0 &&
            (!snapshot.Bounds.HasValue || snapshot.Bounds.Value.Equals(target.Bounds));
        Add(Bounds, boundsMatch, "live target bounds must equal the authorized bounds");

        // A forced release bypasses stale run state, but never any live-window check above.
        if (!request.Forced)
        {
            long now = _clock.Now;
            Add(SafetyGate.Authorization, snapshot.Authorized, "trusted user authorization is required");
            Add(SafetyGate.ActiveMode, snapshot.Active, "active mode is required; shadow denies real input");
            Add(SafetyGate.Focus, snapshot.Focused, "trusted runtime focus state is required");
            Add(SafetyGate.Heartbeat, snapshot.HeartbeatValid, "a valid heartbeat is required");
            Add(SafetyGate.SourceEpoch, snapshot.SourceEpoch == request.SourceEpoch,
                "trusted source epoch must match the dispatch request");
            Add(SafetyGate.AuthorizationExpiry, now <= snapshot.AuthorizationExpiresQpc,
                "trusted authorization validity window must be unexpired");
            Add(Run, string.Equals(snapshot.RunId, request.RunId, StringComparison.Ordinal),
                "trusted run id must match the dispatch request");
            Add(SafetyGate.Control, snapshot.AllowedControls?.Any(pattern =>
                pattern == "*" || string.Equals(pattern, request.Control, StringComparison.Ordinal)) == true,
                "control must be explicitly allowlisted");
        }
        return verdicts;

        void Add(string gate, bool allowed, string reason) => verdicts.Add(allowed
            ? GateVerdict.Allow(gate, reason, snapshot.RunId, request.SourceEpoch, request.ActionId)
            : GateVerdict.Deny(gate, reason, snapshot.RunId, request.SourceEpoch, request.ActionId));
    }

    private bool ExactTarget(WindowFacts facts) =>
        facts.Hwnd == _target.Hwnd && facts.Hwnd != 0 &&
        facts.ProcessId == _target.ProcessId &&
        string.Equals(facts.ProcessName, DedicatedSynthTarget.RequiredProcessName, StringComparison.Ordinal) &&
        string.Equals(facts.Title, _target.Title, StringComparison.Ordinal);
}

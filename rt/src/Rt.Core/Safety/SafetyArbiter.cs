using Rt.Core.Clocks;
using Rt.Core.Contracts;

namespace Rt.Core.Safety;

/// <summary>Evaluates every trusted safety gate independently at the instant before dispatch.</summary>
public sealed class SafetyArbiter
{
    private readonly IClock _clock;
    private readonly object _gate = new();
    private SafetySnapshot _snapshot = new(null, null, 0);

    public SafetyArbiter(IClock clock) => _clock = clock ?? throw new ArgumentNullException(nameof(clock));

    public SafetySnapshot Snapshot { get { lock (_gate) return _snapshot; } }

    public void Update(SafetySnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        lock (_gate) _snapshot = snapshot;
    }

    public GateVerdict Evaluate(ActionPlan plan, InputEventSpec spec, int? x = null, int? y = null)
    {
        IReadOnlyList<GateVerdict> verdicts = EvaluateAll(plan, spec, x, y);
        return verdicts.FirstOrDefault(v => !v.Allowed, verdicts[0]);
    }

    public IReadOnlyList<GateVerdict> EvaluateAll(ActionPlan plan, InputEventSpec spec, int? x = null, int? y = null)
    {
        ArgumentNullException.ThrowIfNull(plan);
        SafetySnapshot snapshot = Snapshot;
        long now = _clock.Now;
        string? runId = snapshot.RunId;
        long? epoch = plan.SourceEpoch;
        string? actionId = plan.ActionId;
        var verdicts = new List<GateVerdict>(12);

        Add(SafetyGate.Authorization, snapshot.Authorized, "trusted user authorization is required");
        Add(SafetyGate.ActiveMode, snapshot.Active, "active mode is required; shadow mode denies dispatch");
        Add(SafetyGate.Focus, snapshot.Focused, "target focus is required");
        Add(SafetyGate.Heartbeat, snapshot.HeartbeatValid, "a valid heartbeat is required");
        Add(SafetyGate.SourceEpoch, snapshot.SourceEpoch == plan.SourceEpoch,
            $"source epoch must equal plan epoch {plan.SourceEpoch}");
        Add(SafetyGate.AuthorizationExpiry, now <= snapshot.AuthorizationExpiresQpc,
            "trusted authorization validity window must be unexpired");
        Add(SafetyGate.Target, string.Equals(snapshot.TargetId, plan.TargetId, StringComparison.Ordinal),
            "plan target must match the focused trusted target");
        Add(SafetyGate.Control, ControlAllowed(snapshot.AllowedControls, spec.Control),
            "control must be explicitly allowed by trusted policy");
        Add(SafetyGate.Preconditions, PreconditionsSatisfied(snapshot.SatisfiedPreconditions, plan.Preconditions),
            "every plan precondition must be satisfied by trusted state");
        Add(SafetyGate.PlanExpiry, now <= plan.ExpiresQpc, "plan must not be expired at dispatch time");
        Add(SafetyGate.LatestQpc, now <= spec.LatestQpc, "event must not be later than LatestQpc");
        Add(SafetyGate.Coordinates, CoordinatesAllowed(snapshot.Bounds, x, y),
            "coordinates must be inside trusted absolute screen bounds");
        return verdicts;

        void Add(string gate, bool allowed, string reason) => verdicts.Add(allowed
            ? GateVerdict.Allow(gate, reason, runId, epoch, actionId)
            : GateVerdict.Deny(gate, reason, runId, epoch, actionId));
    }

    private static bool ControlAllowed(IReadOnlyList<string>? allowed, string control) =>
        allowed is not null && allowed.Any(pattern =>
            pattern == "*" || string.Equals(pattern, control, StringComparison.Ordinal));

    private static bool PreconditionsSatisfied(
        IReadOnlyList<string>? satisfied,
        IReadOnlyList<string>? required) =>
        required is null || required.All(condition => satisfied?.Contains(condition, StringComparer.Ordinal) == true);

    private static bool CoordinatesAllowed(CoordinateBounds? bounds, int? x, int? y)
    {
        if (x is null && y is null) return true;
        if (x is null || y is null || bounds is null) return false;
        CoordinateBounds b = bounds.Value;
        return b.Width > 0 && b.Height > 0 &&
            x.Value >= b.Left && x.Value < (long)b.Left + b.Width &&
            y.Value >= b.Top && y.Value < (long)b.Top + b.Height;
    }
}

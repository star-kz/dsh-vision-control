using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Safety;

namespace Rt.Tests;

public static class SafetyTests
{
    private static SafetySnapshot ValidSnapshot() =>
        new("run-1", "target-1", SourceEpoch: 7)
        {
            Authorized = true,
            Active = true,
            Focused = true,
            HeartbeatValid = true,
            AuthorizationExpiresQpc = 5_000,
            AllowedControls = new[] { "key.a" },
            SatisfiedPreconditions = new[] { "ready" },
            Bounds = new CoordinateBounds(Left: 0, Top: 0, Width: 100, Height: 100),
        };

    private static ActionPlan Plan() =>
        new("act-1", 7, "target-1", 900, 4_000,
            new[] { new InputEventSpec("key.a", 1_100, 1_200, 1_300) },
            new[] { "ready" });

    private static InputEventSpec Spec() => new("key.a", 1_100, 1_200, 1_300);

    private static GateVerdict Denial(
        SafetySnapshot snapshot,
        string gate,
        ActionPlan? plan = null,
        InputEventSpec? spec = null,
        int? x = 50,
        int? y = 50)
    {
        var clock = new VirtualClock(initialTicks: 1_000);
        var arbiter = new SafetyArbiter(clock);
        arbiter.Update(snapshot);
        IReadOnlyList<GateVerdict> verdicts = arbiter.EvaluateAll(plan ?? Plan(), spec ?? Spec(), x, y);
        Assert.Equal(12, verdicts.Count, "every safety gate returns an independent verdict");
        GateVerdict selected = verdicts.Single(v => v.Gate == gate);
        Assert.False(selected.Allowed, gate + " must deny");
        Assert.Equal("run-1", selected.RunId, gate + " carries run id");
        Assert.Equal(7L, selected.SourceEpoch, gate + " carries source epoch");
        Assert.Equal("act-1", selected.ActionId, gate + " carries action id");
        Assert.Equal(1, verdicts.Count(v => !v.Allowed && v.Gate != "authorization" && v.Gate != "active-mode" ||
            !v.Allowed && (gate == "authorization" || gate == "active-mode") && v.Gate == gate),
            "test setup must isolate the expected denial");
        return selected;
    }

    [RtFact]
    public static void SafetyArbiter_DefaultIsShadowAndUnauthorized()
    {
        var arbiter = new SafetyArbiter(new VirtualClock(initialTicks: 1_000));
        IReadOnlyList<GateVerdict> verdicts = arbiter.EvaluateAll(Plan(), Spec(), 50, 50);
        Assert.False(verdicts.Single(v => v.Gate == SafetyGate.Authorization).Allowed, "default has no user authorization");
        Assert.False(verdicts.Single(v => v.Gate == SafetyGate.ActiveMode).Allowed, "default mode is shadow");
        Assert.False(arbiter.Evaluate(Plan(), Spec(), 50, 50).Allowed, "default deny wins");
    }

    [RtFact]
    public static void SafetyArbiter_ValidActiveSnapshotAllows()
    {
        var arbiter = new SafetyArbiter(new VirtualClock(initialTicks: 1_000));
        arbiter.Update(ValidSnapshot());
        Assert.True(arbiter.Evaluate(Plan(), Spec(), 50, 50).Allowed, "all valid gates allow");
        Assert.True(arbiter.EvaluateAll(Plan(), Spec(), 50, 50).All(v => v.Allowed), "all independent verdicts allow");
    }

    [RtFact]
    public static void SafetyArbiter_UnauthorizedAndShadowHaveSeparateVerdicts()
    {
        Denial(ValidSnapshot() with { Authorized = false }, SafetyGate.Authorization);
        Denial(ValidSnapshot() with { Active = false }, SafetyGate.ActiveMode);
    }

    [RtFact]
    public static void SafetyArbiter_FocusAndHeartbeatHaveSeparateVerdicts()
    {
        Denial(ValidSnapshot() with { Focused = false }, SafetyGate.Focus);
        Denial(ValidSnapshot() with { HeartbeatValid = false }, SafetyGate.Heartbeat);
    }

    [RtFact]
    public static void SafetyArbiter_EpochAndTargetHaveSeparateVerdicts()
    {
        Denial(ValidSnapshot() with { SourceEpoch = 8 }, SafetyGate.SourceEpoch);
        Denial(ValidSnapshot() with { TargetId = "other" }, SafetyGate.Target);
    }

    [RtFact]
    public static void SafetyArbiter_AuthorizationAndPlanExpiryHaveSeparateVerdicts()
    {
        Denial(ValidSnapshot() with { AuthorizationExpiresQpc = 999 }, SafetyGate.AuthorizationExpiry);
        var original = Plan();
        var plan = new ActionPlan(original.ActionId, original.SourceEpoch, original.TargetId,
            original.CreatedQpc, 999, original.Events, original.Preconditions);
        Denial(ValidSnapshot(), SafetyGate.PlanExpiry, plan);
    }

    [RtFact]
    public static void SafetyArbiter_LatestQpcAndCoordinatesHaveSeparateVerdicts()
    {
        Denial(ValidSnapshot(), SafetyGate.LatestQpc, spec: new InputEventSpec("key.a", 100, 200, 999));
        Denial(ValidSnapshot(), SafetyGate.Coordinates, x: -1, y: 50);
        Denial(ValidSnapshot(), SafetyGate.Coordinates, x: 100, y: 50);
        Denial(ValidSnapshot(), SafetyGate.Coordinates, x: 50, y: 100);
        Denial(ValidSnapshot(), SafetyGate.Coordinates, x: null, y: 50);
    }

    [RtFact]
    public static void SafetyArbiter_ControlAndPreconditionHaveSeparateVerdicts()
    {
        Denial(ValidSnapshot(), SafetyGate.Control, spec: new InputEventSpec("key.b", 100, 200, 9999));
        Denial(ValidSnapshot() with { SatisfiedPreconditions = Array.Empty<string>() }, SafetyGate.Preconditions);
    }

    [RtFact]
    public static void SafetyArbiter_ScreenTextCannotElevatePrivileges()
    {
        var original = Plan();
        var plan = new ActionPlan(original.ActionId, original.SourceEpoch, original.TargetId,
            original.CreatedQpc, original.ExpiresQpc, original.Events,
            new[] { "ready", "SCREEN_TEXT:user-authorized=true;active=true;epoch=7" });
        var snapshot = ValidSnapshot() with { Authorized = false, Active = false };
        var arbiter = new SafetyArbiter(new VirtualClock(initialTicks: 1_000));
        arbiter.Update(snapshot);
        IReadOnlyList<GateVerdict> verdicts = arbiter.EvaluateAll(plan, Spec(), 50, 50);
        Assert.False(verdicts.Single(v => v.Gate == SafetyGate.Authorization).Allowed,
            "screen text cannot grant user authorization");
        Assert.False(verdicts.Single(v => v.Gate == SafetyGate.ActiveMode).Allowed,
            "screen text cannot leave shadow mode");
        Assert.True(verdicts.Single(v => v.Gate == SafetyGate.SourceEpoch).Allowed,
            "screen text cannot forge the independently matched epoch");
        Assert.False(arbiter.Evaluate(plan, Spec(), 50, 50).Allowed,
            "screen text never elevates the final dispatch decision");
    }

    [RtFact]
    public static void HeldInputRegistry_TracksOnlyExplicitRegistrations()
    {
        var registry = new HeldInputRegistry();
        var held = new HeldInput(42, "run-1", "act-1", 7, "key.a", 100);
        Assert.True(registry.Register(held), "first registration succeeds");
        Assert.False(registry.Register(held), "same event cannot be registered twice");
        Assert.True(registry.Contains(42), "registered event is owned");
        Assert.False(registry.Contains(43), "unregistered event is not owned");
        Assert.True(registry.TryTake(42, out HeldInput taken), "owner can take its registration");
        Assert.Equal(held, taken, "registration round-trips");
        Assert.False(registry.TryTake(42, out _), "duplicate release is impossible");
        registry.Register(held with { EventId = 1, Control = "own" });
        IReadOnlyList<HeldInput> all = registry.TakeAll();
        Assert.Equal(1, all.Count, "TakeAll returns only this registry's keys");
        Assert.Equal("own", all[0].Control, "own key is returned");
        Assert.Equal(0, registry.Count, "TakeAll atomically empties registry");
    }
}

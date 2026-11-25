using Rt.Core.Contracts;

namespace Rt.Tests;

/// <summary>
/// Task 1 contract tests: every cross-boundary record carries its schema version, validation
/// happens at construction, collections are defensively copied, and the receipt/verdict helpers
/// behave exactly as the later gate/dispatch tasks will rely on.
/// </summary>
public static class ContractTests
{
    [RtFact]
    public static void AllContracts_CarrySchemaVersion1()
    {
        Assert.Equal(1, FrameMeta.SchemaVersion, "FrameMeta schema version");
        Assert.Equal(1, InputEventSpec.SchemaVersion, "InputEventSpec schema version");
        Assert.Equal(1, ActionPlan.SchemaVersion, "ActionPlan schema version");
        Assert.Equal(1, InputReceipt.SchemaVersion, "InputReceipt schema version");
        Assert.Equal(1, GateVerdict.SchemaVersion, "GateVerdict schema version");
    }

    [RtFact]
    public static void FrameMeta_CarriesAllFields()
    {
        var meta = new FrameMeta(
            Sequence: 42,
            SourceId: "cam-0",
            SourceEpoch: 7,
            CapturedQpc: 1_000,
            ReceivedQpc: 1_050,
            Width: 1920,
            Height: 1080,
            Format: FramePixelFormat.Bgra32);

        Assert.Equal(42L, meta.Sequence, "sequence round-trips");
        Assert.Equal("cam-0", meta.SourceId, "source id round-trips");
        Assert.Equal(7L, meta.SourceEpoch, "source epoch round-trips");
        Assert.Equal(1_000L, meta.CapturedQpc, "captured QPC round-trips");
        Assert.Equal(1_050L, meta.ReceivedQpc, "received QPC round-trips");
        Assert.Equal(1920, meta.Width, "width round-trips");
        Assert.Equal(1080, meta.Height, "height round-trips");
        Assert.Equal(FramePixelFormat.Bgra32, meta.Format, "pixel format round-trips");
        Assert.Equal((byte)1, (byte)FramePixelFormat.Bgra32, "Bgra32 wire value is stable at 1");
        Assert.Equal((byte)0, (byte)FramePixelFormat.Unknown, "Unknown wire value is stable at 0");
    }

    [RtFact]
    public static void ActionPlan_ValidatesAndCopiesAtConstruction()
    {
        var events = new List<InputEventSpec>
        {
            new("mouse.left", DownQpc: 100, UpQpc: 200, LatestQpc: 250),
        };
        var preconditions = new List<string> { "focus:capture-window" };

        var plan = new ActionPlan("act-1", 3, "target-9", 90, 5_000, events, preconditions);

        Assert.Equal("act-1", plan.ActionId, "action id round-trips");
        Assert.Equal(3L, plan.SourceEpoch, "source epoch round-trips");
        Assert.Equal("target-9", plan.TargetId, "target id round-trips");
        Assert.Equal(90L, plan.CreatedQpc, "created QPC round-trips");
        Assert.Equal(5_000L, plan.ExpiresQpc, "expires QPC round-trips");
        Assert.Equal(1, plan.Events.Count, "events round-trip");
        Assert.Equal(1, Assert.NotNull(plan.Preconditions, "preconditions round-trip").Count, "preconditions count");

        InputEventSpec spec = plan.Events[0];
        Assert.Equal("mouse.left", spec.Control, "event control round-trips");
        Assert.Equal(100L, spec.DownQpc, "event down QPC round-trips");
        Assert.Equal(200L, spec.UpQpc, "event up QPC round-trips");
        Assert.Equal(250L, spec.LatestQpc, "event latest QPC round-trips");

        // Defensive copy: mutating the caller's lists must not change the plan.
        events.Clear();
        preconditions.Clear();
        Assert.Equal(1, plan.Events.Count, "plan snapshots events at construction");
        Assert.Equal(1, plan.Preconditions!.Count, "plan snapshots preconditions at construction");

        // Expiry must not precede creation.
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new ActionPlan("a", 1, "t", 500, 499, Array.Empty<InputEventSpec>()),
            "expiresQpc before createdQpc is rejected");

        // Identity fields must be present.
        Assert.Throws<ArgumentException>(
            () => new ActionPlan("", 1, "t", 0, 1, Array.Empty<InputEventSpec>()),
            "empty actionId is rejected");
        Assert.Throws<ArgumentException>(
            () => new ActionPlan("a", 1, "", 0, 1, Array.Empty<InputEventSpec>()),
            "empty targetId is rejected");
        Assert.Throws<ArgumentNullException>(
            () => new ActionPlan("a", 1, "t", 0, 1, null!),
            "null events list is rejected");
    }

    [RtFact]
    public static void InputReceipt_DefinitelyNotSent_OnlyForNotDispatched()
    {
        var notSent = new InputReceipt("run-1", "act-1", 5, "mouse.left", 1_000, 0, DispatchOutcome.NotDispatched, "expired before dispatch");
        Assert.True(notSent.DefinitelyNotSent, "NotDispatched means the event definitely never reached the OS");
        Assert.Equal("run-1", notSent.RunId, "run id round-trips");
        Assert.Equal("act-1", notSent.ActionId, "action id round-trips");
        Assert.Equal(5L, notSent.SourceEpoch, "source epoch round-trips");
        Assert.Equal("expired before dispatch", notSent.Error, "error round-trips");

        var dispatched = notSent with { Outcome = DispatchOutcome.Dispatched };
        Assert.False(dispatched.DefinitelyNotSent, "Dispatched is not 'definitely not sent'");
        var unknown = notSent with { Outcome = DispatchOutcome.Unknown };
        Assert.False(unknown.DefinitelyNotSent, "Unknown must never claim 'definitely not sent'");

        Assert.Equal(DispatchOutcome.NotDispatched, default(InputReceipt).Outcome, "default receipt outcome is NotDispatched (fail-safe)");
        Assert.True(default(InputReceipt).DefinitelyNotSent, "default receipt is definitely-not-sent");
    }

    [RtFact]
    public static void GateVerdict_AllowAndDeny_CarryContext()
    {
        GateVerdict allow = GateVerdict.Allow("user-intent", "explicit click requested", runId: "run-7", sourceEpoch: 2, actionId: "act-3");
        Assert.True(allow.Allowed, "Allow sets Allowed=true");
        Assert.Equal("user-intent", allow.Gate, "gate name round-trips");
        Assert.Equal("explicit click requested", allow.Reason, "reason round-trips");
        Assert.Equal("run-7", allow.RunId, "run id round-trips");
        Assert.Equal(2L, allow.SourceEpoch, "source epoch round-trips");
        Assert.Equal("act-3", allow.ActionId, "action id round-trips");

        GateVerdict deny = GateVerdict.Deny("epoch-guard", "source epoch changed", runId: "run-8");
        Assert.False(deny.Allowed, "Deny sets Allowed=false");
        Assert.Equal("epoch-guard", deny.Gate, "deny gate name round-trips");
        Assert.Equal("source epoch changed", deny.Reason, "deny reason round-trips");
        Assert.Equal("run-8", deny.RunId, "deny run id round-trips");
        Assert.Null(deny.SourceEpoch, "optional source epoch stays null when not given");
        Assert.Null(deny.ActionId, "optional action id stays null when not given");

        GateVerdict bare = GateVerdict.Allow("g", "r");
        Assert.Null(bare.RunId, "bare allow has no run id");
    }
}

using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;
using Rt.Windows.Input;

namespace Rt.Tests;

public static class InputTests
{
    private static readonly nint Hwnd = new(0x1234);

    private static DedicatedSynthTarget Target() =>
        new(Hwnd, 4242, DedicatedSynthTarget.RequiredTitleMagic + "|run-1");

    private static WindowFacts Facts() =>
        new(Hwnd, 4242, DedicatedSynthTarget.RequiredProcessName,
            DedicatedSynthTarget.RequiredTitleMagic + "|run-1",
            new CoordinateBounds(100, 200, 800, 600), IsVisible: true, IsMinimized: false);

    private static InputDispatchRequest Request(
        string control = "key.a",
        InputEventPhase phase = InputEventPhase.Down,
        bool forced = false) =>
        new(11, "run-1", "act-1", 7, control, phase, 900, 950, 3, 1, forced);

    private static SafetySnapshot ValidSafety() =>
        new("run-1", "synth", 7)
        {
            Authorized = true,
            Active = true,
            Focused = true,
            HeartbeatValid = true,
            AuthorizationExpiresQpc = 5_000,
            AllowedControls = new[] { "key.a", "key.s", "key.d", "key.f", "key.right" },
            Bounds = new CoordinateBounds(100, 200, 800, 600),
        };

    private sealed class FakeWindows : IWindowFactsSource
    {
        public WindowFacts Target { get; set; } = Facts();
        public WindowFacts Foreground { get; set; } = Facts();
        public Func<WindowFacts>? WindowReader { get; set; }
        public WindowFacts ReadForeground() => Foreground;
        public WindowFacts ReadWindow(nint hwnd) => WindowReader?.Invoke() ?? Target;
    }

    private sealed class FakeNative : ISendInputNative
    {
        public int CallCount { get; private set; }
        public IReadOnlyList<SendInputFrame> Frames { get; private set; } = Array.Empty<SendInputFrame>();
        public Func<IReadOnlyList<SendInputFrame>, SendInputNativeResult>? Handler { get; set; }

        public SendInputNativeResult Send(IReadOnlyList<SendInputFrame> inputs)
        {
            CallCount++;
            Frames = inputs.ToArray();
            return Handler?.Invoke(Frames) ?? new SendInputNativeResult(Frames.Count, 0);
        }
    }

    private sealed class FakeObserver : IInputDispatchObserver
    {
        public Action? Before { get; set; }
        public Action? After { get; set; }
        public void BeforeSend(IReadOnlyList<InputDispatchRequest> requests) => Before?.Invoke();
        public void AfterSend(IReadOnlyList<InputDispatchRequest> requests, IReadOnlyList<InputReceipt> receipts) => After?.Invoke();
    }

    private static (ForegroundGate Gate, FakeWindows Windows, VirtualClock Clock, SafetyArbiter Safety) GateFixture()
    {
        var clock = new VirtualClock(initialTicks: 1_000);
        var safety = new SafetyArbiter(clock);
        safety.Update(ValidSafety());
        var windows = new FakeWindows();
        return (new ForegroundGate(Target(), safety, clock, windows), windows, clock, safety);
    }

    private static GateVerdict Denial(IReadOnlyList<GateVerdict> verdicts, string gate)
    {
        GateVerdict verdict = verdicts.Single(v => v.Gate == gate);
        Assert.False(verdict.Allowed, gate + " must deny");
        return verdict;
    }

    [RtFact]
    public static void KeyboardMapping_UsesPhysicalScanCodesAndExplicitExtendedFlag()
    {
        SendInputFrame a = KeyboardMapping.Resolve("key.a", InputEventPhase.Down);
        Assert.Equal((ushort)0x1E, a.ScanCode, "A uses its physical set-1 scan code");
        Assert.Equal((ushort)0x41, a.VirtualKey, "A has an explicit layout-independent VK mapping");
        Assert.False(a.KeyUp, "down does not carry KEYEVENTF_KEYUP");
        Assert.False(a.Extended, "A is not an extended key");

        SendInputFrame rightUp = KeyboardMapping.Resolve("key.right", InputEventPhase.Up);
        Assert.Equal((ushort)0x4D, rightUp.ScanCode, "right arrow uses its physical scan code");
        Assert.Equal((ushort)0x27, rightUp.VirtualKey, "right arrow has an explicit VK mapping");
        Assert.True(rightUp.Extended, "right arrow carries KEYEVENTF_EXTENDEDKEY");
        Assert.True(rightUp.KeyUp, "up carries KEYEVENTF_KEYUP");
        Assert.Throws<ArgumentException>(() => KeyboardMapping.Resolve("key.not-allowlisted", InputEventPhase.Down),
            "unknown controls are rejected before any OS call");
    }

    [RtFact]
    public static void ForegroundGate_WrongHwndProcessOrMagicTitleEachDeny()
    {
        var (gate, windows, _, _) = GateFixture();
        windows.Target = windows.Target with { Hwnd = new nint(0x9999) };
        Denial(gate.EvaluateAll(Request()), ForegroundGate.Hwnd);

        (gate, windows, _, _) = GateFixture();
        windows.Target = windows.Target with { ProcessId = 999, ProcessName = "not-synth" };
        Denial(gate.EvaluateAll(Request()), ForegroundGate.Process);

        (gate, windows, _, _) = GateFixture();
        windows.Target = windows.Target with { Title = "RT-SYNTH-HIL-9D27C4|forged" };
        Denial(gate.EvaluateAll(Request()), ForegroundGate.MagicTitle);
    }

    [RtFact]
    public static void ForegroundGate_FocusWindowStateAndBoundsAreIndependent()
    {
        var (gate, windows, _, safety) = GateFixture();
        windows.Foreground = windows.Foreground with { Hwnd = new nint(0x4444) };
        Denial(gate.EvaluateAll(Request()), ForegroundGate.Focus);

        (gate, windows, _, _) = GateFixture();
        windows.Target = windows.Target with { IsMinimized = true };
        Denial(gate.EvaluateAll(Request()), ForegroundGate.WindowState);

        (gate, windows, _, _) = GateFixture();
        windows.Target = windows.Target with { Bounds = new CoordinateBounds(90, 200, 800, 600) };
        Denial(gate.EvaluateAll(Request()), ForegroundGate.Bounds);

        (gate, _, _, safety) = GateFixture();
        safety.Update(ValidSafety() with { Focused = false });
        Denial(gate.EvaluateAll(Request()), SafetyGate.Focus);
    }

    [RtFact]
    public static void ForegroundGate_AuthorizationHeartbeatEpochAndExpiryAreRechecked()
    {
        var (gate, _, clock, safety) = GateFixture();
        safety.Update(ValidSafety() with { Authorized = false });
        Denial(gate.EvaluateAll(Request()), SafetyGate.Authorization);

        (gate, _, _, safety) = GateFixture();
        safety.Update(ValidSafety() with { HeartbeatValid = false });
        Denial(gate.EvaluateAll(Request()), SafetyGate.Heartbeat);

        (gate, _, _, safety) = GateFixture();
        safety.Update(ValidSafety() with { SourceEpoch = 8 });
        Denial(gate.EvaluateAll(Request()), SafetyGate.SourceEpoch);

        (gate, _, clock, safety) = GateFixture();
        clock.AdvanceTo(5_001);
        Denial(gate.EvaluateAll(Request()), SafetyGate.AuthorizationExpiry);
    }

    [RtFact]
    public static void ForegroundGate_ForcedUpBypassesStaleRunGatesButNeverWrongTarget()
    {
        var (gate, windows, clock, safety) = GateFixture();
        safety.Update(ValidSafety() with
        {
            Authorized = false,
            Active = false,
            HeartbeatValid = false,
            SourceEpoch = 999,
        });
        clock.AdvanceTo(9_000);
        Assert.True(gate.EvaluateAll(Request(phase: InputEventPhase.Up, forced: true)).All(v => v.Allowed),
            "forced UP remains possible after stale authorization/heartbeat/epoch");

        windows.Foreground = windows.Foreground with { Hwnd = new nint(0x7777) };
        Denial(gate.EvaluateAll(Request(phase: InputEventPhase.Up, forced: true)), ForegroundGate.Focus);
    }

    [RtFact]
    public static void SendInputDispatcher_SuccessReturnsRealBeforeAndAfterFacts()
    {
        var (gate, _, clock, _) = GateFixture();
        var native = new FakeNative { Handler = _ => { clock.AdvanceTo(1_100); return new SendInputNativeResult(1, 0); } };
        var dispatcher = new SendInputDispatcher(gate, native, clock);

        InputReceipt receipt = dispatcher.DispatchBatch(new[] { Request() }).Single();

        Assert.Equal(DispatchOutcome.Dispatched, receipt.Outcome, "complete native insertion is dispatched");
        Assert.Equal(1_000L, receipt.DispatchQpc, "receipt uses the actual pre-call QPC, not the scheduler's stale timestamp");
        SendInputCallFacts call = dispatcher.Calls.Single();
        Assert.Equal(1_000L, call.BeforeQpc, "pre-call QPC is recorded");
        Assert.Equal(1_100L, call.AfterQpc, "post-call QPC is recorded");
        Assert.True(call.NativeInvoked, "native call fact is explicit");
        Assert.Equal(1, call.InsertedCount, "native inserted count is retained");
        Assert.Equal((ushort)0x1E, native.Frames.Single().ScanCode, "real boundary receives the physical scan code");
        Assert.True(call.BeforeVerdicts.All(v => v.Allowed) && call.AfterVerdicts.All(v => v.Allowed),
            "both target/safety evaluations are retained");
    }

    [RtFact]
    public static void SendInputDispatcher_PartialBatchAndTimeoutAreUnknownNeverNotSent()
    {
        var (gate, _, clock, _) = GateFixture();
        var partialNative = new FakeNative { Handler = _ => new SendInputNativeResult(1, 0) };
        var partial = new SendInputDispatcher(gate, partialNative, clock);
        InputReceipt[] receipts = partial.DispatchBatch(new[] { Request(), Request(control: "key.s") }).ToArray();
        Assert.True(receipts.All(r => r.Outcome == DispatchOutcome.Unknown), "every partial-batch outcome is conservative unknown");
        Assert.True(receipts.All(r => !r.DefinitelyNotSent), "partial send never claims definite non-dispatch");
        Assert.Equal(2, partial.Calls.Single().RequestedCount, "requested native batch size is recorded");
        Assert.Equal(1, partial.Calls.Single().InsertedCount, "partial native count is recorded");

        var timeoutNative = new FakeNative { Handler = _ => throw new TimeoutException("simulated native timeout") };
        var timeout = new SendInputDispatcher(gate, timeoutNative, clock);
        InputReceipt timedOut = timeout.DispatchBatch(new[] { Request() }).Single();
        Assert.Equal(DispatchOutcome.Unknown, timedOut.Outcome, "exception after native invocation is unknown");
        Assert.True(timeout.Calls.Single().TimedOut, "timeout fact is preserved");
        Assert.False(timedOut.DefinitelyNotSent, "timeout never claims definite non-dispatch");
    }

    [RtFact]
    public static void SendInputDispatcher_GateDenialAndBadControlFailBeforeNative()
    {
        var (gate, _, clock, safety) = GateFixture();
        safety.Update(ValidSafety() with { HeartbeatValid = false });
        var native = new FakeNative();
        var dispatcher = new SendInputDispatcher(gate, native, clock);
        InputReceipt denied = dispatcher.DispatchBatch(new[] { Request() }).Single();
        Assert.Equal(DispatchOutcome.NotDispatched, denied.Outcome, "pre-call denial is definitely not dispatched");
        Assert.Equal(0, native.CallCount, "denied input never reaches SendInput");
        Assert.False(dispatcher.Calls.Single().NativeInvoked, "call fact proves no native invocation");

        var (validGate, _, validClock, _) = GateFixture();
        native = new FakeNative();
        dispatcher = new SendInputDispatcher(validGate, native, validClock);
        InputReceipt invalid = dispatcher.DispatchBatch(new[] { Request(control: "key.invalid") }).Single();
        Assert.Equal(DispatchOutcome.NotDispatched, invalid.Outcome, "invalid mapping fails before dispatch");
        Assert.Equal(0, native.CallCount, "invalid control never reaches SendInput");
    }

    [RtFact]
    public static void SendInputDispatcher_TargetChangeDuringNativeCallIsUnknown()
    {
        var (gate, windows, clock, _) = GateFixture();
        var native = new FakeNative
        {
            Handler = _ =>
            {
                windows.Foreground = windows.Foreground with { Hwnd = new nint(0x8888) };
                return new SendInputNativeResult(1, 0);
            },
        };
        var dispatcher = new SendInputDispatcher(gate, native, clock);
        InputReceipt receipt = dispatcher.DispatchBatch(new[] { Request() }).Single();
        Assert.Equal(DispatchOutcome.Unknown, receipt.Outcome, "post-call target mismatch cannot claim clean dispatch");
        Assert.False(receipt.DefinitelyNotSent, "post-call mismatch is never rewritten as not-sent");
        Assert.True(dispatcher.Calls.Single().NativeInvoked, "native call did happen");
        Assert.True(dispatcher.Calls.Single().AfterVerdicts.Any(v => !v.Allowed), "post-call mismatch is retained");
    }

    [RtFact]
    public static void SendInputDispatcher_PostNativeObservationFailureIsUnknownAndRecorded()
    {
        var (gate, windows, clock, _) = GateFixture();
        var native = new FakeNative
        {
            Handler = _ =>
            {
                windows.WindowReader = () => throw new IOException("window facts lost after native invocation");
                return new SendInputNativeResult(1, 0);
            },
        };
        var dispatcher = new SendInputDispatcher(gate, native, clock);
        InputReceipt receipt = dispatcher.DispatchBatch(new[] { Request() }).Single();
        Assert.Equal(DispatchOutcome.Unknown, receipt.Outcome,
            "failure to observe facts after native invocation cannot erase possible delivery");
        Assert.False(receipt.DefinitelyNotSent, "post-native observation failure is never definite non-dispatch");
        SendInputCallFacts call = dispatcher.Calls.Single();
        Assert.True(call.NativeInvoked, "native invocation fact must survive the observation failure");
        Assert.True((call.Error ?? string.Empty).Contains("post-dispatch window observation", StringComparison.Ordinal),
            "call facts explain the conservative outcome");
    }

    [RtFact]
    public static void SendInputDispatcher_ObserverFailureBeforeIsFailedAndAfterIsUnknown()
    {
        var (gate, _, clock, _) = GateFixture();
        var native = new FakeNative();
        var before = new SendInputDispatcher(gate, native, clock, new FakeObserver
        {
            Before = () => throw new IOException("journal not durable"),
        });
        InputReceipt beforeReceipt = before.DispatchBatch(new[] { Request() }).Single();
        Assert.Equal(DispatchOutcome.NotDispatched, beforeReceipt.Outcome, "failed pre-call ownership journal prevents input");
        Assert.Equal(0, native.CallCount, "pre-call observer failure is before dispatch");

        native = new FakeNative();
        var after = new SendInputDispatcher(gate, native, clock, new FakeObserver
        {
            After = () => throw new IOException("trace write failed"),
        });
        InputReceipt afterReceipt = after.DispatchBatch(new[] { Request() }).Single();
        Assert.Equal(DispatchOutcome.Unknown, afterReceipt.Outcome, "post-call observer failure cannot erase dispatch");
        Assert.Equal(1, native.CallCount, "post-call observer failure happens after native input");
    }
}

using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;
using Rt.Core.Scheduling;

namespace Rt.Tests;

public static class SchedulerTests
{
    private const long MaxHold = 100;

    private static SafetyArbiter CreateSafety(IClock clock, string runId = "run-1", long epoch = 1)
    {
        var safety = new SafetyArbiter(clock);
        safety.Update(new SafetySnapshot(runId, "target-1", epoch)
        {
            Authorized = true,
            Active = true,
            Focused = true,
            HeartbeatValid = true,
            AuthorizationExpiresQpc = long.MaxValue,
            AllowedControls = new[] { "*" },
            Bounds = new CoordinateBounds(0, 0, 10_000, 10_000),
        });
        return safety;
    }

    private static ActionPlan Plan(string id, long created, long expires, params InputEventSpec[] events) =>
        new(id, 1, "target-1", created, expires, events);

    private static void WaitForDeadline(VirtualClock clock, long deadline) =>
        Spin.WaitForCondition(() => clock.EarliestPendingDeadline == deadline,
            $"scheduler waits for {deadline}; actual={clock.EarliestPendingDeadline}");

    private static void RunToCompletion(VirtualClock clock, Rt.Core.Scheduling.Scheduler scheduler)
    {
        for (int guard = 0; guard < 20_000; guard++)
        {
            Spin.WaitForCondition(
                () => scheduler.PendingCount == 0 || clock.EarliestPendingDeadline is not null,
                "scheduler either finishes or registers its next virtual-clock deadline");
            if (scheduler.PendingCount == 0)
            {
                Spin.WaitForCondition(() => scheduler.IsIdle, "scheduler becomes idle after final batch");
                return;
            }

            long deadline = clock.EarliestPendingDeadline
                ?? throw new InvalidOperationException("deadline disappeared before virtual advance");
            long cycle = scheduler.DispatchCycle;
            clock.AdvanceTo(deadline);
            Spin.WaitForCondition(() => scheduler.DispatchCycle > cycle,
                $"scheduler completes batch at {deadline}");
        }
        Assert.Fail("virtual schedule did not quiesce within 20,000 batches");
    }

    [RtFact]
    public static void Scheduler_DedicatedThreadBatchesSameTimestampDownAndUp()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);
        Assert.True(scheduler.TrySchedule(Plan("act", 0, 1_000,
            new InputEventSpec("a", 100, 100, 100),
            new InputEventSpec("b", 100, 100, 100))), "valid plan accepted");

        RunToCompletion(clock, scheduler);

        Assert.Equal(1, dispatcher.BatchCount, "all same-tick down/up events use one driver batch");
        Assert.Equal(4, dispatcher.Events.Count, "two downs and two ups dispatched");
        Assert.Equal(4, dispatcher.Events.Select(e => e.BatchId).Distinct().Count() == 1 ? 4 : 0,
            "every event carries the same batch id");
        Assert.True(dispatcher.Events.All(e => e.ThreadId != Environment.CurrentManagedThreadId),
            "dispatch never runs on the submitting thread");
        Assert.Equal(1, dispatcher.Events.Select(e => e.ThreadId).Distinct().Count(),
            "one dedicated scheduler thread performs all dispatch");
        foreach (IGrouping<string, VirtualInputEvent> group in dispatcher.Events.GroupBy(e => e.Control))
        {
            Assert.Equal(InputEventPhase.Down, group.First().Phase, group.Key + " down precedes up");
            Assert.Equal(InputEventPhase.Up, group.Last().Phase, group.Key + " up follows down");
        }
    }

    [RtFact]
    public static void Scheduler_RechecksAllSafetyImmediatelyBeforeDispatch()
    {
        var clock = new VirtualClock();
        var safety = CreateSafety(clock);
        var dispatcher = new VirtualInputDispatcher();
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, safety, dispatcher, "run-1", MaxHold);
        scheduler.TrySchedule(Plan("act", 0, 1_000, new InputEventSpec("a", 100, 200, 150)));
        WaitForDeadline(clock, 100);
        safety.Update(safety.Snapshot with { Active = false });
        RunToCompletion(clock, scheduler);

        Assert.Equal(0, dispatcher.Events.Count, "shadow transition before due time prevents dispatch");
        InputReceipt receipt = scheduler.Receipts.Single();
        Assert.Equal(DispatchOutcome.NotDispatched, receipt.Outcome, "denied down is definitely not sent");
        Assert.True(receipt.DefinitelyNotSent, "receipt retains fail-safe not-sent semantics");
        Assert.Equal(SafetyGate.ActiveMode, scheduler.GateVerdicts.Last(v => !v.Allowed).Gate,
            "dispatch-time verdict explains the denial");
    }

    [RtFact]
    public static void Scheduler_ExpiredDownIsCancelledNotReplayed()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);
        scheduler.TrySchedule(Plan("late", 0, 140, new InputEventSpec("a", 100, 300, 150)));
        WaitForDeadline(clock, 100);
        clock.AdvanceTo(200);
        Spin.WaitForCondition(() => scheduler.PendingCount == 0 && scheduler.IsIdle, "expired plan cancels completely");

        Assert.Equal(0, dispatcher.Events.Count, "late down and its unowned up are never dispatched");
        Assert.Equal(DispatchOutcome.NotDispatched, scheduler.Receipts.Single().Outcome,
            "expired down has a definite not-dispatched receipt");
        Assert.True(scheduler.GateVerdicts.Any(v => v.Gate == SafetyGate.PlanExpiry && !v.Allowed),
            "plan expiry is independently audited");
        Assert.True(scheduler.GateVerdicts.Any(v => v.Gate == SafetyGate.LatestQpc && !v.Allowed),
            "latest QPC is independently audited");
    }

    [RtFact]
    public static void Scheduler_MaxHoldForcesUpAtCap()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);
        scheduler.TrySchedule(Plan("hold", 0, 2_000, new InputEventSpec("a", 100, 1_000, 150)));
        RunToCompletion(clock, scheduler);

        Assert.Equal(2, dispatcher.Events.Count, "down and capped up are paired");
        Assert.Equal(100L, dispatcher.Events[0].DispatchQpc, "down at requested time");
        Assert.Equal(200L, dispatcher.Events[1].DispatchQpc, "up at down 100 + max-hold 100, not requested late up");
        Assert.Equal(InputEventPhase.Up, dispatcher.Events[1].Phase, "cap generates an UP");
        Assert.Equal(0, scheduler.HeldCount, "cap releases registry ownership");
    }

    [RtFact]
    public static void Scheduler_CancelCancelsPendingAndForcesHeldUp()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);
        scheduler.TrySchedule(Plan("cancel", 0, 1_000,
            new InputEventSpec("a", 100, 500, 150),
            new InputEventSpec("b", 200, 500, 250)));
        WaitForDeadline(clock, 100);
        clock.AdvanceTo(100);
        Spin.WaitForCondition(() => dispatcher.Events.Count(e => e.Phase == InputEventPhase.Down) == 1,
            "first key is down before cancellation");

        scheduler.Cancel("cancel");

        Assert.Equal(2, dispatcher.Events.Count, "only held down and forced up are dispatched");
        Assert.Equal("a", dispatcher.Events[1].Control, "held key is released");
        Assert.Equal(InputEventPhase.Up, dispatcher.Events[1].Phase, "cancel emits UP");
        Assert.True(dispatcher.Events[1].Forced, "cancel UP is marked forced");
        Assert.Equal(0, scheduler.PendingCount, "cancel removes every pending plan entry");
        Assert.Equal(0, scheduler.HeldCount, "cancel empties owned registrations");
        Assert.True(scheduler.Receipts.Any(r => r.Control == "b" && r.Outcome == DispatchOutcome.NotDispatched),
            "pending down has definite cancellation receipt");
    }

    [RtFact]
    public static void Scheduler_EmergencyStopIsIdempotentAndFreezesPlans()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);
        scheduler.TrySchedule(Plan("estop", 0, 1_000, new InputEventSpec("a", 100, 500, 150)));
        WaitForDeadline(clock, 100);
        clock.AdvanceTo(100);
        Spin.WaitForCondition(() => scheduler.HeldCount == 1, "key registered before emergency stop");

        scheduler.EmergencyStop();
        scheduler.EmergencyStop();

        Assert.Equal(2, dispatcher.Events.Count, "repeated emergency stop never duplicates release");
        Assert.True(dispatcher.Events.Last().Forced, "emergency stop forces UP");
        Assert.False(scheduler.IsAcceptingPlans, "emergency stop freezes new plans");
        Assert.False(scheduler.IsRunning, "emergency stop exits scheduler thread");
        Assert.False(scheduler.TrySchedule(Plan("new", 100, 900, new InputEventSpec("b", 200, 300, 250))),
            "new plan is rejected after freeze");
        Assert.Equal(1, dispatcher.FlushCount, "dispatcher flushes once during terminal stop");
        scheduler.Dispose();
    }

    [RtFact]
    public static void Scheduler_StopReleasesOnlyItsOwnRegisteredKeys()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        var safety = CreateSafety(clock);
        var registry = new HeldInputRegistry();
        using var first = new Rt.Core.Scheduling.Scheduler(clock, safety, dispatcher, "run-1", MaxHold, registry);
        using var second = new Rt.Core.Scheduling.Scheduler(clock, safety, dispatcher, "run-1", MaxHold, registry);
        first.TrySchedule(Plan("first", 0, 1_000, new InputEventSpec("own-a", 100, 500, 150)));
        second.TrySchedule(Plan("second", 0, 1_000, new InputEventSpec("own-b", 100, 500, 150)));
        Spin.WaitForCondition(() => clock.PendingWaiterCount == 2, "both schedulers wait at the same deadline");
        clock.AdvanceTo(100);
        Spin.WaitForCondition(() =>
            dispatcher.Events.Count(e => e.Phase == InputEventPhase.Down) == 2 &&
            first.HeldCount == 1 && second.HeldCount == 1 && registry.Count == 2,
            "both dispatch batches finish registering their owned keys before stop can interleave");
        Assert.Equal(2, registry.Count, "schedulers sharing a registry still own distinct event ids");

        first.Stop();

        Assert.Equal(0, first.HeldCount, "stopped scheduler releases its registry");
        Assert.Equal(1, second.HeldCount, "other scheduler registration is untouched");
        Assert.Equal(1, registry.Count, "shared registry retains only the other scheduler's key");
        Assert.Equal(1, dispatcher.Events.Count(e => e.Phase == InputEventPhase.Up && e.Control == "own-a"),
            "own key released once");
        Assert.Equal(0, dispatcher.Events.Count(e => e.Phase == InputEventPhase.Up && e.Control == "own-b"),
            "other scheduler key is not released");
        second.Stop();
        Assert.Equal(1, dispatcher.Events.Count(e => e.Phase == InputEventPhase.Up && e.Control == "own-b"),
            "second scheduler releases its own key at its own stop");
    }

    [RtFact]
    public static void Scheduler_PartialAndTimeoutOutcomesAreUnknownAndNeverRetried()
    {
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher
        {
            Handler = request => request.Control == "b" && request.Phase == InputEventPhase.Down
                ? throw new TimeoutException("simulated driver timeout after partial batch")
                : DispatchOutcome.Dispatched,
        };
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);
        scheduler.TrySchedule(Plan("partial", 0, 1_000,
            new InputEventSpec("a", 100, 200, 150),
            new InputEventSpec("b", 100, 200, 150)));
        RunToCompletion(clock, scheduler);

        Assert.Equal(1, dispatcher.Attempts.Count(r => r.Control == "a" && r.Phase == InputEventPhase.Down),
            "confirmed down attempted once");
        Assert.Equal(1, dispatcher.Attempts.Count(r => r.Control == "b" && r.Phase == InputEventPhase.Down),
            "timed-out down is never blindly retried");
        Assert.Equal(2, dispatcher.BatchCount, "only the original down batch and release batch occur");
        InputReceipt unknown = scheduler.Receipts.Single(r => r.Control == "b" && r.Outcome == DispatchOutcome.Unknown);
        Assert.False(unknown.DefinitelyNotSent, "unknown never claims not-sent");
        Assert.Equal(1, dispatcher.Receipts.Count(r => r.Outcome == DispatchOutcome.Unknown),
            "partial timeout is reported unknown exactly once");
        Assert.Equal(1, dispatcher.Attempts.Count(r => r.Control == "b" && r.Phase == InputEventPhase.Up),
            "safety release is not a blind down retry");
    }

    [RtFact]
    public static void Scheduler_1000SeededRandomPlans_PreserveInputInvariants()
    {
        var random = new Random(0x5EED1234);
        var clock = new VirtualClock();
        var dispatcher = new VirtualInputDispatcher();
        using var scheduler = new Rt.Core.Scheduling.Scheduler(clock, CreateSafety(clock), dispatcher, "run-1", MaxHold);

        for (int i = 0; i < 1_000; i++)
        {
            string actionId = $"random-{i}";
            long created = clock.Now;
            long down = created + random.Next(1, 8);
            int duration = random.Next(0, 251);
            bool cancelAfterDown = i % 10 == 0;
            bool expired = i % 17 == 0;
            int keyCount = random.Next(1, 5);
            var specs = new InputEventSpec[keyCount];
            for (int key = 0; key < keyCount; key++)
            {
                specs[key] = new InputEventSpec(
                    $"p{i}-k{key}",
                    down,
                    down + duration,
                    expired ? down - 1 : down + 1_000);
            }
            var plan = Plan(actionId, created, expired ? down - 1 : down + 2_000, specs);
            Assert.True(scheduler.TrySchedule(plan), $"random plan {i} accepted");

            if (cancelAfterDown && !expired)
            {
                WaitForDeadline(clock, down);
                clock.AdvanceTo(down);
                Spin.WaitForCondition(
                    () => dispatcher.Events.Count(e => e.ActionId == actionId && e.Phase == InputEventPhase.Down) == keyCount,
                    $"random plan {i} reaches its downs before cancel");
                scheduler.Cancel(actionId);
            }
            RunToCompletion(clock, scheduler);

            var events = dispatcher.Events.Where(e => e.ActionId == actionId).ToArray();
            for (int key = 0; key < keyCount; key++)
            {
                string control = $"p{i}-k{key}";
                var pair = events.Where(e => e.Control == control).ToArray();
                if (expired)
                {
                    Assert.Equal(0, pair.Length, $"expired random plan {i}/{control} never补按");
                    continue;
                }
                Assert.Equal(2, pair.Length, $"random plan {i}/{control} has one down/up pair");
                Assert.Equal(InputEventPhase.Down, pair[0].Phase, $"random plan {i}/{control} down is first");
                Assert.Equal(InputEventPhase.Up, pair[1].Phase, $"random plan {i}/{control} up is last");
                Assert.GreaterOrEqual(pair[1].DispatchQpc, pair[0].DispatchQpc,
                    $"random plan {i}/{control} up is never earlier than down");
                Assert.LessOrEqual(pair[1].DispatchQpc - pair[0].DispatchQpc, MaxHold,
                    $"random plan {i}/{control} respects maxHold");
            }
            Assert.Equal(0, scheduler.PendingCount, $"random plan {i} leaves no pending entries");
            Assert.Equal(0, scheduler.HeldCount, $"random plan {i} leaves no held keys");
        }

        long eventCount = dispatcher.Events.Count;
        scheduler.EmergencyStop();
        scheduler.EmergencyStop();
        Assert.Equal(eventCount, dispatcher.Events.Count, "terminal random-plan emergency stops are idempotent");
    }
}

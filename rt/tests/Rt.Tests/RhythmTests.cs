using Rt.Adapters.Rhythm;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Perception;
using Rt.Core.Skills;
using System.Diagnostics;

namespace Rt.Tests;

public static class RhythmTests
{
    [RtFact(Category = "rhythm")]
    public static void RhythmAdapter_RejectsInvalidDescriptor()
    {
        SceneDescriptor duplicateRegion = SyntheticScene.Descriptor(160, 300) with
        {
            Regions = [SyntheticScene.Region(0, 300), SyntheticScene.Region(0, 300)],
        };
        Assert.Throws<ArgumentException>(() => new RhythmAdapter(duplicateRegion), "Duplicate regions must be rejected.");

        SceneDescriptor emptyCategory = SyntheticScene.Descriptor(160, 300) with
        {
            Categories = [SyntheticScene.Head with { Name = "" }],
        };
        Assert.Throws<ArgumentException>(() => new RhythmAdapter(emptyCategory), "Empty category names must be rejected.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmAdapter_DetectsTapHeadInsideConfiguredRoi()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300) with
        {
            Regions = [SyntheticScene.Region(0, 300)],
        };
        byte[] pixels = new byte[160 * 300 * 4];
        SyntheticScene.Fill(pixels, 160, new PixelRect(40, 80, 40, 20), SyntheticScene.Head.Color);
        SyntheticScene.Fill(pixels, 160, new PixelRect(0, 80, 15, 20), SyntheticScene.Head.Color);
        var adapter = new RhythmAdapter(descriptor);

        IReadOnlyList<Detection> detections = adapter.Detect(SyntheticScene.Frame(pixels, 160, 300, 0, 0));

        Assert.Equal(1, detections.Count, "One in-ROI note should be detected.");
        Detection note = detections[0];
        Assert.Equal("lane0", note.RegionId, "The lane identity comes from the descriptor.");
        Assert.Equal("note", note.Category, "Head evidence should compose one note.");
        Assert.Equal(new PixelRect(40, 80, 40, 20), note.Bounds, "Geometry should be exact for a synthetic rectangle.");
        Assert.Equal(1, note.Parts.Count, "A tap has one head part.");
        Assert.Equal("noteHead", note.Parts[0].Category, "The head evidence must remain explainable.");
        Assert.True(note.Confidence >= 0.99, $"Unexpected confidence {note.Confidence}.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmAdapter_RejectsWrongColorAndUndersizedGeometry()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var adapter = new RhythmAdapter(descriptor);
        byte[] wrongColor = new byte[160 * 300 * 4];
        SyntheticScene.Fill(wrongColor, 160, new PixelRect(40, 80, 40, 20), new ColorRule(10, 20, 30, 0));
        Assert.Equal(0, adapter.Detect(SyntheticScene.Frame(wrongColor, 160, 300, 0, 0)).Count, "Wrong colors must not produce notes.");

        byte[] undersized = new byte[160 * 300 * 4];
        SyntheticScene.Fill(undersized, 160, new PixelRect(40, 80, 2, 2), SyntheticScene.Head.Color);
        Assert.Equal(0, adapter.Detect(SyntheticScene.Frame(undersized, 160, 300, 0, 0)).Count, "Undersized components must not produce notes.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmAdapter_ComposesHoldHeadBodyAndTail()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        byte[] pixels = new byte[160 * 300 * 4];
        SyntheticScene.DrawHold(pixels, 160, 40, 60);
        var adapter = new RhythmAdapter(descriptor);

        Detection note = Single(adapter.Detect(SyntheticScene.Frame(pixels, 160, 300, 0, 0)));

        Assert.Equal(3, note.Parts.Count, "A full hold should retain head, body and tail evidence.");
        Assert.Equal(new PixelRect(40, 60, 40, 100), note.Bounds, "Hold bounds should span tail through head.");
        Assert.True(note.Parts.Any(part => part.Category == "noteHead"), "Head evidence is missing.");
        Assert.True(note.Parts.Any(part => part.Category == "noteBody"), "Body evidence is missing.");
        Assert.True(note.Parts.Any(part => part.Category == "noteTail"), "Tail evidence is missing.");
    }

    [RtFact(Category = "rhythm")]
    public static void LinearTracker_PredictsTapHitFromCrossFrameVelocity()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        long second = Qpc.FromMilliseconds(10);

        IReadOnlyList<TrackedObject> first = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 40), 160, 300, 0, 0)), 0);
        IReadOnlyList<TrackedObject> secondTracks = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 60), 160, 300, 1, second)), second);

        Assert.Equal(1, first[0].SampleCount, "First sighting must not invent a velocity.");
        Assert.Equal(0, first[0].Arrivals.Count, "One sample cannot predict an arrival.");
        TrackedObject track = Single(secondTracks);
        Assert.Equal(first[0].TrackId, track.TrackId, "Cross-frame identity should be stable.");
        Assert.Equal(2, track.SampleCount, "Two sightings should be retained.");
        Assert.True(Math.Abs(track.VelocityYPixelsPerSecond - 2000) < 0.001, $"Velocity was {track.VelocityYPixelsPerSecond}.");
        ArrivalPrediction arrival = Single(track.Arrivals);
        Assert.Equal("noteHead", arrival.PartCategory, "Tap arrival comes from its head.");
        Assert.Equal(Qpc.FromMilliseconds(100), arrival.PredictedQpc, "Head-bottom should cross the line at 100 ms.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_EmitsHoldDownAndTailUpExactlyOnce()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        var policy = new RhythmPolicy(descriptor);
        long second = Qpc.FromMilliseconds(10);
        tracker.Update(adapter.Detect(SyntheticScene.Frame(SyntheticScene.Hold(160, 300, 40, 20), 160, 300, 0, 0)), 0);
        IReadOnlyList<TrackedObject> tracks = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Hold(160, 300, 40, 40), 160, 300, 1, second)), second);
        FrameMeta meta = SyntheticScene.Meta(160, 300, 1, second);

        PolicyDecision decision = policy.Decide(tracks, meta, second);
        PlannedAction planned = Single(decision.Plans);
        Assert.Equal("lane0", planned.RegionId, "Plan must retain its lane.");
        Assert.Equal("D", planned.Control, "Plan must use the descriptor's whitelisted key.");
        Assert.Equal(Qpc.FromMilliseconds(70), planned.HitQpc, "Head arrival should schedule down at 70 ms.");
        Assert.Equal(Qpc.FromMilliseconds(110), planned.ExpiryQpc, "Tail arrival should schedule up at 110 ms.");
        Assert.Equal(planned.HitQpc, planned.Plan.Events[0].DownQpc, "ActionPlan down must match the prediction.");
        Assert.Equal(planned.ExpiryQpc, planned.Plan.Events[0].UpQpc, "ActionPlan up must match the tail prediction.");
        Assert.True(planned.Confidence >= 0.99, "Synthetic exact geometry should have high confidence.");

        PolicyDecision repeated = policy.Decide(tracks, meta, second);
        Assert.Equal(0, repeated.Plans.Count, "Reprocessing a track must not duplicate down/up events.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_EmitsSimultaneousChordOnWhitelistedKeys()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(640, 300, 4);
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        var policy = new RhythmPolicy(descriptor);
        tracker.Update(adapter.Detect(SyntheticScene.Frame(SyntheticScene.Chord(640, 300, 100), 640, 300, 0, 0)), 0);
        long now = Qpc.FromMilliseconds(10);
        IReadOnlyList<TrackedObject> tracks = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Chord(640, 300, 120), 640, 300, 1, now)), now);

        PolicyDecision decision = policy.Decide(tracks, SyntheticScene.Meta(640, 300, 1, now), now);

        Assert.Equal(4, decision.Plans.Count, "Four visible notes should produce a four-key chord.");
        Assert.Equal("D,F,J,K", string.Join(",", decision.Plans.Select(plan => plan.Control).OrderBy(key => key)),
            "Only descriptor-whitelisted chord keys are allowed.");
        Assert.Equal(1, decision.Plans.Select(plan => plan.HitQpc).Distinct().Count(), "Chord heads should share a hit time.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_RejectsLowConfidenceInsteadOfGuessing()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        var policy = new RhythmPolicy(descriptor);
        tracker.Update(adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 40, 10), 160, 300, 0, 0)), 0);
        long now = Qpc.FromMilliseconds(10);
        IReadOnlyList<TrackedObject> tracks = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 60, 10), 160, 300, 1, now)), now);

        PolicyDecision decision = policy.Decide(tracks, SyntheticScene.Meta(160, 300, 1, now), now);

        Assert.Equal(1, tracks.Count, "Low-confidence evidence may still be tracked for diagnosis.");
        Assert.True(Single(tracks).Confidence < descriptor.Policy.MinimumConfidence, "Fixture must exercise low confidence.");
        Assert.Equal(0, decision.Plans.Count, "Low confidence must not produce input.");
        Assert.Equal("low-confidence", Single(decision.Rejections).Reason, "Rejection must be explainable.");
    }

    [RtFact(Category = "rhythm")]
    public static void LinearTracker_CoastsThroughOcclusionWithoutDuplicatePlan()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        var policy = new RhythmPolicy(descriptor);
        tracker.Update(adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 40), 160, 300, 0, 0)), 0);
        long t1 = Qpc.FromMilliseconds(10);
        IReadOnlyList<TrackedObject> visible = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 60), 160, 300, 1, t1)), t1);
        PolicyDecision initial = policy.Decide(visible, SyntheticScene.Meta(160, 300, 1, t1), t1);
        long t2 = Qpc.FromMilliseconds(20);
        IReadOnlyList<TrackedObject> occluded = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(new byte[160 * 300 * 4], 160, 300, 2, t2)), t2);
        long t3 = Qpc.FromMilliseconds(30);
        IReadOnlyList<TrackedObject> reacquired = tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 100), 160, 300, 3, t3)), t3);

        Assert.Equal(1, initial.Plans.Count, "The visible note should be planned once.");
        Assert.True(Single(occluded).IsCoasting, "A bounded occlusion should preserve the track as coasting.");
        Assert.Equal(visible[0].TrackId, Single(reacquired).TrackId, "Reacquisition should retain identity.");
        Assert.False(Single(reacquired).IsCoasting, "A visible reacquisition is not coasting.");
        Assert.Equal(0, policy.Decide(occluded, SyntheticScene.Meta(160, 300, 2, t2), t2).Plans.Count,
            "Occlusion must not duplicate a plan.");
        Assert.Equal(0, policy.Decide(reacquired, SyntheticScene.Meta(160, 300, 3, t3), t3).Plans.Count,
            "Reacquisition must not duplicate a plan.");
    }

    [RtFact(Category = "rhythm")]
    public static void LinearTracker_AdaptsArrivalPredictionToSpeedChange()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        tracker.Update(adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 0), 160, 300, 0, 0)), 0);
        long t1 = Qpc.FromMilliseconds(10);
        tracker.Update(adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 10), 160, 300, 1, t1)), t1);
        long t2 = Qpc.FromMilliseconds(20);
        TrackedObject accelerated = Single(tracker.Update(
            adapter.Detect(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 40), 160, 300, 2, t2)), t2));

        Assert.True(Math.Abs(accelerated.VelocityYPixelsPerSecond - 3000) < 0.001,
            $"Latest bounded velocity should adapt to acceleration, got {accelerated.VelocityYPixelsPerSecond}.");
        Assert.Equal(Qpc.FromMilliseconds(86.6666667), Single(accelerated.Arrivals).PredictedQpc,
            "Arrival should use the accelerated velocity, not the old constant speed.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_EnforcesLateHorizonAndMaximumHoldBoundaries()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        long now = Qpc.FromMilliseconds(100);
        FrameMeta meta = SyntheticScene.Meta(160, 300, 1, now);
        var boundaryPolicy = new RhythmPolicy(descriptor);
        long boundaryHit = now - descriptor.Policy.LateToleranceQpc;
        Assert.Equal(1, boundaryPolicy.Decide([ManualTrack("boundary", boundaryHit, boundaryHit + 1)],
            meta, now).Plans.Count, "latestQpc == now is the inclusive last safe boundary.");

        var latePolicy = new RhythmPolicy(descriptor);
        Assert.Equal("late", Single(latePolicy.Decide([ManualTrack("late", boundaryHit - 1, boundaryHit)],
            meta, now).Rejections).Reason, "A plan older than latestQpc must be cancelled, not replayed.");

        var horizonPolicy = new RhythmPolicy(descriptor);
        long beyondHorizon = now + descriptor.Policy.PlanningHorizonQpc + 1;
        Assert.Equal("outside-horizon", Single(horizonPolicy.Decide([ManualTrack("horizon", beyondHorizon, beyondHorizon + 1)],
            meta, now).Rejections).Reason, "Far-future tracks should wait for a later frame.");

        var holdPolicy = new RhythmPolicy(descriptor);
        long hit = now + Qpc.FromMilliseconds(20);
        Assert.Equal("hold-too-long", Single(holdPolicy.Decide([ManualTrack("long", hit,
            hit + descriptor.Policy.MaximumHoldQpc + 1)], meta, now).Rejections).Reason,
            "A hold beyond its cap must not enter the scheduler.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_RejectsOverlappingAndTouchingSameKeyPlans()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var policy = new RhythmPolicy(descriptor);
        long now = 0;
        long hit = Qpc.FromMilliseconds(100);
        long expiry = hit + Qpc.FromMilliseconds(30);
        FrameMeta meta = SyntheticScene.Meta(160, 300, 1, now);

        PolicyDecision decision = policy.Decide(
            [ManualTrack("first", hit, expiry), ManualTrack("overlap", hit + 1, expiry + 1)], meta, now);
        PolicyDecision touching = policy.Decide([ManualTrack("touching", expiry, expiry + Qpc.FromMilliseconds(20))], meta, now);

        Assert.Equal(1, decision.Plans.Count, "Only the earliest same-key interval may be reserved.");
        Assert.Equal("control-conflict", Single(decision.Rejections).Reason, "Overlapping down/up intervals are unsafe.");
        Assert.Equal("control-conflict", Single(touching.Rejections).Reason,
            "A touching down/up across plans is rejected to avoid driver-order duplicate transitions.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_EnforcesDescriptorConcurrencyLimit()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(640, 300, 4) with
        {
            Policy = SyntheticScene.Descriptor(640, 300, 4).Policy with { MaxConcurrent = 1 },
        };
        var policy = new RhythmPolicy(descriptor);
        long now = 0;
        long hit = Qpc.FromMilliseconds(100);
        var tracks = Enumerable.Range(0, 4).Select(lane =>
        {
            TrackedObject track = ManualTrack($"lane{lane}", hit, hit + Qpc.FromMilliseconds(30));
            var head = new DetectionPart("noteHead", new PixelRect(lane * 160 + 60, 100, 40, 20), 1);
            var detection = new Detection($"lane{lane}", "note", head.Bounds, 1, [head]);
            return new TrackedObject(track.TrackId, detection, 1, 0, 2000, false, 2, track.Arrivals);
        }).ToArray();

        PolicyDecision decision = policy.Decide(tracks, SyntheticScene.Meta(640, 300, 1, now), now);

        Assert.Equal(1, decision.Plans.Count, "The descriptor cap must limit simultaneous controls.");
        Assert.Equal(3, decision.Rejections.Count, "Every note above the cap must be rejected.");
        Assert.True(decision.Rejections.All(rejection => rejection.Reason == "concurrency-limit"),
            "Concurrency rejection must be explicit and explainable.");
    }

    [RtFact(Category = "rhythm")]
    public static void RhythmPolicy_RejectsZeroLengthHoldAndNonFiniteConfidence()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var policy = new RhythmPolicy(descriptor);
        long hit = Qpc.FromMilliseconds(100);
        FrameMeta meta = SyntheticScene.Meta(160, 300, 1, 0);

        PolicyDecision zero = policy.Decide([ManualTrack("zero", hit, hit)], meta, 0);
        PolicyDecision nan = policy.Decide([ManualTrack("nan", hit, hit + Qpc.FromMilliseconds(30), double.NaN)], meta, 0);

        Assert.Equal("invalid-interval", Single(zero.Rejections).Reason, "Down/up at one timestamp is not a safe hold.");
        Assert.Equal("low-confidence", Single(nan.Rejections).Reason, "NaN confidence must fail closed.");
    }

    [RtFact(Category = "rhythm")]
    public static void SceneSkill_ComposesPluggableStagesWithoutScheduling()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var skill = new SceneSkill(new RhythmAdapter(descriptor), new LinearTracker(descriptor), new RhythmPolicy(descriptor));
        PolicyDecision first = skill.Process(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 40), 160, 300, 1, 0), 0);
        PolicyDecision second = skill.Process(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 60), 160, 300, 2, Qpc.FromMilliseconds(10)), Qpc.FromMilliseconds(10));
        Assert.Equal(0, first.Plans.Count, "One sample cannot produce a velocity-derived action.");
        PlannedAction plan = Single(second.Plans);
        Assert.Equal("D", plan.Control, "The descriptor's key whitelist must reach the plan.");
        Assert.Equal("synthetic-hil", plan.Plan.TargetId, "Only the explicit synthetic target may be named.");
        Assert.Equal(plan.Plan.Events[0].DownQpc, plan.HitQpc, "Head arrival drives down.");
        Assert.Equal(plan.Plan.Events[0].UpQpc, plan.ExpiryQpc, "Tap expiry drives up.");
    }

    [RtFact(Category = "rhythm")]
    public static void SceneSkill_ResetsTrackingAtSourceEpochBoundary()
    {
        SceneDescriptor descriptor = SyntheticScene.Descriptor(160, 300);
        var skill = new SceneSkill(new RhythmAdapter(descriptor), new LinearTracker(descriptor), new RhythmPolicy(descriptor));
        _ = skill.Process(SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 40), 160, 300, 1, 0), 0);
        SceneFrame newEpoch = SyntheticScene.Frame(SyntheticScene.Tap(160, 300, 40, 60), 160, 300, 2, Qpc.FromMilliseconds(10));
        newEpoch = new SceneFrame(newEpoch.Meta with { SourceEpoch = 8 }, newEpoch.Bgra, newEpoch.StrideBytes);
        PolicyDecision decision = skill.Process(newEpoch, Qpc.FromMilliseconds(10));
        Assert.Equal(0, decision.Plans.Count, "A new source epoch needs fresh motion evidence before planning.");
    }

    [RtFact(Category = "stress")]
    public static void RhythmSynthetic4K60And120_ReportsRawStageTiming()
    {
        RunSyntheticStress(60, "SYNTHETIC-4K60");
        RunSyntheticStress(120, "SYNTHETIC-4K120");
    }

    private static void RunSyntheticStress(int fps, string label)
    {
        const int width = 3840;
        const int height = 2160;
        const int highwayWidth = 640;
        SceneDescriptor descriptor = SyntheticScene.Descriptor(highwayWidth, height, 4) with
        {
            Regions = Enumerable.Range(0, 4).Select(lane => new RegionDescriptor(
                $"lane{lane}", new PixelRect(1600 + lane * 160, 0, 160, height), height - 40,
                "DFJK"[lane].ToString())).ToArray(),
        };
        var adapter = new RhythmAdapter(descriptor);
        var tracker = new LinearTracker(descriptor);
        var policy = new RhythmPolicy(descriptor);
        var detectionMs = new TimingSeries();
        var trackingMs = new TimingSeries();
        var policyMs = new TimingSeries();
        var totalMs = new TimingSeries();
        var actionIds = new HashSet<string>(StringComparer.Ordinal);
        byte[] pixels = new byte[width * height * 4];
        int plans = 0;
        for (int frameIndex = 0; frameIndex < fps; frameIndex++)
        {
            long now = (long)((double)frameIndex * Qpc.Frequency / fps);
            Array.Clear(pixels, 0, pixels.Length);
            foreach (long spawn in new[] { 0L, Qpc.FromMilliseconds(350) })
            {
                if (now < spawn) continue;
                int y = 40 + (int)(3000d * (now - spawn) / Qpc.Frequency);
                if (y >= height) continue;
                for (int lane = 0; lane < 4; lane++)
                    SyntheticScene.Fill(pixels, width, new PixelRect(1660 + lane * 160, y, 40, 20), SyntheticScene.Head.Color);
            }
            SceneFrame frame = SyntheticScene.Frame(pixels, width, height, frameIndex, now);
            long start = Stopwatch.GetTimestamp();
            IReadOnlyList<Detection> detections = adapter.Detect(frame);
            long afterDetection = Stopwatch.GetTimestamp();
            IReadOnlyList<TrackedObject> tracks = tracker.Update(detections, now);
            long afterTracking = Stopwatch.GetTimestamp();
            PolicyDecision decision = policy.Decide(tracks, frame.Meta, now);
            long afterPolicy = Stopwatch.GetTimestamp();
            double detect = ElapsedMilliseconds(start, afterDetection);
            double track = ElapsedMilliseconds(afterDetection, afterTracking);
            double plan = ElapsedMilliseconds(afterTracking, afterPolicy);
            detectionMs.Add(detect);
            trackingMs.Add(track);
            policyMs.Add(plan);
            totalMs.Add(detect + track + plan);
            foreach (PlannedAction action in decision.Plans)
            {
                Assert.True(actionIds.Add(action.Plan.ActionId), "A track must never emit duplicate down/up plans.");
                InputEventSpec input = Single(action.Plan.Events);
                Assert.True("DFJK".Contains(input.Control, StringComparison.Ordinal), "A non-whitelisted key was emitted.");
                Assert.True(input.DownQpc <= input.UpQpc, "A note produced an inverted down/up interval.");
                plans++;
            }
        }
        Assert.Equal(8, plans, "Two four-key synthetic chords should produce exactly eight one-shot plans.");
        foreach ((string stage, TimingSeries samples) in new[] { ("detect", detectionMs), ("track", trackingMs), ("policy", policyMs), ("total", totalMs) })
        {
            StageStatistics stats = samples.Statistics();
            Console.WriteLine($"{label} {stage} raw-ms count={stats.Count} P50={stats.P50:F3} P95={stats.P95:F3} P99={stats.P99:F3} max={stats.Max:F3}");
        }
    }

    private static double ElapsedMilliseconds(long start, long end) => (end - start) * 1000d / Stopwatch.Frequency;

    private static TrackedObject ManualTrack(string id, long hit, long expiry, double confidence = 1)
    {
        var head = new DetectionPart("noteHead", new PixelRect(40, 100, 40, 20), 1);
        var tail = new DetectionPart("noteTail", new PixelRect(40, 60, 40, 20), 1);
        var detection = new Detection("lane0", "note", new PixelRect(40, 60, 40, 60), confidence, [head, tail]);
        return new TrackedObject(id, detection, confidence, 0, 1000, false, 2,
            [new ArrivalPrediction("noteHead", hit, confidence), new ArrivalPrediction("noteTail", expiry, confidence)]);
    }

    private static T Single<T>(IReadOnlyList<T> values)
    {
        Assert.Equal(1, values.Count, "Expected exactly one value.");
        return values[0];
    }
}

internal sealed class TimingSeries
{
    private readonly List<double> _samples = [];
    internal void Add(double milliseconds) => _samples.Add(milliseconds);
    internal StageStatistics Statistics()
    {
        double[] sorted = _samples.OrderBy(sample => sample).ToArray();
        return new StageStatistics(sorted.Length, Percentile(sorted, 0.50), Percentile(sorted, 0.95), Percentile(sorted, 0.99), sorted[^1]);
    }
    private static double Percentile(double[] sorted, double percentile) =>
        sorted[Math.Clamp((int)Math.Ceiling(sorted.Length * percentile) - 1, 0, sorted.Length - 1)];
}

internal sealed record StageStatistics(int Count, double P50, double P95, double P99, double Max);

internal static class SyntheticScene
{
    internal static readonly CategoryDescriptor Head = new(
        "noteHead", new ColorRule(255, 255, 0, 12),
        MinArea: 40, MinWidth: 8, MinHeight: 4, ExpectedArea: 800, MinFill: 0.20);
    internal static readonly CategoryDescriptor Tail = new(
        "noteTail", new ColorRule(0, 255, 255, 12),
        MinArea: 40, MinWidth: 8, MinHeight: 4, ExpectedArea: 800, MinFill: 0.20);
    internal static readonly CategoryDescriptor Body = new(
        "noteBody", new ColorRule(255, 80, 0, 12),
        MinArea: 20, MinWidth: 8, MinHeight: 4, ExpectedArea: 400, MinFill: 0.10);

    internal static SceneDescriptor Descriptor(int width, int height, int lanes = 1) => new()
    {
        Categories = [Head, Tail, Body],
        Regions = Enumerable.Range(0, lanes).Select(lane => Region(lane, height, width / lanes, lane * (width / lanes))).ToArray(),
        Tracking = new TrackingDescriptor
        {
            MaxSamples = 6,
            MaxGapQpc = Qpc.FromMilliseconds(80),
            MaxAssociationDistancePixels = 160,
            MinVelocityPixelsPerSecond = 1,
            MaxVelocityPixelsPerSecond = 10000,
        },
        Policy = new PolicyDescriptor
        {
            TargetId = "synthetic-hil",
            MinimumConfidence = 0.75,
            PlanningHorizonQpc = Qpc.FromMilliseconds(2000),
            LateToleranceQpc = Qpc.FromMilliseconds(5),
            TapDurationQpc = Qpc.FromMilliseconds(30),
            MaximumHoldQpc = Qpc.FromMilliseconds(2000),
            PlanExpiryAfterQpc = Qpc.FromMilliseconds(20),
        },
    };

    internal static RegionDescriptor Region(int lane, int height, int width = 80, int x = 20) =>
        new($"lane{lane}", new PixelRect(x, 0, width, height), height - 40, "DFJK"[lane].ToString());

    internal static FrameMeta Meta(int width, int height, long sequence, long qpc) =>
        new(sequence, "synthetic", 7, qpc, qpc, width, height, FramePixelFormat.Bgra32);

    internal static SceneFrame Frame(byte[] pixels, int width, int height, long sequence, long qpc) =>
        new(Meta(width, height, sequence, qpc), pixels, width * 4);

    internal static byte[] Tap(int width, int height, int x, int y, int headHeight = 20)
    {
        byte[] pixels = new byte[width * height * 4];
        Fill(pixels, width, new PixelRect(x, y, 40, headHeight), Head.Color);
        return pixels;
    }

    internal static byte[] Hold(int width, int height, int x, int tailY)
    {
        byte[] pixels = new byte[width * height * 4];
        DrawHold(pixels, width, x, tailY);
        return pixels;
    }

    internal static void DrawHold(byte[] pixels, int width, int x, int tailY)
    {
        Fill(pixels, width, new PixelRect(x, tailY, 40, 20), Tail.Color);
        Fill(pixels, width, new PixelRect(x, tailY + 20, 40, 60), Body.Color);
        Fill(pixels, width, new PixelRect(x, tailY + 80, 40, 20), Head.Color);
    }

    internal static byte[] Chord(int width, int height, int y)
    {
        byte[] pixels = new byte[width * height * 4];
        for (int lane = 0; lane < 4; lane++)
            Fill(pixels, width, new PixelRect(lane * (width / 4) + 60, y, 40, 20), Head.Color);
        return pixels;
    }


    internal static void Fill(byte[] pixels, int frameWidth, PixelRect rect, ColorRule color)
    {
        for (int y = rect.Y; y < rect.Y + rect.Height; y++)
        for (int x = rect.X; x < rect.X + rect.Width; x++)
        {
            int offset = (y * frameWidth + x) * 4;
            pixels[offset] = color.B;
            pixels[offset + 1] = color.G;
            pixels[offset + 2] = color.R;
            pixels[offset + 3] = 255;
        }
    }
}

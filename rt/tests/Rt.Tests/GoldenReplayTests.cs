using System.Text;
using System.Text.Json;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Tracing;

namespace Rt.Tests;

/// <summary>Task 4 RED: real virtual-clock scheduling with process-independent golden plan bytes.</summary>
public static class GoldenReplayTests
{
    private const string FirstPlan = "{\"schemaVersion\":1,\"actionId\":\"a\",\"sourceEpoch\":7,\"targetId\":\"hil-test\",\"createdQpc\":100,\"expiresQpc\":10000,\"events\":[{\"control\":\"Space\",\"downQpc\":1000,\"upQpc\":2000,\"latestQpc\":1500}],\"preconditions\":[\"focus-proof\"]}";
    private const string SecondPlan = "{\"schemaVersion\":1,\"actionId\":\"b\",\"sourceEpoch\":7,\"targetId\":\"hil-test\",\"createdQpc\":3000,\"expiresQpc\":10000,\"events\":[{\"control\":\"KeyJ\",\"downQpc\":4000,\"upQpc\":6000,\"latestQpc\":4500},{\"control\":\"KeyK\",\"downQpc\":4000,\"upQpc\":5000,\"latestQpc\":4500}],\"preconditions\":null}";

    [RtFact]
    public static void GoldenReplay_SameTraceAndFreshVirtualClock_TwiceByteIdentical()
    {
        string dir = TempDir();
        try
        {
            string trace = Path.Combine(dir, "golden.rtt");
            TraceFile.Write(trace, new[]
            {
                Envelope(TraceEnvelope.Frame, 0, "{\"sequence\":1,\"sourceEpoch\":7}"),
                Envelope(TraceEnvelope.Detections, 1, "{\"items\":[]}"),
                Envelope(TraceEnvelope.Plan, 2, FirstPlan),
                Envelope(TraceEnvelope.Tracks, 3, "{\"items\":[]}"),
                Envelope(TraceEnvelope.Plan, 4, SecondPlan),
                Envelope("Vendor.FutureEnvelope", 5, "{\"ignored\":true}"),
            });

            GoldenReplayResult first = GoldenReplay.Run(trace, new VirtualClock());
            GoldenReplayResult second = GoldenReplay.Run(trace, new VirtualClock());

            Assert.True(first.ActionPlanStream.AsSpan().SequenceEqual(second.ActionPlanStream),
                "two real replays must emit byte-identical ActionPlan JSONL despite process-static scheduler event IDs");
            Assert.Equal(ExpectedGolden, Encoding.UTF8.GetString(first.ActionPlanStream),
                "golden stream must use the independently fixed canonical schema and field order");
            Assert.Equal(6000L, first.FinalClock, "virtual clock ends at the final scheduled release");
            Assert.Equal(6, first.VirtualEvents.Count, "three inputs each produce one DOWN and one UP");
            Assert.Equal(6, first.Receipts.Count, "virtual dispatcher receipts are observable");
            Assert.True(first.VirtualEvents.All(e => e.RunId == "golden-replay"), "only the virtual dispatcher may be used");
            Assert.Equal(VirtualFingerprint(first.VirtualEvents), VirtualFingerprint(second.VirtualEvents),
                "runtime-only event/batch/thread IDs must not leak into replay semantics");
        }
        finally { Directory.Delete(dir, true); }
    }

    [RtFact]
    public static void GoldenReplay_RejectsTraceWithoutPlansAndInvalidPlanSchema()
    {
        string dir = TempDir();
        try
        {
            string noPlans = Path.Combine(dir, "no-plans.rtt");
            TraceFile.Write(noPlans, new[] { Envelope(TraceEnvelope.Frame, 0, "{}") });
            Assert.Throws<InvalidDataException>(() => GoldenReplay.Run(noPlans, new VirtualClock()),
                "an empty ActionPlan stream is not a valid golden replay");

            string badSchema = Path.Combine(dir, "bad-plan-schema.rtt");
            TraceFile.Write(badSchema, new[] { Envelope(TraceEnvelope.Plan, 0, FirstPlan.Replace("schemaVersion\":1", "schemaVersion\":99", StringComparison.Ordinal)) });
            var ex = Assert.Throws<InvalidDataException>(() => GoldenReplay.Run(badSchema, new VirtualClock()),
                "ActionPlan schema mismatch must be rejected before scheduling");
            Assert.True(ex.Message.Contains("schema", StringComparison.OrdinalIgnoreCase), ex.Message);
        }
        finally { Directory.Delete(dir, true); }
    }

    private const string ExpectedGolden =
        "{\"schemaVersion\":1,\"actionId\":\"a\",\"sourceEpoch\":7,\"targetId\":\"hil-test\",\"createdQpc\":100,\"expiresQpc\":10000,\"events\":[{\"control\":\"Space\",\"downQpc\":1000,\"upQpc\":2000,\"latestQpc\":1500}],\"preconditions\":[\"focus-proof\"]}\n" +
        "{\"schemaVersion\":1,\"actionId\":\"b\",\"sourceEpoch\":7,\"targetId\":\"hil-test\",\"createdQpc\":3000,\"expiresQpc\":10000,\"events\":[{\"control\":\"KeyJ\",\"downQpc\":4000,\"upQpc\":6000,\"latestQpc\":4500},{\"control\":\"KeyK\",\"downQpc\":4000,\"upQpc\":5000,\"latestQpc\":4500}],\"preconditions\":null}\n";

    private static string VirtualFingerprint(IReadOnlyList<VirtualInputEvent> events) => string.Join('|',
        events.Select(e => $"{e.ActionId}:{e.Control}:{e.Phase}:{e.ScheduledQpc}:{e.DispatchQpc}"));

    private static TraceEnvelope Envelope(string kind, long sequence, string payload) =>
        new(kind, sequence, sequence * 100, JsonDocument.Parse(payload).RootElement.Clone());

    private static string TempDir()
    {
        string dir = Path.Combine(Path.GetTempPath(), "rt-golden-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
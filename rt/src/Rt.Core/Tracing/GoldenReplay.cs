using System.Diagnostics;
using System.Text.Json;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;
using Rt.Core.Scheduling;

namespace Rt.Core.Tracing;

/// <summary>Replays plans through the real scheduler using only a virtual clock and virtual dispatcher.</summary>
public static class GoldenReplay
{
    private const string ReplayRunId = "golden-replay";
    private static readonly JsonSerializerOptions DecodeOptions = new() { PropertyNameCaseInsensitive = true };

    public static GoldenReplayResult Run(string tracePath, VirtualClock clock)
    {
        ArgumentException.ThrowIfNullOrEmpty(tracePath);
        ArgumentNullException.ThrowIfNull(clock);
        return Run(TraceFile.Read(tracePath), clock);
    }

    public static GoldenReplayResult Run(IEnumerable<TraceEnvelope> envelopes, VirtualClock clock)
    {
        ArgumentNullException.ThrowIfNull(envelopes);
        ArgumentNullException.ThrowIfNull(clock);

        var dispatcher = new VirtualInputDispatcher();
        var safety = new SafetyArbiter(clock);
        using var scheduler = new Scheduler(clock, safety, dispatcher, ReplayRunId, long.MaxValue);
        using var golden = new MemoryStream();
        int planCount = 0;
        try
        {
            foreach (TraceEnvelope envelope in envelopes)
            {
                if (!string.Equals(envelope.Kind, TraceEnvelope.Plan, StringComparison.Ordinal)) continue;
                ActionPlan plan = DecodePlan(envelope);
                AuthorizeVirtualOnly(safety, plan);
                if (!scheduler.TrySchedule(plan))
                    throw new InvalidDataException($"Plan envelope {envelope.Sequence} could not be scheduled.");
                WriteCanonicalPlan(golden, plan);
                planCount++;
                WaitForIdle(scheduler, clock);
            }

            if (planCount == 0) throw new InvalidDataException("trace contains no Plan envelopes");
            scheduler.Stop();
            return new GoldenReplayResult(
                golden.ToArray(), dispatcher.Events.ToArray(), scheduler.Receipts.ToArray(), clock.Now, planCount);
        }
        finally
        {
            scheduler.Stop();
        }
    }

    private static ActionPlan DecodePlan(TraceEnvelope envelope)
    {
        try
        {
            if (envelope.Payload.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException($"Plan envelope {envelope.Sequence} payload must be an object.");
            foreach (JsonProperty property in envelope.Payload.EnumerateObject())
            {
                if (!string.Equals(property.Name, "schemaVersion", StringComparison.OrdinalIgnoreCase)) continue;
                if (property.Value.ValueKind != JsonValueKind.Number ||
                    !property.Value.TryGetInt32(out int schema) || schema != ActionPlan.SchemaVersion)
                    throw new InvalidDataException($"Plan envelope {envelope.Sequence} has unsupported ActionPlan schema.");
            }

            return JsonSerializer.Deserialize<ActionPlan>(envelope.Payload.GetRawText(), DecodeOptions)
                ?? throw new InvalidDataException($"Plan envelope {envelope.Sequence} is null.");
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException)
        {
            throw new InvalidDataException($"Plan envelope {envelope.Sequence} is invalid: {ex.Message}", ex);
        }
    }

    private static void AuthorizeVirtualOnly(SafetyArbiter safety, ActionPlan plan)
    {
        // This snapshot exists only to exercise the real scheduler against VirtualInputDispatcher.
        // GoldenReplay has no OS dispatcher or capture dependency and can never send desktop input.
        safety.Update(new SafetySnapshot(ReplayRunId, plan.TargetId, plan.SourceEpoch)
        {
            Authorized = true,
            Active = true,
            Focused = true,
            HeartbeatValid = true,
            AuthorizationExpiresQpc = long.MaxValue,
            AllowedControls = new[] { "*" },
            SatisfiedPreconditions = plan.Preconditions ?? Array.Empty<string>(),
        });
    }

    private static void WaitForIdle(Scheduler scheduler, VirtualClock clock)
    {
        var watchdog = Stopwatch.StartNew();
        var spin = new SpinWait();
        while (!scheduler.IsIdle || scheduler.PendingCount != 0 || clock.PendingWaiterCount != 0)
        {
            long? deadline = clock.EarliestPendingDeadline;
            if (deadline.HasValue && deadline.Value > clock.Now) clock.AdvanceTo(deadline.Value);
            else spin.SpinOnce();
            if (watchdog.Elapsed > TimeSpan.FromSeconds(5))
                throw new TimeoutException("virtual replay scheduler failed to become idle within the liveness guard");
        }
    }

    private static void WriteCanonicalPlan(Stream output, ActionPlan plan)
    {
        using (var writer = new Utf8JsonWriter(output, new JsonWriterOptions { SkipValidation = false }))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", ActionPlan.SchemaVersion);
            writer.WriteString("actionId", plan.ActionId);
            writer.WriteNumber("sourceEpoch", plan.SourceEpoch);
            writer.WriteString("targetId", plan.TargetId);
            writer.WriteNumber("createdQpc", plan.CreatedQpc);
            writer.WriteNumber("expiresQpc", plan.ExpiresQpc);
            writer.WriteStartArray("events");
            foreach (InputEventSpec spec in plan.Events)
            {
                writer.WriteStartObject();
                writer.WriteString("control", spec.Control);
                WriteNullableInt64(writer, "downQpc", spec.DownQpc);
                WriteNullableInt64(writer, "upQpc", spec.UpQpc);
                writer.WriteNumber("latestQpc", spec.LatestQpc);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            if (plan.Preconditions is null) writer.WriteNull("preconditions");
            else
            {
                writer.WriteStartArray("preconditions");
                foreach (string condition in plan.Preconditions) writer.WriteStringValue(condition);
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
            writer.Flush();
        }
        output.WriteByte((byte)'\n');
    }

    private static void WriteNullableInt64(Utf8JsonWriter writer, string name, long? value)
    {
        if (value.HasValue) writer.WriteNumber(name, value.Value);
        else writer.WriteNull(name);
    }
}

public sealed class GoldenReplayResult
{
    public GoldenReplayResult(
        byte[] actionPlanStream,
        IReadOnlyList<VirtualInputEvent> virtualEvents,
        IReadOnlyList<InputReceipt> receipts,
        long finalClock,
        int planCount)
    {
        ActionPlanStream = actionPlanStream ?? throw new ArgumentNullException(nameof(actionPlanStream));
        VirtualEvents = virtualEvents ?? throw new ArgumentNullException(nameof(virtualEvents));
        Receipts = receipts ?? throw new ArgumentNullException(nameof(receipts));
        FinalClock = finalClock;
        PlanCount = planCount;
    }

    public byte[] ActionPlanStream { get; }
    public IReadOnlyList<VirtualInputEvent> VirtualEvents { get; }
    public IReadOnlyList<InputReceipt> Receipts { get; }
    public long FinalClock { get; }
    public int PlanCount { get; }
}
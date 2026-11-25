using System.Globalization;
using System.Text.Json;

namespace Rt.Harness;

public sealed record ReconcileEvent(
    string ActionId,
    string Control,
    string Phase,
    long ScheduledQpc,
    long? ObservedQpc,
    string Classification);

public static class Reconciler
{
    private sealed record Ground(string ActionId, string Control, string Phase, long ScheduledQpc);
    private sealed record Window(string ActionId, string Control, string Phase, long Qpc);
    private sealed record Trace(string ActionId, string Control, string Phase, long ScheduledQpc, string Outcome);

    public static void Reconcile(
        string groundPath,
        string tracePath,
        string windowPath,
        string outputPath,
        long frequency,
        double toleranceMs = 2.0)
    {
        if (frequency <= 0) throw new ArgumentOutOfRangeException(nameof(frequency));
        List<Ground> ground = Read(groundPath, "scheduledQpc").Select(j => new Ground(
            String(j, "actionId"), String(j, "control"), String(j, "phase"), Long(j, "scheduledQpc"))).ToList();
        List<Trace> traces = Read(tracePath, "scheduledQpc").Select(j => new Trace(
            String(j, "actionId"), String(j, "control"), String(j, "phase"), Long(j, "scheduledQpc"),
            OptionalString(j, "outcome") ?? "Unknown")).ToList();
        List<Window> windows = Read(windowPath, "qpc").Select(j => new Window(
            OptionalString(j, "actionId") ?? string.Empty, String(j, "control"), String(j, "phase"), Long(j, "qpc"))).ToList();

        var remaining = windows.Select((value, index) => (value, index)).ToList();
        var events = new List<ReconcileEvent>();
        var latencies = new List<double>();
        int early = 0, late = 0, onTime = 0, miss = 0;
        double toleranceTicks = toleranceMs * frequency / 1000.0;
        foreach (Ground expected in ground)
        {
            int candidate = -1;
            long bestDistance = long.MaxValue;
            for (int i = 0; i < remaining.Count; i++)
            {
                Window actual = remaining[i].value;
                if (!SameIdentity(expected.ActionId, expected.Control, expected.Phase,
                    actual.ActionId, actual.Control, actual.Phase)) continue;
                long distance = Math.Abs(actual.Qpc - expected.ScheduledQpc);
                if (distance < bestDistance || (distance == bestDistance && actual.Qpc < remaining[candidate].value.Qpc))
                {
                    candidate = i;
                    bestDistance = distance;
                }
            }
            if (candidate < 0)
            {
                miss++;
                events.Add(new ReconcileEvent(expected.ActionId, expected.Control, expected.Phase,
                    expected.ScheduledQpc, null, "miss"));
                continue;
            }
            Window matched = remaining[candidate].value;
            remaining.RemoveAt(candidate);
            long delta = matched.Qpc - expected.ScheduledQpc;
            string classification = delta < -toleranceTicks ? "early" : delta > toleranceTicks ? "late" : "on-time";
            if (classification == "early") early++;
            else if (classification == "late") late++;
            else onTime++;
            double latencyMs = delta * 1000.0 / frequency;
            latencies.Add(latencyMs);
            events.Add(new ReconcileEvent(expected.ActionId, expected.Control, expected.Phase,
                expected.ScheduledQpc, matched.Qpc, classification));
        }

        int duplicate = 0, orphan = 0;
        foreach ((Window actual, _) in remaining)
        {
            bool belongsToGround = ground.Any(expected => SameIdentity(expected.ActionId, expected.Control,
                expected.Phase, actual.ActionId, actual.Control, actual.Phase));
            if (belongsToGround) duplicate++;
            else orphan++;
        }

        int traceMissing = 0, traceNotDispatched = 0, traceUnknown = 0;
        foreach (Ground expected in ground)
        {
            Trace? trace = traces.FirstOrDefault(t => SameIdentity(expected.ActionId, expected.Control,
                expected.Phase, t.ActionId, t.Control, t.Phase) && t.ScheduledQpc == expected.ScheduledQpc);
            if (trace is null) traceMissing++;
            else if (trace.Outcome.Equals("NotDispatched", StringComparison.OrdinalIgnoreCase)) traceNotDispatched++;
            else if (trace.Outcome.Equals("Unknown", StringComparison.OrdinalIgnoreCase)) traceUnknown++;
        }

        latencies.Sort();
        var report = new
        {
            frequency,
            totalGroundTruth = ground.Count,
            matched = events.Count - miss,
            early,
            late,
            onTime,
            miss,
            dup = duplicate,
            orphanWindowEvents = orphan,
            traceMissing,
            traceNotDispatched,
            traceUnknown,
            latencyMs = new
            {
                p50 = Quantile(latencies, 0.50),
                p95 = Quantile(latencies, 0.95),
                p99 = Quantile(latencies, 0.99),
                min = latencies.Count == 0 ? 0 : latencies[0],
                max = latencies.Count == 0 ? 0 : latencies[^1],
            },
            events,
        };
        string? parent = Path.GetDirectoryName(Path.GetFullPath(outputPath));
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        File.WriteAllText(outputPath, JsonSerializer.Serialize(report, new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        }) + Environment.NewLine);
    }

    private static bool SameIdentity(string expectedAction, string expectedControl, string expectedPhase,
        string actualAction, string actualControl, string actualPhase) =>
        string.Equals(expectedControl, actualControl, StringComparison.Ordinal) &&
        string.Equals(expectedPhase, actualPhase, StringComparison.OrdinalIgnoreCase) &&
        (actualAction.Length == 0 || expectedAction.Length == 0 ||
            string.Equals(expectedAction, actualAction, StringComparison.Ordinal));

    private static double Quantile(IReadOnlyList<double> sorted, double quantile)
    {
        if (sorted.Count == 0) return 0;
        int index = Math.Clamp((int)Math.Ceiling(quantile * sorted.Count) - 1, 0, sorted.Count - 1);
        return sorted[index];
    }

    private static IEnumerable<JsonElement> Read(string path, string requiredProperty)
    {
        foreach (string line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            using JsonDocument document = JsonDocument.Parse(line);
            JsonElement element = document.RootElement.Clone();
            if (element.ValueKind == JsonValueKind.Object && Has(element, requiredProperty)) yield return element;
        }
    }

    private static bool Has(JsonElement value, string name) => value.TryGetProperty(name, out _) ||
        value.TryGetProperty(char.ToUpperInvariant(name[0]) + name[1..], out _);
    private static JsonElement Property(JsonElement value, string name) =>
        value.TryGetProperty(name, out JsonElement property) ? property : value.GetProperty(char.ToUpperInvariant(name[0]) + name[1..]);
    private static string String(JsonElement value, string name) => Property(value, name).GetString() ?? string.Empty;
    private static string? OptionalString(JsonElement value, string name) => Has(value, name) ? String(value, name) : null;
    private static long Long(JsonElement value, string name) => Property(value, name).GetInt64();
}

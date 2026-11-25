using Rt.Core.Contracts;
using Rt.Core.Perception;

namespace Rt.Adapters.Rhythm;

/// <summary>
/// Finite-state, one-shot note policy. It rejects ambiguous, late, overlong and same-key-conflicting
/// intervals before they can reach the scheduler. Repeating a track is deliberately idempotent.
/// </summary>
public sealed class RhythmPolicy : IPolicy
{
    private readonly SceneDescriptor _descriptor;
    private readonly Dictionary<string, string> _controls;
    private readonly HashSet<string> _planned = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Interval>> _reservations = new(StringComparer.Ordinal);
    private long? _epoch;

    public RhythmPolicy(SceneDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        ArgumentNullException.ThrowIfNull(descriptor.Policy);
        PolicyDescriptor policy = descriptor.Policy;
        if (string.IsNullOrWhiteSpace(policy.TargetId) || !double.IsFinite(policy.MinimumConfidence) ||
            policy.MinimumConfidence is < 0 or > 1 || policy.PlanningHorizonQpc < 0 ||
            policy.LateToleranceQpc < 0 || policy.TapDurationQpc <= 0 || policy.MaxConcurrent <= 0 ||
            policy.MaximumHoldQpc < policy.TapDurationQpc || policy.PlanExpiryAfterQpc < 0)
            throw new ArgumentException("Invalid rhythm policy configuration.", nameof(descriptor));
        if (descriptor.Regions is null || descriptor.Regions.Count == 0 ||
            descriptor.Regions.Any(region => string.IsNullOrWhiteSpace(region.Control)))
            throw new ArgumentException("A whitelisted control is required for every region.", nameof(descriptor));
        _descriptor = descriptor;
        _controls = descriptor.Regions.ToDictionary(region => region.Id, region => region.Control, StringComparer.Ordinal);
    }

    public PolicyDecision Decide(IReadOnlyList<TrackedObject> tracks, FrameMeta frame, long nowQpc)
    {
        ArgumentNullException.ThrowIfNull(tracks);
        if (_epoch != frame.SourceEpoch)
        {
            _planned.Clear();
            _reservations.Clear();
            _epoch = frame.SourceEpoch;
        }

        var plans = new List<PlannedAction>();
        var rejections = new List<PolicyRejection>();
        foreach (TrackedObject track in tracks
                     .OrderBy(candidate => candidate.Arrivals.FirstOrDefault(arrival => arrival.PartCategory == "noteHead")?.PredictedQpc ?? long.MaxValue)
                     .ThenBy(candidate => candidate.TrackId, StringComparer.Ordinal))
        {
            if (_planned.Contains(track.TrackId)) continue;
            if (!_controls.TryGetValue(track.RegionId, out string? control))
            {
                rejections.Add(Reject(track, "region-not-whitelisted"));
                continue;
            }
            if (track.IsCoasting)
            {
                rejections.Add(Reject(track, "coasting"));
                continue;
            }
            if (!double.IsFinite(track.Confidence) || track.Confidence < _descriptor.Policy.MinimumConfidence)
            {
                rejections.Add(Reject(track, "low-confidence"));
                continue;
            }
            ArrivalPrediction? head = track.Arrivals.FirstOrDefault(arrival => arrival.PartCategory == "noteHead");
            if (head is null)
            {
                rejections.Add(Reject(track, "insufficient-motion"));
                continue;
            }
            ArrivalPrediction? tail = track.Arrivals.FirstOrDefault(arrival => arrival.PartCategory == "noteTail");
            long offset = _descriptor.Policy.OutputOffsetQpc;
            long hit = checked(head.PredictedQpc + offset);
            long expiry = tail is null
                ? checked(hit + _descriptor.Policy.TapDurationQpc)
                : checked(tail.PredictedQpc + offset);
            if (expiry <= hit)
            {
                rejections.Add(Reject(track, "invalid-interval"));
                continue;
            }
            if (expiry - hit > _descriptor.Policy.MaximumHoldQpc)
            {
                rejections.Add(Reject(track, "hold-too-long"));
                continue;
            }
            long latest = checked(hit + _descriptor.Policy.LateToleranceQpc);
            if (latest < nowQpc || checked(expiry + _descriptor.Policy.LateToleranceQpc) < nowQpc)
            {
                rejections.Add(Reject(track, "late"));
                continue;
            }
            if (hit > checked(nowQpc + _descriptor.Policy.PlanningHorizonQpc))
            {
                rejections.Add(Reject(track, "outside-horizon"));
                continue;
            }
            if (HasConflict(control, hit, expiry))
            {
                rejections.Add(Reject(track, "control-conflict"));
                continue;
            }
            int overlapping = _reservations.Values.SelectMany(intervals => intervals)
                .Count(interval => hit < interval.Expiry && expiry > interval.Hit);
            if (overlapping >= _descriptor.Policy.MaxConcurrent)
            {
                rejections.Add(Reject(track, "concurrency-limit"));
                continue;
            }

            string actionId = $"rhythm-{track.TrackId}";
            var input = new InputEventSpec(control, hit, expiry, latest);
            long planExpiry = checked(Math.Max(expiry, latest) + _descriptor.Policy.PlanExpiryAfterQpc);
            var action = new ActionPlan(actionId, frame.SourceEpoch, _descriptor.Policy.TargetId,
                nowQpc, planExpiry, [input]);
            var planned = new PlannedAction(action, track.TrackId, track.RegionId, control,
                track.Confidence, hit, expiry);
            plans.Add(planned);
            _planned.Add(track.TrackId);
            if (!_reservations.TryGetValue(control, out List<Interval>? intervals))
                _reservations[control] = intervals = [];
            intervals.Add(new Interval(hit, expiry));
        }
        return new PolicyDecision(plans, rejections);
    }

    public void Reset()
    {
        _planned.Clear();
        _reservations.Clear();
        _epoch = null;
    }

    private bool HasConflict(string control, long hit, long expiry) =>
        _reservations.TryGetValue(control, out List<Interval>? intervals) &&
        intervals.Any(interval => hit <= interval.Expiry && expiry >= interval.Hit);

    private static PolicyRejection Reject(TrackedObject track, string reason) =>
        new(track.TrackId, track.RegionId, reason);

    private readonly record struct Interval(long Hit, long Expiry);
}

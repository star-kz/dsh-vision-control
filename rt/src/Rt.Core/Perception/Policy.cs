using Rt.Core.Contracts;

namespace Rt.Core.Perception;

/// <summary>An ActionPlan plus the perception evidence and timing semantics that produced it.</summary>
public sealed record PlannedAction
{
    public PlannedAction(
        ActionPlan plan,
        string trackId,
        string regionId,
        string control,
        double confidence,
        long hitQpc,
        long expiryQpc)
    {
        ArgumentNullException.ThrowIfNull(plan);
        Plan = plan;
        TrackId = trackId;
        RegionId = regionId;
        Control = control;
        Confidence = confidence;
        HitQpc = hitQpc;
        ExpiryQpc = expiryQpc;
    }

    public ActionPlan Plan { get; }
    public string TrackId { get; }
    public string RegionId { get; }
    public string Control { get; }
    public double Confidence { get; }
    public long HitQpc { get; }
    public long ExpiryQpc { get; }
}

public sealed record PolicyRejection(string TrackId, string RegionId, string Reason);

public sealed record PolicyDecision
{
    public PolicyDecision(IReadOnlyList<PlannedAction> plans, IReadOnlyList<PolicyRejection> rejections)
    {
        ArgumentNullException.ThrowIfNull(plans);
        ArgumentNullException.ThrowIfNull(rejections);
        Plans = plans.ToArray();
        Rejections = rejections.ToArray();
    }

    public IReadOnlyList<PlannedAction> Plans { get; }
    public IReadOnlyList<PolicyRejection> Rejections { get; }
}

public interface IPolicy
{
    PolicyDecision Decide(IReadOnlyList<TrackedObject> tracks, FrameMeta frame, long nowQpc);
    void Reset();
}

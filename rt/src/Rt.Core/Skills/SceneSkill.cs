using Rt.Core.Perception;

namespace Rt.Core.Skills;

/// <summary>
/// Composes any descriptor-driven detector, tracker and policy. This class only produces plans;
/// capture, shadow/apply decisions and input dispatch remain outside the perception layer.
/// </summary>
public sealed class SceneSkill
{
    private readonly ISceneAdapter _adapter;
    private readonly ITracker _tracker;
    private readonly IPolicy _policy;
    private long? _sourceEpoch;

    public SceneSkill(ISceneAdapter adapter, ITracker tracker, IPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        ArgumentNullException.ThrowIfNull(tracker);
        ArgumentNullException.ThrowIfNull(policy);
        _adapter = adapter;
        _tracker = tracker;
        _policy = policy;
    }

    public SceneDescriptor Descriptor => _adapter.Descriptor;

    public PolicyDecision Process(SceneFrame frame, long nowQpc)
    {
        ArgumentNullException.ThrowIfNull(frame);
        if (_sourceEpoch != frame.Meta.SourceEpoch)
        {
            Reset();
            _sourceEpoch = frame.Meta.SourceEpoch;
        }
        IReadOnlyList<Detection> detections = _adapter.Detect(frame);
        IReadOnlyList<TrackedObject> tracks = _tracker.Update(detections, frame.Meta.CapturedQpc);
        return _policy.Decide(tracks, frame.Meta, nowQpc);
    }

    public void Reset()
    {
        _tracker.Reset();
        _policy.Reset();
        _sourceEpoch = null;
    }
}

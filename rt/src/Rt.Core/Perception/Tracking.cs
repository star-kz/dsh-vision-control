using Rt.Core.Clocks;

namespace Rt.Core.Perception;

public sealed record ArrivalPrediction(string PartCategory, long PredictedQpc, double Confidence);

/// <summary>An immutable track snapshot with bounded-history velocity and part-level arrival predictions.</summary>
public sealed record TrackedObject
{
    public TrackedObject(
        string trackId,
        Detection detection,
        double confidence,
        double velocityXPixelsPerSecond,
        double velocityYPixelsPerSecond,
        bool isCoasting,
        int sampleCount,
        IReadOnlyList<ArrivalPrediction> arrivals)
    {
        if (string.IsNullOrWhiteSpace(trackId)) throw new ArgumentException("A track ID is required.", nameof(trackId));
        ArgumentNullException.ThrowIfNull(detection);
        ArgumentNullException.ThrowIfNull(arrivals);
        TrackId = trackId;
        Detection = detection;
        Confidence = confidence;
        VelocityXPixelsPerSecond = velocityXPixelsPerSecond;
        VelocityYPixelsPerSecond = velocityYPixelsPerSecond;
        IsCoasting = isCoasting;
        SampleCount = sampleCount;
        Arrivals = arrivals.ToArray();
    }

    public string TrackId { get; }
    public Detection Detection { get; }
    public string RegionId => Detection.RegionId;
    public string Category => Detection.Category;
    public double Confidence { get; }
    public double VelocityXPixelsPerSecond { get; }
    public double VelocityYPixelsPerSecond { get; }
    public bool IsCoasting { get; }
    public int SampleCount { get; }
    public IReadOnlyList<ArrivalPrediction> Arrivals { get; }
}

public interface ITracker
{
    IReadOnlyList<TrackedObject> Update(IReadOnlyList<Detection> detections, long observedQpc);
    void Reset();
}

/// <summary>
/// Greedy nearest-neighbor association plus bounded finite-difference velocity. It is deterministic,
/// allocation-bounded by live tracks/detections, and never invents a velocity from one sample.
/// </summary>
public sealed class LinearTracker : ITracker
{
    private readonly SceneDescriptor _descriptor;
    private readonly List<TrackState> _states = [];
    private long _nextId;
    private long _lastUpdateQpc;
    private bool _hasUpdate;

    public LinearTracker(SceneDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        ArgumentNullException.ThrowIfNull(descriptor.Tracking);
        if (descriptor.Tracking.MaxSamples < 2 || descriptor.Tracking.MaxGapQpc < 0 ||
            descriptor.Tracking.MaxAssociationDistancePixels <= 0 ||
            descriptor.Tracking.MinVelocityPixelsPerSecond < 0 ||
            descriptor.Tracking.MaxVelocityPixelsPerSecond <= descriptor.Tracking.MinVelocityPixelsPerSecond)
            throw new ArgumentException("Invalid bounded tracking configuration.", nameof(descriptor));
        if (descriptor.Regions is null || descriptor.Regions.Count == 0)
            throw new ArgumentException("At least one region is required.", nameof(descriptor));
        _descriptor = descriptor;
    }

    public IReadOnlyList<TrackedObject> Update(IReadOnlyList<Detection> detections, long observedQpc)
    {
        ArgumentNullException.ThrowIfNull(detections);
        if (_hasUpdate && observedQpc < _lastUpdateQpc)
            throw new ArgumentOutOfRangeException(nameof(observedQpc), "Tracker time must be monotonic.");
        _lastUpdateQpc = observedQpc;
        _hasUpdate = true;

        _states.RemoveAll(state => observedQpc - state.LastSeenQpc > _descriptor.Tracking.MaxGapQpc);
        var candidates = new List<Association>();
        foreach (TrackState state in _states)
        {
            double elapsedSeconds = (double)(observedQpc - state.LastSeenQpc) / Qpc.Frequency;
            Anchor predicted = new(
                state.Anchor.X + state.VelocityX * elapsedSeconds,
                state.Anchor.Y + state.VelocityY * elapsedSeconds);
            for (int detectionIndex = 0; detectionIndex < detections.Count; detectionIndex++)
            {
                Detection detection = detections[detectionIndex];
                if (detection.RegionId != state.Detection.RegionId || detection.Category != state.Detection.Category)
                    continue;
                Anchor actual = AnchorOf(detection);
                double distance = Math.Sqrt(
                    (actual.X - predicted.X) * (actual.X - predicted.X) +
                    (actual.Y - predicted.Y) * (actual.Y - predicted.Y));
                if (distance <= _descriptor.Tracking.MaxAssociationDistancePixels)
                    candidates.Add(new Association(state, detectionIndex, distance));
            }
        }

        var matchedStates = new HashSet<TrackState>();
        var matchedDetections = new HashSet<int>();
        foreach (Association association in candidates
                     .OrderBy(candidate => candidate.Distance)
                     .ThenBy(candidate => candidate.State.Id, StringComparer.Ordinal)
                     .ThenBy(candidate => candidate.DetectionIndex))
        {
            if (!matchedStates.Add(association.State) || !matchedDetections.Add(association.DetectionIndex))
                continue;
            association.State.Apply(detections[association.DetectionIndex], observedQpc, _descriptor.Tracking.MaxSamples);
        }

        for (int index = 0; index < detections.Count; index++)
        {
            if (matchedDetections.Contains(index)) continue;
            var state = new TrackState($"track-{++_nextId}", detections[index], observedQpc);
            _states.Add(state);
            matchedStates.Add(state);
        }
        foreach (TrackState state in _states)
        {
            if (!matchedStates.Contains(state)) state.IsCoasting = true;
        }

        return _states.OrderBy(state => state.Id, StringComparer.Ordinal).Select(CreateSnapshot).ToArray();
    }

    public void Reset()
    {
        _states.Clear();
        _nextId = 0;
        _lastUpdateQpc = 0;
        _hasUpdate = false;
    }

    private TrackedObject CreateSnapshot(TrackState state)
    {
        var arrivals = new List<ArrivalPrediction>();
        double speed = Math.Abs(state.VelocityY);
        if (state.Samples.Count >= 2 && speed >= _descriptor.Tracking.MinVelocityPixelsPerSecond &&
            speed <= _descriptor.Tracking.MaxVelocityPixelsPerSecond)
        {
            RegionDescriptor region = _descriptor.Regions.Single(candidate => candidate.Id == state.Detection.RegionId);
            foreach (DetectionPart part in state.Detection.Parts)
            {
                double seconds = (region.ArrivalLineY - (double)part.Bounds.Bottom) / state.VelocityY;
                if (!double.IsFinite(seconds) || seconds < 0) continue;
                long predictedQpc = state.LastSeenQpc + (long)(seconds * Qpc.Frequency);
                arrivals.Add(new ArrivalPrediction(
                    part.Category, predictedQpc, state.Detection.Confidence * part.Confidence));
            }
        }
        return new TrackedObject(
            state.Id, state.Detection, state.Detection.Confidence,
            state.VelocityX, state.VelocityY, state.IsCoasting, state.Samples.Count, arrivals);
    }

    private static Anchor AnchorOf(Detection detection)
    {
        DetectionPart part = detection.Parts.FirstOrDefault(candidate => candidate.Category == "noteHead") ??
                             detection.Parts[0];
        return new Anchor(part.Bounds.X + part.Bounds.Width / 2d, part.Bounds.Bottom);
    }

    private sealed class TrackState
    {
        internal TrackState(string id, Detection detection, long observedQpc)
        {
            Id = id;
            Detection = detection;
            LastSeenQpc = observedQpc;
            Anchor = AnchorOf(detection);
            Samples.Add(new TimedAnchor(observedQpc, Anchor.X, Anchor.Y));
        }

        internal string Id { get; }
        internal Detection Detection { get; private set; }
        internal long LastSeenQpc { get; private set; }
        internal Anchor Anchor { get; private set; }
        internal List<TimedAnchor> Samples { get; } = [];
        internal double VelocityX { get; private set; }
        internal double VelocityY { get; private set; }
        internal bool IsCoasting { get; set; }

        internal void Apply(Detection detection, long observedQpc, int maxSamples)
        {
            Anchor next = AnchorOf(detection);
            if (observedQpc > LastSeenQpc)
            {
                Samples.Add(new TimedAnchor(observedQpc, next.X, next.Y));
                if (Samples.Count > maxSamples) Samples.RemoveAt(0);
                TimedAnchor previous = Samples[^2];
                double seconds = (double)(observedQpc - previous.Qpc) / Qpc.Frequency;
                VelocityX = (next.X - previous.X) / seconds;
                VelocityY = (next.Y - previous.Y) / seconds;
            }
            Detection = detection;
            Anchor = next;
            LastSeenQpc = observedQpc;
            IsCoasting = false;
        }
    }

    private readonly record struct TimedAnchor(long Qpc, double X, double Y);
    private readonly record struct Anchor(double X, double Y);
    private readonly record struct Association(TrackState State, int DetectionIndex, double Distance);
}

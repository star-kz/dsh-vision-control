namespace Rt.Core.Perception;

/// <summary>A physical-pixel rectangle. Coordinate semantics are supplied by the capture frame.</summary>
public readonly record struct PixelRect(int X, int Y, int Width, int Height)
{
    public int Right => X + Width;
    public int Bottom => Y + Height;
}

/// <summary>Inclusive per-channel BGRA color distance. Alpha is deliberately ignored.</summary>
public readonly record struct ColorRule(byte B, byte G, byte R, byte Tolerance);

/// <summary>Explainable color and connected-component geometry for one descriptor-defined class.</summary>
public sealed record CategoryDescriptor(
    string Name,
    ColorRule Color,
    int MinArea,
    int MinWidth,
    int MinHeight,
    int ExpectedArea,
    double MinFill);

/// <summary>A named ROI, its control binding and a physical-pixel horizontal arrival line.</summary>
public sealed record RegionDescriptor(string Id, PixelRect Roi, int ArrivalLineY, string Control);

public sealed record TrackingDescriptor
{
    public required int MaxSamples { get; init; }
    public required long MaxGapQpc { get; init; }
    public required double MaxAssociationDistancePixels { get; init; }
    public required double MinVelocityPixelsPerSecond { get; init; }
    public required double MaxVelocityPixelsPerSecond { get; init; }
}

public sealed record PolicyDescriptor
{
    public required string TargetId { get; init; }
    public required double MinimumConfidence { get; init; }
    public required long PlanningHorizonQpc { get; init; }
    public required long LateToleranceQpc { get; init; }
    public required long TapDurationQpc { get; init; }
    public required long MaximumHoldQpc { get; init; }
    public required long PlanExpiryAfterQpc { get; init; }
    public int MaxConcurrent { get; init; } = 4;
    public long OutputOffsetQpc { get; init; }
}

/// <summary>All scene-specific geometry, classes, tracking and control policy in one replaceable descriptor.</summary>
public sealed record SceneDescriptor
{
    public required IReadOnlyList<CategoryDescriptor> Categories { get; init; }
    public required IReadOnlyList<RegionDescriptor> Regions { get; init; }
    public required TrackingDescriptor Tracking { get; init; }
    public required PolicyDescriptor Policy { get; init; }
}

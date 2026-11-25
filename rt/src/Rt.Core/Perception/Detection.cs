namespace Rt.Core.Perception;

/// <summary>One explainable detector fragment, such as a descriptor-defined head or tail.</summary>
public sealed record DetectionPart(string Category, PixelRect Bounds, double Confidence);

/// <summary>A detected object. Parts preserve the evidence used to compose the object.</summary>
public sealed record Detection
{
    public Detection(
        string regionId,
        string category,
        PixelRect bounds,
        double confidence,
        IReadOnlyList<DetectionPart> parts)
    {
        if (string.IsNullOrWhiteSpace(regionId)) throw new ArgumentException("A region is required.", nameof(regionId));
        if (string.IsNullOrWhiteSpace(category)) throw new ArgumentException("A category is required.", nameof(category));
        if (confidence is < 0 or > 1) throw new ArgumentOutOfRangeException(nameof(confidence));
        ArgumentNullException.ThrowIfNull(parts);
        if (parts.Count == 0) throw new ArgumentException("At least one evidence part is required.", nameof(parts));
        RegionId = regionId;
        Category = category;
        Bounds = bounds;
        Confidence = confidence;
        Parts = parts.ToArray();
    }

    public string RegionId { get; }
    public string Category { get; }
    public PixelRect Bounds { get; }
    public double Confidence { get; }
    public IReadOnlyList<DetectionPart> Parts { get; }
}

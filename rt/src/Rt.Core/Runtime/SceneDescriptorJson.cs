using System.Text.Json;
using System.Text.Json.Serialization;
using Rt.Core.Perception;

namespace Rt.Core.Runtime;

/// <summary>Strict camelCase descriptor JSON: duplicate/unknown fields, missing required data and target mismatch fail closed.</summary>
public static class SceneDescriptorJson
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        AllowTrailingCommas = false,
    };

    public static SceneDescriptor Parse(string json, string? expectedTargetId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);
        try
        {
            using JsonDocument document = JsonDocument.Parse(json, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 64,
            });
            RejectDuplicates(document.RootElement);
            var descriptor = document.RootElement.Deserialize<SceneDescriptor>(Options)
                ?? throw new InvalidDataException("skill descriptor must be a non-null object");
            Validate(descriptor);
            if (expectedTargetId is not null && descriptor.Policy.TargetId != expectedTargetId)
                throw new InvalidDataException($"skill policy target '{descriptor.Policy.TargetId}' does not match requested target '{expectedTargetId}'");
            return descriptor;
        }
        catch (InvalidDataException) { throw; }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException or FormatException or OverflowException)
        {
            throw new InvalidDataException("invalid skill descriptor JSON", ex);
        }
    }

    private static void Validate(SceneDescriptor descriptor)
    {
        if (descriptor.Categories is null || descriptor.Categories.Count == 0) throw new InvalidDataException("categories must be nonempty");
        if (descriptor.Regions is null || descriptor.Regions.Count == 0) throw new InvalidDataException("regions must be nonempty");
        if (descriptor.Tracking is null || descriptor.Policy is null) throw new InvalidDataException("tracking and policy are required");
        if (string.IsNullOrWhiteSpace(descriptor.Policy.TargetId)) throw new InvalidDataException("policy.targetId must be nonempty");
        if (descriptor.Categories.Select(x => x.Name).Distinct(StringComparer.Ordinal).Count() != descriptor.Categories.Count)
            throw new InvalidDataException("category names must be unique");
        if (descriptor.Regions.Select(x => x.Id).Distinct(StringComparer.Ordinal).Count() != descriptor.Regions.Count)
            throw new InvalidDataException("region ids must be unique");
        foreach (CategoryDescriptor category in descriptor.Categories)
        {
            if (string.IsNullOrWhiteSpace(category.Name)) throw new InvalidDataException("category.name must be nonempty");
            if (category.MinArea <= 0 || category.MinWidth <= 0 || category.MinHeight <= 0 || category.ExpectedArea <= 0)
                throw new InvalidDataException("category geometry thresholds must be positive");
            if (category.MinFill is < 0 or > 1 || double.IsNaN(category.MinFill)) throw new InvalidDataException("category.minFill must be in [0,1]");
        }
        foreach (RegionDescriptor region in descriptor.Regions)
        {
            if (string.IsNullOrWhiteSpace(region.Id) || string.IsNullOrWhiteSpace(region.Control))
                throw new InvalidDataException("region id/control must be nonempty");
            if (region.Roi.Width <= 0 || region.Roi.Height <= 0) throw new InvalidDataException("region ROI dimensions must be positive");
        }
        PolicyDescriptor policy = descriptor.Policy;
        if (policy.MinimumConfidence is < 0 or > 1 || double.IsNaN(policy.MinimumConfidence))
            throw new InvalidDataException("policy.minimumConfidence must be in [0,1]");
        if (policy.MaxConcurrent <= 0 || policy.MaximumHoldQpc < 0 || policy.TapDurationQpc < 0 || policy.PlanExpiryAfterQpc < 0)
            throw new InvalidDataException("policy limits are invalid");
    }

    private static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new InvalidDataException($"duplicate JSON property '{property.Name}'");
                RejectDuplicates(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (JsonElement child in element.EnumerateArray()) RejectDuplicates(child);
    }
}

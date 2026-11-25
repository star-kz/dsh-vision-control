namespace Rt.Core.Tracing;

/// <summary>
/// One versioned trace record. Kinds are deliberately strings so a same-schema producer can add
/// domain-specific envelopes without requiring a core enum change; consumers must ignore kinds
/// they do not understand. Payload and extension data are detached from their source documents.
/// </summary>
public sealed record TraceEnvelope
{
    public const string Frame = "Frame";
    public const string Detections = "Detections";
    public const string Tracks = "Tracks";
    public const string Plan = "Plan";
    public const string Receipt = "Receipt";
    public const string Gate = "Gate";
    public const string EStop = "EStop";

    public TraceEnvelope(
        string kind,
        long sequence,
        long timestampQpc,
        System.Text.Json.JsonElement payload,
        System.Text.Json.JsonElement? extensions = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        if (payload.ValueKind == System.Text.Json.JsonValueKind.Undefined)
            throw new ArgumentException("payload must be a defined JSON value", nameof(payload));
        if (extensions is System.Text.Json.JsonElement extension &&
            extension.ValueKind is not System.Text.Json.JsonValueKind.Object and not System.Text.Json.JsonValueKind.Null)
            throw new ArgumentException("extensions must be a JSON object or null", nameof(extensions));

        Kind = kind;
        Sequence = sequence;
        TimestampQpc = timestampQpc;
        Payload = payload.Clone();
        Extensions = extensions?.Clone();
    }

    public string Kind { get; }
    public long Sequence { get; }
    public long TimestampQpc { get; }
    public System.Text.Json.JsonElement Payload { get; }
    public System.Text.Json.JsonElement? Extensions { get; }
}

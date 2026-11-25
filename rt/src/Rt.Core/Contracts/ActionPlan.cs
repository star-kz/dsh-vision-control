namespace Rt.Core.Contracts;

/// <summary>
/// A versioned plan to inject input events against a specific source epoch. Validated and
/// defensively copied at construction: a constructed plan is immutable and self-contained,
/// so later consumers can trust ActionId/TargetId are present and ExpiresQpc >= CreatedQpc.
/// </summary>
public sealed record ActionPlan
{
    public ActionPlan(
        string actionId,
        long sourceEpoch,
        string targetId,
        long createdQpc,
        long expiresQpc,
        IReadOnlyList<InputEventSpec> events,
        IReadOnlyList<string>? preconditions = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(actionId);
        ArgumentException.ThrowIfNullOrEmpty(targetId);
        ArgumentNullException.ThrowIfNull(events);
        ArgumentOutOfRangeException.ThrowIfLessThan(expiresQpc, createdQpc, nameof(expiresQpc));

        ActionId = actionId;
        SourceEpoch = sourceEpoch;
        TargetId = targetId;
        CreatedQpc = createdQpc;
        ExpiresQpc = expiresQpc;
        Events = events.ToArray();
        Preconditions = preconditions?.ToArray();
    }

    /// <summary>Schema version for serialized forms; bump on any field change.</summary>
    public const int SchemaVersion = 1;

    /// <summary>Stable identifier of this action, carried into every receipt.</summary>
    public string ActionId { get; }

    /// <summary>Source epoch the plan was built for; dispatchers must re-check it before injecting.</summary>
    public long SourceEpoch { get; }

    /// <summary>Injection target (window/control identifier).</summary>
    public string TargetId { get; }

    /// <summary>Raw QPC timestamp when the plan was created.</summary>
    public long CreatedQpc { get; }

    /// <summary>Raw QPC timestamp after which the plan must not be dispatched (>= CreatedQpc).</summary>
    public long ExpiresQpc { get; }

    /// <summary>The scheduled input events (snapshot; caller mutations do not propagate).</summary>
    public IReadOnlyList<InputEventSpec> Events { get; }

    /// <summary>Optional gate preconditions (snapshot), e.g. required focus or user-intent proof.</summary>
    public IReadOnlyList<string>? Preconditions { get; }
}

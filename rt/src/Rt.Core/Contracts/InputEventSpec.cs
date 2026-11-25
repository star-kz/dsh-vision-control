namespace Rt.Core.Contracts;

/// <summary>One scheduled input event (down/up window) inside an <see cref="ActionPlan"/>.</summary>
public readonly record struct InputEventSpec(string Control, long? DownQpc, long? UpQpc, long LatestQpc)
{
    /// <summary>Schema version for serialized forms; bump on any field change.</summary>
    public const int SchemaVersion = 1;
}

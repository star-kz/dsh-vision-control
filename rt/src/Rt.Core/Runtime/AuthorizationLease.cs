using System.Text.Json;
using Rt.Core.Clocks;

namespace Rt.Core.Runtime;

/// <summary>An independently validated, target-bound native input authorization lease.</summary>
public sealed record AuthorizationLease(bool Granted, string TargetId, long ExpiresQpc, string? LeaseId)
{
    public static AuthorizationLease Parse(JsonElement json, IClock clock)
    {
        ArgumentNullException.ThrowIfNull(clock);
        if (json.ValueKind != JsonValueKind.Object) throw new ArgumentException("authorization must be an object");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in json.EnumerateObject())
            if (!names.Add(property.Name)) throw new ArgumentException($"duplicate authorization property '{property.Name}'");
        if (!json.TryGetProperty("granted", out JsonElement granted) || granted.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new ArgumentException("authorization.granted must be boolean");
        if (!json.TryGetProperty("targetId", out JsonElement target) || target.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(target.GetString())) throw new ArgumentException("authorization.targetId is required");
        string? leaseId = null;
        if (json.TryGetProperty("leaseId", out JsonElement lease))
        {
            if (lease.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(lease.GetString()))
                throw new ArgumentException("authorization.leaseId must be a nonempty string");
            leaseId = lease.GetString();
        }
        bool hasQpc = json.TryGetProperty("expiresQpc", out JsonElement qpc);
        bool hasMs = json.TryGetProperty("expiresAtMs", out JsonElement milliseconds);
        if (hasQpc == hasMs) throw new ArgumentException("authorization requires exactly one of expiresQpc or expiresAtMs");
        long expiry;
        if (hasQpc)
        {
            if (!qpc.TryGetInt64(out expiry) || expiry <= 0) throw new ArgumentException("authorization.expiresQpc must be positive");
        }
        else
        {
            if (!milliseconds.TryGetInt64(out long unixMs) || unixMs <= 0) throw new ArgumentException("authorization.expiresAtMs must be positive");
            long remainingMs = unixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            expiry = remainingMs <= 0 ? 0 : clock.Now + (long)Math.Min(long.MaxValue - clock.Now, remainingMs * (Qpc.Frequency / 1000.0));
        }
        return new AuthorizationLease(granted.GetBoolean(), target.GetString()!, expiry, leaseId);
    }

    public void Validate(string targetId, long nowQpc)
    {
        if (!Granted) throw new UnauthorizedAccessException("active authorization was not granted");
        if (!string.Equals(TargetId, targetId, StringComparison.Ordinal))
            throw new UnauthorizedAccessException("active authorization target does not match the run target");
        if (ExpiresQpc <= nowQpc) throw new UnauthorizedAccessException("active authorization has expired");
    }
}

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rt.Worker;

public sealed record WorkerTarget(string Id, string Kind, long Handle, int ProcessId, string? Title)
{
    public bool IsDedicatedHil => Kind == "hil";
    [JsonIgnore] public nint Hwnd => checked((nint)Handle);
    [JsonIgnore] public nint Monitor => checked((nint)Handle);

    public static WorkerTarget Parse(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object) throw new ArgumentException("target must be a structured object");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in json.EnumerateObject())
            if (!seen.Add(property.Name)) throw new ArgumentException($"duplicate target property '{property.Name}'");
        string id = RequiredId(json);
        string kind = RequiredString(json, "kind");
        if (kind is not ("monitor" or "hil")) throw new ArgumentException("target.kind must be monitor or hil");
        long handle = 0;
        int processId = 0;
        string? title = null;
        if (json.TryGetProperty("handle", out JsonElement handleElement)) handle = ReadInt64(handleElement, "target.handle");
        if (json.TryGetProperty("hwnd", out JsonElement hwnd)) handle = ReadInt64(hwnd, "target.hwnd");
        if (json.TryGetProperty("processId", out JsonElement pid)) processId = ReadInt32(pid, "target.processId");
        if (json.TryGetProperty("title", out JsonElement titleElement) && titleElement.ValueKind != JsonValueKind.Null) title = RequiredString(json, "title");
        if (json.TryGetProperty("window", out JsonElement window))
        {
            if (window.ValueKind != JsonValueKind.Object) throw new ArgumentException("target.window must be an object");
            if (window.TryGetProperty("hwnd", out JsonElement windowHwnd)) handle = ReadInt64(windowHwnd, "target.window.hwnd");
            if (window.TryGetProperty("processId", out JsonElement windowPid)) processId = ReadInt32(windowPid, "target.window.processId");
            if (window.TryGetProperty("title", out _)) title = RequiredString(window, "title");
        }
        return new WorkerTarget(id, kind, handle, processId, title);
    }

    private static string RequiredId(JsonElement json)
    {
        bool id = json.TryGetProperty("id", out JsonElement idElement);
        bool targetId = json.TryGetProperty("targetId", out JsonElement targetElement);
        if (id == targetId) throw new ArgumentException("target requires exactly one of id or targetId");
        string value = (id ? idElement : targetElement).ValueKind == JsonValueKind.String ? (id ? idElement : targetElement).GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(value) || value.Length > 256) throw new ArgumentException("target.id must be a nonempty bounded string");
        return value;
    }
    private static string RequiredString(JsonElement json, string name)
    {
        if (!json.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
            throw new ArgumentException($"target.{name} must be a nonempty string");
        return value.GetString()!;
    }
    private static long ReadInt64(JsonElement value, string name)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long number)) return number;
        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number)) return number;
        throw new ArgumentException($"{name} must be an integer or decimal string");
    }
    private static int ReadInt32(JsonElement value, string name)
    {
        long result = ReadInt64(value, name);
        if (result is < 0 or > int.MaxValue) throw new ArgumentException($"{name} is outside the process id range");
        return (int)result;
    }
}

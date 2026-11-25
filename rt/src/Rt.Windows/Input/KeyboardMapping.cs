using Rt.Core.Input;

namespace Rt.Windows.Input;

/// <summary>Explicit physical set-1 mappings; no layout-dependent key-name or character lookup.</summary>
public static class KeyboardMapping
{
    private readonly record struct Mapping(ushort ScanCode, ushort VirtualKey, bool Extended = false);

    private static readonly IReadOnlyDictionary<string, Mapping> Map =
        new Dictionary<string, Mapping>(StringComparer.OrdinalIgnoreCase)
        {
            ["key.a"] = new(0x1E, 0x41),
            ["key.s"] = new(0x1F, 0x53),
            ["key.d"] = new(0x20, 0x44),
            ["key.f"] = new(0x21, 0x46),
            ["key.j"] = new(0x24, 0x4A),
            ["key.k"] = new(0x25, 0x4B),
            ["key.l"] = new(0x26, 0x4C),
            ["key.semicolon"] = new(0x27, 0xBA),
            ["key.space"] = new(0x39, 0x20),
            ["key.left"] = new(0x4B, 0x25, true),
            ["key.up"] = new(0x48, 0x26, true),
            ["key.down"] = new(0x50, 0x28, true),
            ["key.right"] = new(0x4D, 0x27, true),
        };

    public static SendInputFrame Resolve(string control, InputEventPhase phase)
    {
        if (control is null) throw new ArgumentNullException(nameof(control));
        if (!Map.TryGetValue(control, out Mapping mapping))
            throw new ArgumentException("control has no explicit physical-key mapping: " + control, nameof(control));
        if (phase is not InputEventPhase.Down and not InputEventPhase.Up)
            throw new ArgumentOutOfRangeException(nameof(phase));
        return new SendInputFrame(mapping.ScanCode, mapping.VirtualKey, mapping.Extended, phase == InputEventPhase.Up);
    }
}

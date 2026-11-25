using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;

namespace Rt.Windows.Input;

/// <summary>Identity of the one self-built window that may ever receive real input.</summary>
public sealed record DedicatedSynthTarget
{
    public const string RequiredProcessName = "Rt.SynthWindow";
    public const string RequiredTitleMagic = "RT-SYNTH-HIL-9D27C4";

    public DedicatedSynthTarget(nint hwnd, int processId, string title)
    {
        if (hwnd == 0) throw new ArgumentOutOfRangeException(nameof(hwnd));
        if (processId <= 0) throw new ArgumentOutOfRangeException(nameof(processId));
        if (string.IsNullOrWhiteSpace(title) ||
            !title.StartsWith(RequiredTitleMagic + "|", StringComparison.Ordinal))
            throw new ArgumentException("the exact dedicated HIL title and magic are required", nameof(title));
        Hwnd = hwnd;
        ProcessId = processId;
        Title = title;
    }

    public nint Hwnd { get; }
    public int ProcessId { get; }
    public string Title { get; }
}

/// <summary>Observed Win32 facts; these are never inferred from OCR or a requested target.</summary>
public sealed record WindowFacts(
    nint Hwnd,
    int ProcessId,
    string ProcessName,
    string Title,
    CoordinateBounds Bounds,
    bool IsVisible,
    bool IsMinimized)
{
    public static WindowFacts Empty { get; } =
        new(0, 0, string.Empty, string.Empty, default, false, false);
}

public interface IWindowFactsSource
{
    WindowFacts ReadForeground();
    WindowFacts ReadWindow(nint hwnd);
}

public readonly record struct SendInputFrame(
    ushort ScanCode,
    ushort VirtualKey,
    bool Extended,
    bool KeyUp);

public readonly record struct SendInputNativeResult(int InsertedCount, int Win32Error);

public interface ISendInputNative
{
    SendInputNativeResult Send(IReadOnlyList<SendInputFrame> inputs);
}

/// <summary>Runs immediately around the real native boundary; failures are outcome-significant.</summary>
public interface IInputDispatchObserver
{
    void BeforeSend(IReadOnlyList<InputDispatchRequest> requests);
    void AfterSend(IReadOnlyList<InputDispatchRequest> requests, IReadOnlyList<InputReceipt> receipts);
}

/// <summary>Auditable facts from one attempted native call, including attempts that never reached it.</summary>
public sealed class SendInputCallFacts
{
    public long CallId { get; internal set; }
    public long BatchId { get; internal set; }
    public long BeforeQpc { get; internal set; }
    public long AfterQpc { get; internal set; }
    public int RequestedCount { get; internal set; }
    public int InsertedCount { get; internal set; }
    public int Win32Error { get; internal set; }
    public bool NativeInvoked { get; internal set; }
    public bool TimedOut { get; internal set; }
    public string? Error { get; internal set; }
    public IReadOnlyList<SendInputFrame> Frames { get; internal set; } = Array.Empty<SendInputFrame>();
    public IReadOnlyList<GateVerdict> BeforeVerdicts { get; internal set; } = Array.Empty<GateVerdict>();
    public IReadOnlyList<GateVerdict> AfterVerdicts { get; internal set; } = Array.Empty<GateVerdict>();
}

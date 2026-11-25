using System.Runtime.InteropServices;
using Rt.Windows.Input;

namespace Rt.Worker;

/// <summary>Read-only monitor and exact dedicated-HIL enumeration; no synthetic targets.</summary>
public sealed partial class WorkerTargetCatalog
{
    private readonly WindowsWindowFactsSource _windows = new();
    private readonly HilTargetVerifier _verifier;

    public WorkerTargetCatalog() => _verifier = new HilTargetVerifier(_windows);

    public IReadOnlyList<WorkerTarget> Enumerate()
    {
        var result = new List<WorkerTarget>();
        EnumMonitors((monitor, _, _, _) =>
        {
            if (monitor != 0) result.Add(new WorkerTarget(TargetId("monitor", monitor), "monitor", monitor, 0, null));
            return true;
        }, 0);
        EnumWindows((hwnd, _) =>
        {
            if (hwnd == 0 || !IsWindowVisible(hwnd)) return true;
            try
            {
                WindowFacts facts = _windows.ReadWindow(hwnd);
                if (facts.ProcessName != DedicatedSynthTarget.RequiredProcessName ||
                    !facts.Title.StartsWith(DedicatedSynthTarget.RequiredTitleMagic, StringComparison.Ordinal)) return true;
                var target = new DedicatedSynthTarget(hwnd, facts.ProcessId, facts.Title);
                if (_verifier.Verify(target).Ok)
                    result.Add(new WorkerTarget(TargetId("hil", hwnd), "hil", hwnd, facts.ProcessId, facts.Title));
            }
            catch { /* A disappearing/unverifiable window is simply not an authorized target. */ }
            return true;
        }, 0);
        return result.OrderBy(x => x.Kind, StringComparer.Ordinal).ThenBy(x => x.Id, StringComparer.Ordinal).ToArray();
    }

    public WorkerTarget Resolve(WorkerTarget requested)
    {
        WorkerTarget? match = Enumerate().SingleOrDefault(x => x.Id == requested.Id && x.Kind == requested.Kind);
        if (match is null) throw new KeyNotFoundException($"target '{requested.Id}' is not currently enumerable and verified");
        if (requested.Handle != 0 && requested.Handle != match.Handle) throw new ArgumentException("target handle does not match its id");
        if (requested.ProcessId != 0 && requested.ProcessId != match.ProcessId) throw new ArgumentException("target process id changed");
        if (requested.Title is not null && requested.Title != match.Title) throw new ArgumentException("target title changed");
        return match;
    }

    public DedicatedSynthTarget VerifyDedicatedHil(WorkerTarget target)
    {
        if (!target.IsDedicatedHil) throw new ArgumentException("ACTIVE_TARGET_NOT_HIL");
        WorkerTarget current = Resolve(target);
        var dedicated = new DedicatedSynthTarget(current.Hwnd, current.ProcessId, current.Title!);
        HilTargetVerification verification = _verifier.Verify(dedicated);
        if (!verification.Ok) throw new UnauthorizedAccessException("dedicated HIL verification failed: " + verification.Reason);
        return dedicated;
    }

    public static string TargetId(string kind, long handle) => $"{kind}-{handle.ToString("x", System.Globalization.CultureInfo.InvariantCulture)}";

    private delegate bool MonitorEnumProc(nint monitor, nint hdc, nint rect, nint data);
    private delegate bool WindowEnumProc(nint hwnd, nint data);
    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool EnumDisplayMonitors(nint hdc, nint clip, MonitorEnumProc callback, nint data);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool EnumWindows(WindowEnumProc callback, nint data);
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsWindowVisible(nint hwnd);
    private void EnumMonitors(MonitorEnumProc callback, nint data) => EnumDisplayMonitors(0, 0, callback, data);
}

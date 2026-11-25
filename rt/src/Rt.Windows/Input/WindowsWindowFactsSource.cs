using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Rt.Core.Safety;

namespace Rt.Windows.Input;

/// <summary>Read-only Win32 observation. This class never activates or manipulates a window.</summary>
public sealed class WindowsWindowFactsSource : IWindowFactsSource
{
    public WindowFacts ReadForeground() => ReadWindow(GetForegroundWindow());

    public WindowFacts ReadWindow(nint hwnd)
    {
        if (hwnd == 0 || !IsWindow(hwnd)) return WindowFacts.Empty;
        _ = GetWindowThreadProcessId(hwnd, out uint processId);
        string processName = string.Empty;
        try
        {
            using Process process = Process.GetProcessById(checked((int)processId));
            processName = process.ProcessName;
        }
        catch
        {
            // A vanished/inaccessible process is a failed identity check, not an assumed target.
        }

        int length = GetWindowTextLength(hwnd);
        var title = new StringBuilder(Math.Max(0, length) + 1);
        _ = GetWindowText(hwnd, title, title.Capacity);
        CoordinateBounds bounds = default;
        if (GetWindowRect(hwnd, out NativeRect rect))
            bounds = new CoordinateBounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        return new WindowFacts(hwnd, (int)processId, processName, title.ToString(), bounds,
            IsWindowVisible(hwnd), IsIconic(hwnd));
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(nint hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint hwnd, StringBuilder text, int maximumCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(nint hwnd, out NativeRect rect);
}

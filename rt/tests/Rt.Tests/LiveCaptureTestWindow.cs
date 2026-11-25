using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Rt.Windows.Capture;

namespace Rt.Tests;

/// <summary>An owned, no-activation test window. It never enumerates, moves, or injects input into other windows.</summary>
internal sealed class LiveCaptureTestWindow : IDisposable
{
    private const uint WmPaint = 0x000F;
    private const uint WmDestroy = 0x0002;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private const uint PmRemove = 0x0001;
    private static readonly ConcurrentDictionary<nint, LiveCaptureTestWindow> Windows = new();
    private static readonly WndProc WindowProcedure = DispatchWndProc;
    private static string? _className;
    private int _paintTick;

    internal LiveCaptureTestWindow(int x, int y, int width, int height)
    {
        EnsureClassRegistered();
        Handle = CreateWindowEx(
            0x00000080 | 0x00000008, // WS_EX_TOOLWINDOW | WS_EX_TOPMOST
            _className,
            "Rt owned live capture test window",
            0x80000000, // WS_POPUP
            x, y, width, height,
            0, 0, GetModuleHandle(null), 0);
        if (Handle == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWindowEx failed for the owned live test window.");
        Windows[Handle] = this;
        ShowWindow(Handle, 8); // SW_SHOWNA: no activation or input injection.
        if (!UpdateWindow(Handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateWindow failed for the owned live test window.");
        PumpMessages();
    }

    internal nint Handle { get; private set; }

    internal CapturePixelRect Bounds
    {
        get
        {
            if (!GetWindowRect(Handle, out var rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new CapturePixelRect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        }
    }

    internal void AdvanceFrame()
    {
        _paintTick++;
        if (!InvalidateRect(Handle, 0, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
        PumpMessages();
        UpdateWindow(Handle);
        PumpMessages();
    }

    internal void MoveBy(int dx, int dy)
    {
        var before = Bounds;
        if (!SetWindowPos(Handle, 0, before.X + dx, before.Y + dy, 0, 0, SwpNoSize | SwpNoZOrder | SwpNoActivate | SwpShowWindow))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetWindowPos failed for the owned live test window.");
        PumpMessages();
    }

    internal bool PumpUntil(Func<bool> condition, int timeoutMs = 10_000)
    {
        var stopwatch = Stopwatch.StartNew();
        do
        {
            PumpMessages();
            if (condition()) return true;
            Thread.Sleep(10);
        } while (stopwatch.ElapsedMilliseconds < timeoutMs);
        PumpMessages();
        return condition();
    }

    public void Dispose()
    {
        if (Handle == 0) return;
        Windows.TryRemove(Handle, out _);
        DestroyWindow(Handle);
        Handle = 0;
        PumpMessages();
    }

    private static void EnsureClassRegistered()
    {
        if (_className is not null) return;
        string name = "RtLiveCaptureTestWindow_" + Guid.NewGuid().ToString("N");
        var wc = new WndClassEx
        {
            Size = (uint)Marshal.SizeOf<WndClassEx>(),
            WndProc = Marshal.GetFunctionPointerForDelegate(WindowProcedure),
            Instance = GetModuleHandle(null),
            ClassName = name,
            Cursor = LoadCursor(0, 32512),
        };
        if (RegisterClassEx(ref wc) == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "RegisterClassEx failed for the owned live test window.");
        _className = name;
    }

    private static nint DispatchWndProc(nint hwnd, uint message, nint wParam, nint lParam)
    {
        if (message == WmPaint && Windows.TryGetValue(hwnd, out var window))
        {
            var paint = new PaintStruct();
            nint hdc = BeginPaint(hwnd, ref paint);
            try
            {
                var rect = new NativeRect();
                GetClientRect(hwnd, ref rect);
                uint[] colors = [0x00204080, 0x00804020, 0x00208040, 0x00802060];
                nint brush = CreateSolidBrush(colors[window._paintTick % colors.Length]);
                if (brush != 0)
                {
                    FillRect(hdc, ref rect, brush);
                    DeleteObject(brush);
                }
            }
            finally
            {
                EndPaint(hwnd, ref paint);
            }
            return 0;
        }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    private static void PumpMessages()
    {
        while (PeekMessage(out var message, 0, 0, 0, PmRemove))
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }

    private delegate nint WndProc(nint hwnd, uint message, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        internal uint Size;
        internal uint Style;
        internal nint WndProc;
        internal int ClassExtra;
        internal int WindowExtra;
        internal nint Instance;
        internal nint Icon;
        internal nint Cursor;
        internal nint Background;
        internal string? MenuName;
        internal string ClassName;
        internal nint IconSmall;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { internal int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { internal int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        internal nint Hwnd;
        internal uint Value;
        internal nint WParam;
        internal nint LParam;
        internal uint Time;
        internal Point Point;
        internal uint Private;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PaintStruct
    {
        internal nint Hdc;
        [MarshalAs(UnmanagedType.Bool)] internal bool Erase;
        internal NativeRect Paint;
        [MarshalAs(UnmanagedType.Bool)] internal bool Restore;
        [MarshalAs(UnmanagedType.Bool)] internal bool IncUpdate;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] internal byte[] Reserved;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WndClassEx windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowEx(uint exStyle, string? className, string windowName, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint DefWindowProc(nint hwnd, uint message, nint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateWindow(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(nint hwnd, out NativeRect rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(nint hwnd, ref NativeRect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(nint hwnd, nint insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool InvalidateRect(nint hwnd, nint rect, bool erase);
    [DllImport("user32.dll")] private static extern nint BeginPaint(nint hwnd, ref PaintStruct paint);
    [DllImport("user32.dll")] private static extern bool EndPaint(nint hwnd, ref PaintStruct paint);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PeekMessage(out Message message, nint hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DispatchMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint LoadCursor(nint instance, int cursorName);
    [DllImport("gdi32.dll")] private static extern nint CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint handle);
    [DllImport("user32.dll")] private static extern int FillRect(nint hdc, ref NativeRect rect, nint brush);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandle(string? moduleName);
}

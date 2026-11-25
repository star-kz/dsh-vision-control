using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Rt.Windows.Capture;

/// <summary>Native screen/window identity and metadata. No pixels are produced by a GDI fallback.</summary>
public static class WindowsCaptureDevices
{
    private const uint MonitorDefaultToPrimary = 1;
    // DPI awareness can be overridden per thread; never reuse one thread's verification on another.
    [ThreadStatic]
    private static bool _dpiAwarenessVerified;

    public static CaptureTarget GetPrimaryMonitorTarget()
    {
        EnsurePerMonitorDpiAwareness();
        nint monitor = MonitorFromWindow(0, MonitorDefaultToPrimary);
        if (monitor == 0) throw new InvalidOperationException("Windows did not return a primary monitor handle.");
        return CaptureTarget.ForMonitor(monitor);
    }

    public static CaptureGeometry GetGeometry(CaptureTarget target, CaptureRequest? request = null)
    {
        ArgumentNullException.ThrowIfNull(target);
        EnsurePerMonitorDpiAwareness();
        var native = ReadNativeBounds(target);
        if (native.ItemPixels.Width <= 0 || native.ItemPixels.Height <= 0)
            throw new InvalidOperationException("The capture target no longer has a readable native rectangle.");
        return CaptureGeometryCalculator.Create(
            native.ItemPixels,
            native.ItemPixels.X * 96.0 / native.DpiX,
            native.ItemPixels.Y * 96.0 / native.DpiY,
            native.DpiX,
            native.DpiY,
            request?.RoiLogical);
    }

    internal static CaptureItemState GetItemState(CaptureTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        EnsurePerMonitorDpiAwareness();
        long topology = GetDisplayTopologyVersion();
        if (target.Kind == CaptureTargetKind.Window && !IsWindow(target.Handle))
            return new CaptureItemState(target.Handle, 0, 0, 0, 0, topology, IsClosed: true);

        try
        {
            var native = ReadNativeBounds(target);
            return new CaptureItemState(
                target.Handle,
                native.ItemPixels.Width,
                native.ItemPixels.Height,
                native.DpiX,
                native.DpiY,
                topology,
                PhysicalX: native.ItemPixels.X,
                PhysicalY: native.ItemPixels.Y);
        }
        catch (Win32Exception) when (target.Kind == CaptureTargetKind.Monitor)
        {
            // A vanished HMONITOR is a topology mutation, never a reusable old-epoch frame plan.
            return new CaptureItemState(0, 0, 0, 0, 0, topology);
        }
    }

    private static NativeBounds ReadNativeBounds(CaptureTarget target)
    {
        NativeRect rect;
        int dpiX;
        int dpiY;
        if (target.Kind == CaptureTargetKind.Window)
        {
            if (!IsWindow(target.Handle))
                throw new InvalidOperationException("The authorized capture window is closed.");
            if (!GetWindowRect(target.Handle, out rect))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetWindowRect failed for the authorized capture target.");
            dpiX = dpiY = checked((int)GetDpiForWindow(target.Handle));
            if (dpiX == 0)
            {
                nint monitor = MonitorFromWindow(target.Handle, MonitorDefaultToPrimary);
                GetMonitorDpi(monitor, out dpiX, out dpiY);
            }
        }
        else
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (!GetMonitorInfo(target.Handle, ref info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetMonitorInfo failed for the capture monitor.");
            rect = info.Monitor;
            GetMonitorDpi(target.Handle, out dpiX, out dpiY);
        }

        var item = new CapturePixelRect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        if (item.Width <= 0 || item.Height <= 0)
            throw new InvalidOperationException($"The native target rectangle is empty: {item}.");
        return new NativeBounds(item, dpiX, dpiY);
    }

    private static void GetMonitorDpi(nint monitor, out int dpiX, out int dpiY)
    {
        int hr = GetDpiForMonitor(monitor, 0, out uint x, out uint y);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        if (x == 0 || y == 0) throw new InvalidOperationException("Windows returned a zero monitor DPI.");
        dpiX = checked((int)x);
        dpiY = checked((int)y);
    }

    private static long GetDisplayTopologyVersion()
    {
        var monitors = new List<(nint Handle, NativeRect Rect, uint DpiX, uint DpiY)>();
        MonitorEnumProc callback = (nint handle, nint hdc, ref NativeRect rect, nint data) =>
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(handle, ref info) && GetDpiForMonitor(handle, 0, out uint x, out uint y) == 0)
                monitors.Add((handle, info.Monitor, x, y));
            return true;
        };
        if (!EnumDisplayMonitors(0, 0, callback, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "EnumDisplayMonitors failed.");
        monitors.Sort(static (a, b) =>
        {
            int byHandle = a.Handle.CompareTo(b.Handle);
            if (byHandle != 0) return byHandle;
            int byLeft = a.Rect.Left.CompareTo(b.Rect.Left);
            return byLeft != 0 ? byLeft : a.Rect.Top.CompareTo(b.Rect.Top);
        });

        ulong hash = 14695981039346656037UL;
        foreach (var monitor in monitors)
        {
            Add(ref hash, unchecked((ulong)monitor.Handle.ToInt64()));
            Add(ref hash, unchecked((uint)monitor.Rect.Left));
            Add(ref hash, unchecked((uint)monitor.Rect.Top));
            Add(ref hash, unchecked((uint)monitor.Rect.Right));
            Add(ref hash, unchecked((uint)monitor.Rect.Bottom));
            Add(ref hash, monitor.DpiX);
            Add(ref hash, monitor.DpiY);
        }
        return unchecked((long)hash);

        static void Add(ref ulong value, ulong component)
        {
            value = unchecked((value ^ component) * 1099511628211UL);
        }
    }

    private static void EnsurePerMonitorDpiAwareness()
    {
        if (_dpiAwarenessVerified) return;
        DpiAwarenessEnsurer.Ensure(
            () => SetProcessDpiAwarenessContext(DpiAwarenessEnsurer.PerMonitorV2Context),
            Marshal.GetLastWin32Error,
            GetThreadDpiAwarenessContext,
            AreDpiAwarenessContextsEqual);
        _dpiAwarenessVerified = true;
    }

    private readonly record struct NativeBounds(CapturePixelRect ItemPixels, int DpiX, int DpiY);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        internal int Size;
        internal NativeRect Monitor;
        internal NativeRect Work;
        internal uint Flags;
    }

    private delegate bool MonitorEnumProc(nint monitor, nint hdc, ref NativeRect rect, nint data);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(nint dpiContext);

    [DllImport("user32.dll")]
    private static extern nint GetThreadDpiAwarenessContext();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AreDpiAwarenessContextsEqual(nint dpiContextA, nint dpiContextB);

    [DllImport("user32.dll")]
    private static extern nint MonitorFromWindow(nint hwnd, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(nint hwnd, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(nint hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(nint hdc, nint clip, MonitorEnumProc callback, nint data);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(nint monitor, int dpiType, out uint dpiX, out uint dpiY);
}

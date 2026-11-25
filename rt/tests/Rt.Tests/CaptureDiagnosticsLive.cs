using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using Rt.Core.Contracts;
using Rt.Windows.Capture;
using SharpDX.Direct3D11;

namespace Rt.Tests;

/// <summary>
/// Opt-in evidence collection for intermittent native capture failures. These tests do not
/// inject input, move foreign windows, replace a backend, or force a device reset.
/// </summary>
public static class CaptureDiagnosticsLive
{
    [RtFact(Category = "capture-diagnostics")]
    public static void WgcMonitor_NativeDeviceHealthMatchesSharpDxAcrossRestarts()
    {
        if (!DiagnosticsEnabled(nameof(WgcMonitor_NativeDeviceHealthMatchesSharpDxAcrossRestarts))) return;

        const int iterations = 12;
        for (int iteration = 1; iteration <= iterations; iteration++)
        {
            var target = WindowsCaptureDevices.GetPrimaryMonitorTarget();
            // Match the original live failure: full-monitor frames and full-size staging readback.
            var start = WindowsCaptureSession.StartAsync(target).GetAwaiter().GetResult();
            Assert.Equal(CaptureBackendKind.WindowsGraphicsCapture, start.Backend, $"diagnostic requires real WGC: {start.Detail}");
            using var session = Assert.NotNull(start.Session, "diagnostic WGC start returns a session");
            var device = GetPrivateField<Device>(session, "_device");
            string adapter = ReadAdapter(device);
            string infoQueue = ProbeInfoQueue(device);

            bool arrived = WaitUntil(() => session.Latest is not null || IsTerminal(session.Status), 5_000);
            Assert.True(
                arrived && session.Latest is not null,
                $"iteration={iteration} first frame required; status={session.Status}; detail={session.StatusDetail}; adapter={adapter}");
            long sequence = session.Latest!.Metadata.Sequence;
            for (int sample = 0; sample < 10; sample++)
            {
                int sharpDx = D3D11DeviceHealth.ReadRemovedReason(device);
                int native = ReadNativeRemovedReason(device);
                Assert.Equal(sharpDx, native, $"iteration={iteration} sample={sample} SharpDX and native GetDeviceRemovedReason must agree");
                Assert.Equal(
                    0,
                    native,
                    $"iteration={iteration} sample={sample} sequence={session.Latest?.Metadata.Sequence}; " +
                    $"status={session.Status}; detail={session.StatusDetail}; adapter={adapter}; infoQueue={infoQueue}");
                Thread.Sleep(50);
            }

            Console.WriteLine(
                $"RT_CAPTURE_DIAGNOSTICS WGC iteration={iteration}/{iterations} adapter={adapter} " +
                $"infoQueue={infoQueue} firstSequence={sequence} lastSequence={session.Latest?.Metadata.Sequence} " +
                $"sharpDx=0x{D3D11DeviceHealth.ReadRemovedReason(device):X8} native=0x{ReadNativeRemovedReason(device):X8} " +
                $"status={session.Status} detail={session.StatusDetail}");
        }
    }

    [RtFact(Category = "capture-diagnostics")]
    public static void DxgiOwnedWindow_VisibilityAndExpectedPixelsPrecedeContinuity()
    {
        if (!DiagnosticsEnabled(nameof(DxgiOwnedWindow_VisibilityAndExpectedPixelsPrecedeContinuity))) return;

        var target = WindowsCaptureDevices.GetPrimaryMonitorTarget();
        var initial = WindowsCaptureDevices.GetGeometry(target);
        var request = new CaptureRequest(new CaptureLogicalRect(
            initial.ItemLogical.X + 16,
            initial.ItemLogical.Y + 16,
            Math.Min(200, initial.ItemLogical.Width - 32),
            Math.Min(140, initial.ItemLogical.Height - 32)));
        using var ownedWindow = new LiveCaptureTestWindow(initial.ItemPixels.X + 32, initial.ItemPixels.Y + 32, 240, 160);
        AssertVisibleAtCenter(ownedWindow, "before DXGI start");

        // Inject only the already-tested support decision; native duplication/readback is production code.
        var start = WindowsCaptureSession.StartAsync(target, request, isWindows: true, () => false).GetAwaiter().GetResult();
        Assert.Equal(CaptureBackendKind.DxgiDesktopDuplication, start.Backend, $"diagnostic requires real DXGI: {start.Detail}");
        using var session = Assert.NotNull(start.Session, "diagnostic DXGI start returns a session");
        long sequence = 0;
        for (int paintTick = 0; paintTick < 4; paintTick++)
        {
            if (paintTick > 0) ownedWindow.AdvanceFrame();
            AssertVisibleAtCenter(ownedWindow, $"paintTick={paintTick}");
            byte[] expected = ExpectedBgra(paintTick);
            bool matched = ownedWindow.PumpUntil(() =>
            {
                var frame = session.Latest;
                return frame is not null && frame.Metadata.Sequence > sequence &&
                    TryReadOwnedWindowCenter(frame, ownedWindow.Bounds, out byte[] actual) && actual.AsSpan().SequenceEqual(expected);
            });
            string observed = session.Latest is { } latest && TryReadOwnedWindowCenter(latest, ownedWindow.Bounds, out byte[] pixels)
                ? Convert.ToHexString(pixels)
                : "outside-roi";
            Assert.True(
                matched,
                $"paintTick={paintTick} expectedCenter={Convert.ToHexString(expected)} observedCenter={observed}; " +
                $"status={session.Status}; detail={session.StatusDetail}; visibility={DescribeVisibility(ownedWindow.Handle)}");
            sequence = session.Latest!.Metadata.Sequence;
            Console.WriteLine(
                $"RT_CAPTURE_DIAGNOSTICS DXGI paintTick={paintTick} sequence={sequence} " +
                $"expectedCenter={Convert.ToHexString(expected)} observedCenter={observed} visibility={DescribeVisibility(ownedWindow.Handle)}");
        }
    }

    private static bool DiagnosticsEnabled(string name)
    {
        if (string.Equals(Environment.GetEnvironmentVariable("RT_CAPTURE_DIAGNOSTICS"), "1", StringComparison.Ordinal)) return true;
        Console.WriteLine($"[SKIP] {name}: set RT_CAPTURE_DIAGNOSTICS=1 to collect opt-in native capture evidence.");
        return false;
    }

    private static bool IsTerminal(CaptureSessionStatus status) =>
        status is CaptureSessionStatus.Stopped or CaptureSessionStatus.Invalidated or CaptureSessionStatus.Faulted;

    private static bool WaitUntil(Func<bool> condition, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        do
        {
            if (condition()) return true;
            Thread.Sleep(10);
        } while (stopwatch.ElapsedMilliseconds < timeoutMs);
        return condition();
    }

    private static T GetPrivateField<T>(object instance, string name) where T : class
    {
        var field = instance.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic);
        return Assert.NotNull(field, $"native diagnostic field {name} exists").GetValue(instance) as T
            ?? throw new AssertFailedException($"native diagnostic field {name} contains {typeof(T).Name}");
    }

    private static string ReadAdapter(Device device)
    {
        using var dxgiDevice = device.QueryInterface<SharpDX.DXGI.Device>();
        using var adapter = dxgiDevice.GetParent<SharpDX.DXGI.Adapter>();
        var description = adapter.Description;
        return $"{description.Description} vendor=0x{description.VendorId:X4} device=0x{description.DeviceId:X4} luid={description.Luid}";
    }

    private static string ProbeInfoQueue(Device device)
    {
        try
        {
            using var queue = device.QueryInterface<InfoQueue>();
            return $"available storedMessages={queue.NumStoredMessages}";
        }
        catch (SharpDX.SharpDXException ex)
        {
            return $"unavailable HRESULT=0x{unchecked((uint)ex.HResult):X8} (production device is not created with D3D11_DEBUG)";
        }
    }

    private static int ReadNativeRemovedReason(Device device)
    {
        nint vtable = Marshal.ReadIntPtr(device.NativePointer);
        nint function = Marshal.ReadIntPtr(vtable, 39 * nint.Size); // ID3D11Device::GetDeviceRemovedReason
        var native = Marshal.GetDelegateForFunctionPointer<GetDeviceRemovedReasonDelegate>(function);
        return native(device.NativePointer);
    }

    private static void AssertVisibleAtCenter(LiveCaptureTestWindow window, string phase)
    {
        string description = DescribeVisibility(window.Handle);
        Assert.True(IsWindowVisible(window.Handle), $"{phase}: owned window must be visible; {description}");
        Assert.False(IsIconic(window.Handle), $"{phase}: owned window must not be minimized; {description}");
        int exStyle = GetWindowLong(window.Handle, -20);
        Assert.True((exStyle & 0x00000008) != 0, $"{phase}: owned window must remain WS_EX_TOPMOST; {description}");
        var bounds = window.Bounds;
        var point = new NativePoint(bounds.X + bounds.Width / 2, bounds.Y + bounds.Height / 2);
        nint hit = WindowFromPoint(point);
        Assert.Equal(window.Handle, hit, $"{phase}: the visible topmost window at the owned window center must be the test window; {description}");
    }

    private static string DescribeVisibility(nint handle)
    {
        int exStyle = GetWindowLong(handle, -20);
        return $"hwnd=0x{handle.ToInt64():X} visible={IsWindowVisible(handle)} iconic={IsIconic(handle)} " +
            $"topmost={(exStyle & 0x00000008) != 0} exStyle=0x{unchecked((uint)exStyle):X8}";
    }

    private static byte[] ExpectedBgra(int paintTick) => (paintTick % 4) switch
    {
        0 => [0x20, 0x40, 0x80, 0xFF],
        1 => [0x80, 0x40, 0x20, 0xFF],
        2 => [0x20, 0x80, 0x40, 0xFF],
        _ => [0x80, 0x20, 0x60, 0xFF],
    };

    private static bool TryReadOwnedWindowCenter(ShadowCaptureFrame frame, CapturePixelRect bounds, out byte[] bgra)
    {
        int x = bounds.X + bounds.Width / 2 - frame.Geometry.RoiPixels.X;
        int y = bounds.Y + bounds.Height / 2 - frame.Geometry.RoiPixels.Y;
        if (x < 0 || y < 0 || x >= frame.Metadata.Width || y >= frame.Metadata.Height)
        {
            bgra = [];
            return false;
        }
        int offset = (y * frame.Metadata.Width + x) * 4;
        bgra = frame.Pixels.Span.Slice(offset, 4).ToArray();
        return true;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetDeviceRemovedReasonDelegate(nint self);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint(int x, int y)
    {
        internal int X = x;
        internal int Y = y;
    }

    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(nint hwnd, int index);
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(NativePoint point);
}

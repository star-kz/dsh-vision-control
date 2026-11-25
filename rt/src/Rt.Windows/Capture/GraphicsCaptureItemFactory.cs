using System.Runtime.InteropServices;
using Windows.Graphics.Capture;

namespace Rt.Windows.Capture;

/// <summary>The supported interop factory for an existing screen or explicitly authorized HWND; never opens a picker.</summary>
internal static class GraphicsCaptureItemFactory
{
    private static readonly Guid GraphicsCaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    internal static GraphicsCaptureItem Create(CaptureTarget target, out nint itemAbi)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        nint classNameHandle = 0;
        nint interopPointer = 0;
        itemAbi = 0;
        IGraphicsCaptureItemInterop? interop = null;
        try
        {
            Check(WindowsCreateString(className, (uint)className.Length, out classNameHandle), "WindowsCreateString(GraphicsCaptureItem)");
            Guid interopIid = typeof(IGraphicsCaptureItemInterop).GUID;
            Check(RoGetActivationFactory(classNameHandle, ref interopIid, out interopPointer), "RoGetActivationFactory(IGraphicsCaptureItemInterop)");
            interop = (IGraphicsCaptureItemInterop)Marshal.GetTypedObjectForIUnknown(interopPointer, typeof(IGraphicsCaptureItemInterop));
            Guid itemIid = GraphicsCaptureItemIid;
            int hr = target.Kind == CaptureTargetKind.Window
                ? interop.CreateForWindow(target.Handle, ref itemIid, out itemAbi)
                : interop.CreateForMonitor(target.Handle, ref itemIid, out itemAbi);
            Check(hr, target.Kind == CaptureTargetKind.Window ? "IGraphicsCaptureItemInterop.CreateForWindow" : "IGraphicsCaptureItemInterop.CreateForMonitor");
            var item = WinRT.MarshalInspectable<GraphicsCaptureItem>.FromAbi(itemAbi);
            return item ?? throw new InvalidOperationException("WGC returned a null GraphicsCaptureItem.");
        }
        catch
        {
            if (itemAbi != 0) Marshal.Release(itemAbi);
            itemAbi = 0;
            throw;
        }
        finally
        {
            if (classNameHandle != 0) WindowsDeleteString(classNameHandle);
            if (interop is not null && Marshal.IsComObject(interop)) Marshal.ReleaseComObject(interop);
            if (interopPointer != 0) Marshal.Release(interopPointer);
        }
    }

    private static void Check(int hr, string operation)
    {
        if (hr != 0) throw new InvalidOperationException($"{operation} failed with HRESULT 0x{hr:X8}.", Marshal.GetExceptionForHR(hr));
    }

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString(string sourceString, uint length, out nint hstring);

    [DllImport("combase.dll")]
    private static extern int WindowsDeleteString(nint hstring);

    [DllImport("combase.dll")]
    private static extern int RoGetActivationFactory(nint activatableClassId, ref Guid iid, out nint factory);

    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        // Native vtable order is CreateForWindow first, then CreateForMonitor.
        int CreateForWindow(nint window, ref Guid iid, out nint result);
        int CreateForMonitor(nint monitor, ref Guid iid, out nint result);
    }
}

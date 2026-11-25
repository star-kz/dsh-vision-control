using SharpDX;
using SharpDX.Direct3D11;
using SharpDX.DXGI;
using DxgiResource = SharpDX.DXGI.Resource;

namespace Rt.Windows.Capture;

/// <summary>Owns the real native DXGI duplication stream for exactly one authorized HMONITOR.</summary>
internal sealed class DxgiDesktopDuplicationBackend : IDisposable
{
    private const int DxgiErrorWaitTimeout = unchecked((int)0x887A0027);
    private readonly OutputDuplication _duplication;
    private readonly Thread? _thread;
    private readonly Action<DxgiResource, OutputDuplicateFrameInformation> _frameArrived;
    private readonly Action<Exception> _faulted;
    private volatile bool _disposed;
    private bool _resourcesDisposed;

    internal DxgiDesktopDuplicationBackend(
        CaptureTarget target,
        Action<DxgiResource, OutputDuplicateFrameInformation> frameArrived,
        Action<Exception> faulted)
    {
        ArgumentNullException.ThrowIfNull(target);
        if (target.Kind != CaptureTargetKind.Monitor)
            throw new NotSupportedException("DXGI Desktop Duplication is monitor-only and cannot impersonate window capture.");
        _frameArrived = frameArrived ?? throw new ArgumentNullException(nameof(frameArrived));
        _faulted = faulted ?? throw new ArgumentNullException(nameof(faulted));
        using var factory = new Factory1();
        foreach (var adapter in factory.Adapters1)
        {
            using (adapter)
            {
                foreach (var output in adapter.Outputs)
                {
                    using (output)
                    {
                        if (output.Description.MonitorHandle != target.Handle) continue;
                        using var output1 = output.QueryInterface<Output1>();
                        var device = new SharpDX.Direct3D11.Device(adapter, DeviceCreationFlags.BgraSupport);
                        try
                        {
                            _duplication = output1.DuplicateOutput(device);
                            Device = device;
                            var description = _duplication.Description;
                            if (description.Rotation != DisplayModeRotation.Identity)
                                throw new CaptureUnavailableException($"Capture Unavailable: DXGI rotation {description.Rotation} is not yet supported for this monitor plan.");
                            Width = description.ModeDescription.Width;
                            Height = description.ModeDescription.Height;
                            _thread = new Thread(Run)
                            {
                                IsBackground = true,
                                Name = $"Rt DXGI duplication {target.Handle}",
                            };
                            return;
                        }
                        catch
                        {
                            _duplication?.Dispose();
                            device.Dispose();
                            throw;
                        }
                    }
                }
            }
        }
        throw new CaptureUnavailableException($"Capture Unavailable: no DXGI output matches authorized monitor 0x{target.Handle.ToInt64():X}.");
    }

    internal SharpDX.Direct3D11.Device Device { get; }
    internal int Width { get; }
    internal int Height { get; }

    internal void Start()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DxgiDesktopDuplicationBackend));
        (_thread ?? throw new ObjectDisposedException(nameof(DxgiDesktopDuplicationBackend))).Start();
    }

    internal void RequestStop() => _disposed = true;

    private void Run()
    {
        while (!_disposed)
        {
            DxgiResource? resource = null;
            bool acquired = false;
            try
            {
                var result = _duplication.TryAcquireNextFrame(20, out var information, out resource);
                if (result.Code == DxgiErrorWaitTimeout) continue;
                if (result.Failure) throw new SharpDXException(result);
                acquired = true;
                if (!_disposed) _frameArrived(resource, information);
                _duplication.ReleaseFrame();
                acquired = false;
                resource.Dispose();
                resource = null;
            }
            catch (Exception ex)
            {
                if (!_disposed) _faulted(ex);
                return;
            }
            finally
            {
                resource?.Dispose();
                if (acquired)
                {
                    try { _duplication.ReleaseFrame(); }
                    catch { /* The acquisition is already ending through the fault/dispose path. */ }
                }
            }
        }
    }

    public void Dispose()
    {
        if (_resourcesDisposed) return;
        _disposed = true;
        if (_thread is not null && Thread.CurrentThread != _thread)
        {
            if (!_thread.Join(2000))
            {
                _duplication.Dispose(); // Interrupt a stuck native acquire before the final join.
                _thread.Join(2000);
            }
        }
        _duplication.Dispose();
        Device.Dispose();
        _resourcesDisposed = true;
    }
}

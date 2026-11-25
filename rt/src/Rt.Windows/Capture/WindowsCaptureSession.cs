using System.Runtime.InteropServices;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using SharpDX.Direct3D;
using SharpDX.Direct3D11;
using SharpDX.DXGI;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

namespace Rt.Windows.Capture;

/// <summary>
/// Real WGC/DXGI Desktop Duplication shadow capture. Native arrivals are read back and published directly;
/// there is no Node dependency, GDI stream, static-image fallback, or input injection.
/// Any item mutation advances the epoch and stops this plan; callers must start a new session.
/// </summary>
public sealed class WindowsCaptureSession : IDisposable
{
    private readonly object _frameSync = new();
    private readonly CaptureTarget _target;
    private readonly CaptureRequest _request;
    private readonly CaptureEpochTracker _epochs;
    private readonly LatestCaptureFrameBuffer _latest;
    private readonly string _sourceId;

    private SharpDX.Direct3D11.Device? _device;
    private IDirect3DDevice? _graphicsDevice;
    private nint _deviceAbi;
    private GraphicsCaptureItem? _item;
    private nint _itemAbi;
    private Direct3D11CaptureFramePool? _framePool;
    private GraphicsCaptureSession? _captureSession;
    private Texture2D? _staging;
    private DxgiDesktopDuplicationBackend? _dxgiBackend;
    private Texture2D? _dxgiStaging;
    private CaptureHealthPoller? _healthPoller;
    private Timer? _stateTimer;
    private CaptureGeometry? _geometry;
    private long _sequence;
    private volatile bool _disposed;
    private volatile CaptureSessionStatus _status = CaptureSessionStatus.Starting;
    private volatile string _statusDetail = "WGC session is starting.";

    private WindowsCaptureSession(CaptureTarget target, CaptureRequest? request)
    {
        _target = target ?? throw new ArgumentNullException(nameof(target));
        _request = request ?? new CaptureRequest();
        _epochs = new CaptureEpochTracker(WindowsCaptureDevices.GetItemState(target));
        _latest = new LatestCaptureFrameBuffer(_epochs);
        _sourceId = target.Kind == CaptureTargetKind.Window
            ? $"window:{target.Handle}:{target.AuthorizationId}"
            : $"monitor:{target.Handle}";
    }

    /// <summary>
    /// Raised outside _frameSync after latest-frame publication. Handlers must return immediately;
    /// slow consumption belongs on another worker, and consume/schedule/execute stages must each
    /// recheck SourceEpoch because invalidation can race the callback after its final current check.
    /// </summary>
    public event Action<ShadowCaptureFrame>? FrameAvailable;

    /// <summary>Handlers must be fast/non-blocking and schedule replanning outside the native callback.</summary>
    public event Action<CaptureInvalidation>? Invalidated;

    public CaptureSessionStatus Status => _status;
    public string StatusDetail => _statusDetail;
    public long CurrentEpoch => _epochs.CurrentEpoch;
    internal CaptureInvalidationReason? LastInvalidationReason => _epochs.LastInvalidationReason;
    public CaptureGeometry? Geometry => _geometry;
    public ShadowCaptureFrame? Latest => _latest.Latest;

    public static Task<CaptureStartResult> StartAsync(
        CaptureTarget target,
        CaptureRequest? request = null,
        CancellationToken cancellationToken = default)
        => StartAsync(target, request, OperatingSystem.IsWindows(), GraphicsCaptureSession.IsSupported, cancellationToken);

    // Internal probe injection makes the exact production selection/fallback path deterministic.
    // It never substitutes a frame source: a monitor fallback still constructs real DXGI duplication.
    internal static Task<CaptureStartResult> StartAsync(
        CaptureTarget target,
        CaptureRequest? request,
        bool isWindows,
        Func<bool> isWindowsGraphicsCaptureSupported,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(isWindowsGraphicsCaptureSupported);
        cancellationToken.ThrowIfCancellationRequested();
        bool wgcSupported = false;
        string probeDetail = "";
        try
        {
            wgcSupported = isWindows && isWindowsGraphicsCaptureSupported();
        }
        catch (Exception ex)
        {
            // A failed support probe cannot justify a window substitution. A monitor may
            // still use its own real DXGI stream, and the probe failure remains visible.
            probeDetail = $"WGC support probe failed: {ex.GetType().Name}: {ex.Message}. ";
        }

        var result = CaptureStartupCoordinator.Start(
            target,
            isWindows,
            wgcSupported,
            () => StartWgc(target, request),
            () => StartDxgi(target, request));
        return Task.FromResult(string.IsNullOrEmpty(probeDetail) ? result : result with { Detail = probeDetail + result.Detail });
    }

    /// <summary>Starts only real monitor duplication; exposed for explicit backend diagnostics/tests.</summary>
    public static Task<CaptureStartResult> StartDxgiAsync(
        CaptureTarget target,
        CaptureRequest? request = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(StartDxgi(target, request));
    }

    private static CaptureStartResult StartWgc(CaptureTarget target, CaptureRequest? request)
    {
        WindowsCaptureSession? session = null;
        try
        {
            session = new WindowsCaptureSession(target, request);
            session.Initialize();
            return new CaptureStartResult(
                CaptureBackendKind.WindowsGraphicsCapture,
                "Real WGC free-threaded stream with D3D11 BGRA32 readback; shadow only, no static fallback.",
                session);
        }
        catch (Exception ex)
        {
            session?.Dispose();
            return new CaptureStartResult(
                CaptureBackendKind.Unavailable,
                $"WGC was selected but real capture startup failed: {ex.GetType().Name}: {ex.Message}.",
                null);
        }
    }

    private static CaptureStartResult StartDxgi(CaptureTarget target, CaptureRequest? request)
    {
        if (!OperatingSystem.IsWindows())
            return new CaptureStartResult(CaptureBackendKind.Unavailable, "Capture Unavailable: DXGI Desktop Duplication requires Windows.", null);
        if (target.Kind != CaptureTargetKind.Monitor)
            return new CaptureStartResult(CaptureBackendKind.Unavailable, "Capture Unavailable: DXGI Desktop Duplication cannot capture an arbitrary authorized window.", null);

        WindowsCaptureSession? session = null;
        try
        {
            session = new WindowsCaptureSession(target, request);
            session.InitializeDxgi();
            return new CaptureStartResult(
                CaptureBackendKind.DxgiDesktopDuplication,
                "Real continuous DXGI Desktop Duplication monitor stream with D3D11 BGRA32 readback; no static or cross-target fallback.",
                session);
        }
        catch (Exception ex)
        {
            session?.Dispose();
            return new CaptureStartResult(
                CaptureBackendKind.Unavailable,
                $"Capture Unavailable: real DXGI Desktop Duplication startup failed: {ex.GetType().Name}: {ex.Message}. No fallback stream remains.",
                null);
        }
    }

    public CaptureSnapshot? CopyLatestSnapshot() => _latest.CopyLatestSnapshot();

    private void Initialize()
    {
        try
        {
            _device = new SharpDX.Direct3D11.Device(DriverType.Hardware, DeviceCreationFlags.BgraSupport);
            _healthPoller = new CaptureHealthPoller(
                _epochs,
                () => WindowsCaptureDevices.GetItemState(_target),
                () => D3D11DeviceHealth.ReadRemovedReason(_device!));
            Check(CreateDirect3D11DeviceFromDXGIDevice(_device.NativePointer, out _deviceAbi), "CreateDirect3D11DeviceFromDXGIDevice");
            _graphicsDevice = WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(_deviceAbi)
                ?? throw new InvalidOperationException("The D3D11-to-IDirect3DDevice bridge returned null.");
            _item = GraphicsCaptureItemFactory.Create(_target, out _itemAbi);
            var nativeGeometry = WindowsCaptureDevices.GetGeometry(_target, _request);
            // WGC item.Size is authoritative for texture coordinates; Win32 supplies origin and DPI.
            _geometry = CaptureGeometryCalculator.Create(
                new CapturePixelRect(nativeGeometry.ItemPixels.X, nativeGeometry.ItemPixels.Y, _item.Size.Width, _item.Size.Height),
                nativeGeometry.ItemLogical.X,
                nativeGeometry.ItemLogical.Y,
                nativeGeometry.DpiX,
                nativeGeometry.DpiY,
                _request.RoiLogical);

            _item.Closed += OnItemClosed;
            _framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                _graphicsDevice,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                numberOfBuffers: 2,
                _item.Size);
            _captureSession = _framePool.CreateCaptureSession(_item);
            _captureSession.IsCursorCaptureEnabled = false;
            _framePool.FrameArrived += OnFrameArrived;
            _captureSession.StartCapture();
            _status = CaptureSessionStatus.Streaming;
            _statusDetail = "WGC is streaming real D3D11 frames; no pixels are sent as input.";
            _stateTimer = new Timer(OnStatePoll, null, TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(250));
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    private void InitializeDxgi()
    {
        try
        {
            var nativeGeometry = WindowsCaptureDevices.GetGeometry(_target, _request);
            _dxgiBackend = new DxgiDesktopDuplicationBackend(_target, OnDxgiFrame, OnDxgiFaulted);
            _healthPoller = new CaptureHealthPoller(
                _epochs,
                () => WindowsCaptureDevices.GetItemState(_target),
                () => D3D11DeviceHealth.ReadRemovedReason(_dxgiBackend.Device));
            _geometry = CaptureGeometryCalculator.Create(
                new CapturePixelRect(
                    nativeGeometry.ItemPixels.X,
                    nativeGeometry.ItemPixels.Y,
                    _dxgiBackend.Width,
                    _dxgiBackend.Height),
                nativeGeometry.ItemLogical.X,
                nativeGeometry.ItemLogical.Y,
                nativeGeometry.DpiX,
                nativeGeometry.DpiY,
                _request.RoiLogical);
            _status = CaptureSessionStatus.Streaming;
            _statusDetail = "DXGI Desktop Duplication is streaming real monitor frames; no pixels are sent as input.";
            _dxgiBackend.Start();
            _stateTimer = new Timer(OnStatePoll, null, TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(250));
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    private void OnDxgiFrame(SharpDX.DXGI.Resource resource, OutputDuplicateFrameInformation information)
    {
        ShadowCaptureFrame? published = null;
        CaptureInvalidation? invalidated = null;
        lock (_frameSync)
        {
            if (_disposed || _status != CaptureSessionStatus.Streaming) return;
            try
            {
                var health = _healthPoller?.Poll() ?? throw new InvalidOperationException("Capture health polling was not initialized.");
                if (health.Reason is { } changed)
                {
                    invalidated = StopInvalidated(changed, health.Detail ?? $"Native DXGI health changed: {changed}.", health.AlreadyAdvanced);
                }
                else
                {
                    byte[] pixels = ReadDxgiPixels(resource);
                    long sequence = checked(++_sequence);
                    long capturedAtQpc = information.LastPresentTime != 0 ? information.LastPresentTime : Qpc.Now;
                    var metadata = new FrameMeta(
                        sequence,
                        _sourceId,
                        _epochs.CurrentEpoch,
                        capturedAtQpc,
                        Qpc.Now,
                        _geometry!.RoiPixels.Width,
                        _geometry.RoiPixels.Height,
                        FramePixelFormat.Bgra32);
                    var shadowFrame = new ShadowCaptureFrame(metadata, _geometry, pixels, CaptureFrameOrigin.DxgiDesktopDuplication);
                    if (_latest.Publish(shadowFrame)) published = shadowFrame;
                }
            }
            catch (Exception ex)
            {
                var reason = CaptureNativeFailure.Classify(ex);
                if (reason == CaptureInvalidationReason.BackendFaulted) _status = CaptureSessionStatus.Faulted;
                invalidated = StopInvalidated(
                    reason,
                    $"Real DXGI frame readback failed ({ex.GetType().Name}: {ex.Message}); classified {reason}. Old plans are invalid and no fallback was started.",
                    alreadyAdvanced: false);
            }
        }

        if (invalidated is { } change)
        {
            Invalidated?.Invoke(change);
            return;
        }
        if (published is not null && !_disposed && _status == CaptureSessionStatus.Streaming &&
            _epochs.IsCurrent(published.Metadata.SourceEpoch))
            FrameAvailable?.Invoke(published);
    }

    private byte[] ReadDxgiPixels(SharpDX.DXGI.Resource resource)
    {
        if (_dxgiBackend is null || _geometry is null) throw new ObjectDisposedException(nameof(WindowsCaptureSession));
        using var source = resource.QueryInterface<Texture2D>();
        var description = source.Description;
        if (description.Format is not (Format.B8G8R8A8_UNorm or Format.B8G8R8A8_UNorm_SRgb or Format.R16G16B16A16_Float))
            throw new NotSupportedException($"DXGI Desktop Duplication produced unsupported format {description.Format}.");
        if (description.Width != _geometry.ItemPixels.Width || description.Height != _geometry.ItemPixels.Height)
            throw new CaptureSizeChangedException($"DXGI surface is {description.Width}x{description.Height}, but the plan is {_geometry.ItemPixels.Width}x{_geometry.ItemPixels.Height}.");
        if (description.ArraySize != 1 || description.MipLevels != 1 || description.SampleDescription.Count != 1)
            throw new NotSupportedException("Only single-sample, single-mip 2D DXGI textures are supported.");

        if (_dxgiStaging is null || _dxgiStaging.Description.Format != description.Format ||
            _dxgiStaging.Description.Width != description.Width || _dxgiStaging.Description.Height != description.Height)
        {
            _dxgiStaging?.Dispose();
            _dxgiStaging = new Texture2D(_dxgiBackend.Device, new Texture2DDescription
            {
                Width = description.Width,
                Height = description.Height,
                ArraySize = 1,
                MipLevels = 1,
                Format = description.Format,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Staging,
                BindFlags = BindFlags.None,
                CpuAccessFlags = CpuAccessFlags.Read,
                OptionFlags = ResourceOptionFlags.None,
            });
        }

        var context = _dxgiBackend.Device.ImmediateContext;
        // An explicit full-subresource copy is required for the verified live adapter:
        // CopyResource returned zero-filled staging without a debug-queue error here.
        context.CopySubresourceRegion(source, 0, null, _dxgiStaging, 0);
        var mapped = context.MapSubresource(_dxgiStaging, 0, MapMode.Read, SharpDX.Direct3D11.MapFlags.None);
        try
        {
            var localRoi = new CapturePixelRect(
                _geometry.RoiPixels.X - _geometry.ItemPixels.X,
                _geometry.RoiPixels.Y - _geometry.ItemPixels.Y,
                _geometry.RoiPixels.Width,
                _geometry.RoiPixels.Height);
            return DxgiReadback.CopyRoi(mapped.DataPointer, description.Width, description.Height, mapped.RowPitch, localRoi, description.Format);
        }
        finally
        {
            context.UnmapSubresource(_dxgiStaging, 0);
        }
    }

    private void OnDxgiFaulted(Exception exception)
    {
        CaptureInvalidation? invalidated = null;
        lock (_frameSync)
        {
            if (_disposed || _status is CaptureSessionStatus.Stopped or CaptureSessionStatus.Invalidated or CaptureSessionStatus.Faulted) return;
            var reason = CaptureNativeFailure.Classify(exception);
            if (reason == CaptureInvalidationReason.BackendFaulted) _status = CaptureSessionStatus.Faulted;
            invalidated = StopInvalidated(
                reason,
                $"Real DXGI acquisition failed ({exception.GetType().Name}: {exception.Message}); classified {reason}. Recreate the monitor plan/backend.",
                alreadyAdvanced: false);
        }
        if (invalidated is { } change) Invalidated?.Invoke(change);
    }

    private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args)
    {
        ShadowCaptureFrame? published = null;
        CaptureInvalidation? invalidated = null;
        lock (_frameSync)
        {
            if (_disposed || _status != CaptureSessionStatus.Streaming) return;
            try
            {
                using var frame = sender.TryGetNextFrame();
                var health = _healthPoller?.Poll() ?? throw new InvalidOperationException("Capture health polling was not initialized.");
                if (health.Reason is { } changed)
                {
                    invalidated = StopInvalidated(changed, health.Detail ?? $"Native capture health changed: {changed}.", health.AlreadyAdvanced);
                }
                else if (_geometry is null || frame.ContentSize.Width != _geometry.ItemPixels.Width ||
                    frame.ContentSize.Height != _geometry.ItemPixels.Height)
                {
                    invalidated = StopInvalidated(CaptureInvalidationReason.SizeChanged, "WGC content size no longer matches the capture plan.", alreadyAdvanced: false);
                }
                else
                {
                    byte[] pixels = ReadPixels(frame);
                    long sequence = checked(++_sequence);
                    var metadata = new FrameMeta(
                        sequence,
                        _sourceId,
                        _epochs.CurrentEpoch,
                        Qpc.FromTimeSpan(frame.SystemRelativeTime),
                        Qpc.Now,
                        _geometry.RoiPixels.Width,
                        _geometry.RoiPixels.Height,
                        FramePixelFormat.Bgra32);
                    var shadowFrame = new ShadowCaptureFrame(metadata, _geometry, pixels, CaptureFrameOrigin.WindowsGraphicsCapture);
                    if (_latest.Publish(shadowFrame)) published = shadowFrame;
                }
            }
            catch (CaptureSizeChangedException ex)
            {
                invalidated = StopInvalidated(CaptureInvalidationReason.SizeChanged, ex.Message, alreadyAdvanced: false);
            }
            catch (Exception ex)
            {
                var reason = CaptureNativeFailure.Classify(ex);
                if (reason == CaptureInvalidationReason.BackendFaulted) _status = CaptureSessionStatus.Faulted;
                invalidated = StopInvalidated(
                    reason,
                    $"Real WGC frame readback failed ({ex.GetType().Name}: {ex.Message}); classified {reason}. Old plans are invalid and no fallback was started.",
                    alreadyAdvanced: false);
            }
        }

        if (invalidated is { } change)
        {
            Invalidated?.Invoke(change);
            return;
        }
        // Never run consumer code while holding _frameSync. The epoch check is deliberately
        // repeated here; a later invalidation is handled by the consumer-side contract above.
        if (published is not null && !_disposed && _status == CaptureSessionStatus.Streaming &&
            _epochs.IsCurrent(published.Metadata.SourceEpoch))
            FrameAvailable?.Invoke(published);
    }

    private byte[] ReadPixels(Direct3D11CaptureFrame frame)
    {
        if (_device is null || _geometry is null) throw new ObjectDisposedException(nameof(WindowsCaptureSession));
        using var source = GetD3D11Texture(frame.Surface);
        var description = source.Description;
        if (description.Format != Format.B8G8R8A8_UNorm)
            throw new InvalidOperationException($"WGC produced {description.Format}; the capture plan requires B8G8R8A8_UNorm.");
        if (description.Width != _geometry.ItemPixels.Width || description.Height != _geometry.ItemPixels.Height)
            throw new CaptureSizeChangedException($"D3D11 surface is {description.Width}x{description.Height}, but the plan is {_geometry.ItemPixels.Width}x{_geometry.ItemPixels.Height}.");
        if (description.ArraySize != 1 || description.MipLevels != 1 || description.SampleDescription.Count != 1)
            throw new NotSupportedException("Only single-samples, single-mip 2D WGC textures are supported.");

        if (_staging is null)
        {
            _staging = new Texture2D(_device, new Texture2DDescription
            {
                Width = description.Width,
                Height = description.Height,
                ArraySize = 1,
                MipLevels = 1,
                Format = Format.B8G8R8A8_UNorm,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Staging,
                BindFlags = BindFlags.None,
                CpuAccessFlags = CpuAccessFlags.Read,
                OptionFlags = ResourceOptionFlags.None,
            });
        }

        var context = _device.ImmediateContext;
        // Match the DXGI readback path: explicit full-subresource copy avoids the
        // zero-filled/unstable CopyResource behavior observed on this live adapter.
        context.CopySubresourceRegion(source, 0, null, _staging, 0);
        var mapped = context.MapSubresource(_staging, 0, MapMode.Read, SharpDX.Direct3D11.MapFlags.None);
        try
        {
            var localRoi = new CapturePixelRect(
                _geometry.RoiPixels.X - _geometry.ItemPixels.X,
                _geometry.RoiPixels.Y - _geometry.ItemPixels.Y,
                _geometry.RoiPixels.Width,
                _geometry.RoiPixels.Height);
            return BgraReadback.CopyRoi(mapped.DataPointer, description.Width, description.Height, mapped.RowPitch, localRoi);
        }
        finally
        {
            context.UnmapSubresource(_staging, 0);
        }
    }

    private static Texture2D GetD3D11Texture(IDirect3DSurface surface)
    {
        // CsWinRT projects IDirect3DSurface as IInspectable, not as a COM-importable
        // IDirect3DDxgiInterfaceAccess. Obtain its ABI, QI for the access interface,
        // then invoke its single post-IUnknown vtable method without a managed cast.
        if (surface is not WinRT.IInspectable inspectable)
            throw new NotSupportedException($"WGC surface RCW {surface.GetType().FullName} does not expose its native IInspectable pointer.");
        var surfaceAbi = inspectable.ThisPtr;
        Guid accessIid = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");
        Guid textureIid = new("6F15AAF2-D208-4E89-9AB4-489535D34F9C"); // ID3D11Texture2D
        nint access = 0;
        nint texture = 0;
        try
        {
            Check(Marshal.QueryInterface(surfaceAbi, ref accessIid, out access), "IDirect3DSurface QI(IDirect3DDxgiInterfaceAccess)");
            var vtable = Marshal.ReadIntPtr(access);
            var getInterface = Marshal.GetDelegateForFunctionPointer<GetInterfaceDelegate>(Marshal.ReadIntPtr(vtable, 3 * nint.Size));
            Check(getInterface(access, ref textureIid, out texture), "IDirect3DDxgiInterfaceAccess.GetInterface(ID3D11Texture2D)");
            var result = new Texture2D(texture);
            texture = 0; // SharpDX owns the native reference now.
            return result;
        }
        finally
        {
            if (texture != 0) Marshal.Release(texture);
            if (access != 0) Marshal.Release(access);
        }
    }

    private void OnItemClosed(GraphicsCaptureItem sender, object args)
    {
        CaptureInvalidation? invalidated = null;
        lock (_frameSync)
        {
            if (_disposed || _status is CaptureSessionStatus.Stopped or CaptureSessionStatus.Invalidated or CaptureSessionStatus.Faulted) return;
            invalidated = StopInvalidated(CaptureInvalidationReason.ItemClosed, "The WGC item raised Closed.", alreadyAdvanced: false);
        }
        if (invalidated is { } change) Invalidated?.Invoke(change);
    }

    private void OnStatePoll(object? state)
    {
        CaptureInvalidation? invalidated = null;
        lock (_frameSync)
        {
            if (_disposed || _status != CaptureSessionStatus.Streaming) return;
            try
            {
                var health = _healthPoller?.Poll() ?? throw new InvalidOperationException("Capture health polling was not initialized.");
                if (health.Reason is { } changed)
                    invalidated = StopInvalidated(changed, health.Detail ?? $"Native state poll observed {changed}; restart with a fresh geometry plan.", health.AlreadyAdvanced);
            }
            catch (Exception ex)
            {
                var reason = CaptureNativeFailure.Classify(ex);
                if (reason == CaptureInvalidationReason.BackendFaulted) _status = CaptureSessionStatus.Faulted;
                invalidated = StopInvalidated(reason, $"Native capture health poll failed ({ex.GetType().Name}: {ex.Message}); classified {reason}.", alreadyAdvanced: false);
            }
        }
        // User code is deliberately outside _frameSync. Consumers must still return quickly
        // and recheck SourceEpoch at consume, schedule and execute time.
        if (invalidated is { } change) Invalidated?.Invoke(change);
    }

    private CaptureInvalidation StopInvalidated(CaptureInvalidationReason reason, string detail, bool alreadyAdvanced)
    {
        if (!alreadyAdvanced) _epochs.Invalidate(reason);
        if (_status != CaptureSessionStatus.Faulted) _status = CaptureSessionStatus.Invalidated;
        _statusDetail = detail;
        _stateTimer?.Change(Timeout.Infinite, Timeout.Infinite);
        _dxgiBackend?.RequestStop();
        try { _captureSession?.Dispose(); } catch (Exception ex) { _statusDetail = $"{detail} Session stop also failed: {ex.Message}"; }
        return new CaptureInvalidation(_epochs.CurrentEpoch, reason, _statusDetail);
    }

    public void Dispose()
    {
        lock (_frameSync)
        {
            if (_disposed) return;
            _disposed = true;
            _status = CaptureSessionStatus.Stopped;
            _statusDetail = "Native capture session disposed; no fallback stream remains.";
            _stateTimer?.Dispose();
            _stateTimer = null;
            _healthPoller = null;
            if (_item is not null) _item.Closed -= OnItemClosed;
            if (_framePool is not null) _framePool.FrameArrived -= OnFrameArrived;
            _captureSession?.Dispose();
            _framePool?.Dispose();
            _staging?.Dispose();
            _dxgiStaging?.Dispose();
            _dxgiBackend?.Dispose();
            _device?.Dispose();
            if (_itemAbi != 0) Marshal.Release(_itemAbi);
            if (_deviceAbi != 0) Marshal.Release(_deviceAbi);
            _itemAbi = _deviceAbi = 0;
            _captureSession = null;
            _framePool = null;
            _staging = null;
            _dxgiStaging = null;
            _dxgiBackend = null;
            _device = null;
            _item = null;
            _graphicsDevice = null;
        }
    }

    private static void Check(int hr, string operation)
    {
        if (hr != 0) throw new InvalidOperationException($"{operation} failed with HRESULT 0x{hr:X8}.", Marshal.GetExceptionForHR(hr));
    }

    [DllImport("d3d11.dll")]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgiDevice, out nint graphicsDevice);

    private sealed class CaptureSizeChangedException(string message) : Exception(message);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetInterfaceDelegate(nint self, ref Guid iid, out nint result);
}

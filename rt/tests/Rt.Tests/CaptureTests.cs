using System.Diagnostics;
using Rt.Core.Contracts;
using Rt.Windows.Capture;

namespace Rt.Tests;

/// <summary>Deterministic capture contracts plus an opt-in, read-only WGC smoke test.</summary>
public static class CaptureTests
{
    [RtFact]
    public static void CaptureGeometry_MapsLogicalRoiToPhysicalPixels_At192Dpi()
    {
        var geometry = CaptureGeometryCalculator.Create(
            new CapturePixelRect(0, 0, 2560, 1600),
            logicalX: 0,
            logicalY: 0,
            dpiX: 192,
            dpiY: 192,
            new CaptureLogicalRect(100, 50, 640, 400));

        Assert.Equal(new CaptureLogicalRect(0, 0, 1280, 800), geometry.ItemLogical, "physical item and DPI determine logical item bounds");
        Assert.Equal(new CapturePixelRect(200, 100, 1280, 800), geometry.RoiPixels, "ROI is converted from logical to physical pixels");
        Assert.Equal(new CaptureLogicalRect(100, 50, 640, 400), geometry.RoiLogical, "logical ROI metadata round-trips");
        Assert.Equal(1280, geometry.RoiPixels.Width, "ROI physical width");
        Assert.Equal(800, geometry.RoiPixels.Height, "ROI physical height");
    }

    [RtFact]
    public static void CaptureGeometry_ClampsRoiToItemBounds()
    {
        var geometry = CaptureGeometryCalculator.Create(
            new CapturePixelRect(0, 0, 1920, 1080),
            logicalX: 0,
            logicalY: 0,
            dpiX: 96,
            dpiY: 96,
            new CaptureLogicalRect(-20, -30, 100, 100));

        Assert.Equal(new CapturePixelRect(0, 0, 80, 70), geometry.RoiPixels, "only the in-item portion is captured");
        Assert.Equal(new CaptureLogicalRect(0, 0, 80, 70), geometry.RoiLogical, "logical metadata describes the clamped ROI");
    }

    [RtFact]
    public static void CaptureGeometry_RejectsRoiOutsideItem()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => CaptureGeometryCalculator.Create(
            new CapturePixelRect(0, 0, 1920, 1080),
            logicalX: 0,
            logicalY: 0,
            dpiX: 96,
            dpiY: 96,
            new CaptureLogicalRect(2000, 0, 100, 100)), "an empty intersection cannot produce a capture stream");
    }

    [RtFact]
    public static void CaptureTarget_WindowRequiresExplicitAuthorization()
    {
        var target = CaptureTarget.ForAuthorizedWindow(1234, "run-7");
        Assert.Equal(CaptureTargetKind.Window, target.Kind, "window target kind");
        Assert.Equal((nint)1234, target.Handle, "window handle");
        Assert.Equal("run-7", target.AuthorizationId, "authorization identity is retained for auditing");

        Assert.Throws<ArgumentException>(() => CaptureTarget.ForAuthorizedWindow(1234, ""), "an unlabelled window is not an authorized capture target");
        Assert.Throws<ArgumentOutOfRangeException>(() => CaptureTarget.ForAuthorizedWindow(0, "run-7"), "a null HWND is invalid");

        var monitor = CaptureTarget.ForMonitor(99);
        Assert.Equal(CaptureTargetKind.Monitor, monitor.Kind, "monitor target kind");
        Assert.Null(monitor.AuthorizationId, "monitor capture needs no window authorization id");
    }

    [RtFact]
    public static void DpiAwareness_AccessDeniedAcceptsOnlyVerifiedPerMonitorV2()
    {
        DpiAwarenessEnsurer.Ensure(
            () => false,
            () => 5,
            () => new nint(-4),
            (left, right) => left == right);

        var error = Assert.Throws<CaptureUnavailableException>(
            () => DpiAwarenessEnsurer.Ensure(
                () => false,
                () => 5,
                () => new nint(-3),
                (left, right) => left == right),
            "ACCESS_DENIED with PerMonitor (not V2) must not continue with uncertain coordinates");
        Assert.True(error.Message.Contains("PerMonitorV2", StringComparison.Ordinal), "the required awareness is explicit");
        Assert.True(error.Message.Contains("Unavailable", StringComparison.Ordinal), "the failure maps explicitly to Unavailable");
    }

    [RtFact]
    public static void DpiAwareness_SuccessSkipsProbeAndOtherErrorsRemainFailures()
    {
        bool contextQueried = false;
        DpiAwarenessEnsurer.Ensure(
            () => true,
            () => 0,
            () =>
            {
                contextQueried = true;
                return 0;
            },
            (left, right) => left == right);
        Assert.False(contextQueried, "a successful SetProcessDpiAwarenessContext needs no fallback probe");

        Assert.Throws<System.ComponentModel.Win32Exception>(
            () => DpiAwarenessEnsurer.Ensure(
                () => false,
                () => 87,
                () => new nint(-4),
                (left, right) => left == right),
            "errors other than ACCESS_DENIED retain their native failure");
    }

    [RtFact]
    public static void CaptureHealth_NoFrames_DeviceRemovalPollInvalidatesOldPlan()
    {
        var initial = new CaptureItemState(1, 2560, 1600, 144, 144, 1);
        var epochs = new CaptureEpochTracker(initial);
        long initialEpoch = epochs.CurrentEpoch;
        var readCount = 0;
        var deviceRemovedReason = 0;
        var poller = new CaptureHealthPoller(
            epochs,
            () =>
            {
                readCount++;
                return initial;
            },
            () => deviceRemovedReason);

        var healthy = poller.Poll();
        Assert.Null(healthy.Reason, "healthy device and unchanged item preserve the plan");
        Assert.Equal(initialEpoch, epochs.CurrentEpoch, "healthy poll preserves the epoch");
        Assert.Equal(1, readCount, "native item state was polled without any frame");

        deviceRemovedReason = unchecked((int)0x887A0005);
        var removed = poller.Poll();
        Assert.Equal(CaptureInvalidationReason.AccessLost, removed.Reason, "device removal is observed without a new frame");
        Assert.Equal(initialEpoch + 1, epochs.CurrentEpoch, "device removal invalidates the old plan");
        Assert.Equal(1, readCount, "device health is checked before native item state");
        Assert.True((removed.Detail ?? "").Contains("887A0005", StringComparison.Ordinal), "the real native health code is retained");
    }

    [RtFact]
    public static void CaptureHealth_ItemMovePollAdvancesExactlyOnceWithoutFrames()
    {
        var initial = new CaptureItemState(1, 240, 160, 144, 144, 1);
        var current = initial;
        var epochs = new CaptureEpochTracker(initial);
        long oldEpoch = epochs.CurrentEpoch;
        var poller = new CaptureHealthPoller(epochs, () => current, () => 0);

        current = initial with { PhysicalX = 24, PhysicalY = 16 };
        var moved = poller.Poll();
        Assert.Equal(CaptureInvalidationReason.PositionChanged, moved.Reason, "the no-frame poll observes the origin change");
        Assert.True(moved.AlreadyAdvanced, "Observe already advanced the epoch; the session must not invalidate it again");
        if (!moved.AlreadyAdvanced) epochs.Invalidate(moved.Reason!.Value); // Mirror WindowsCaptureSession.StopInvalidated.
        Assert.Equal(oldEpoch + 1, epochs.CurrentEpoch, "one real same-size move invalidates exactly one old plan");
    }

    [RtFact]
    public static void CaptureFailure_OrdinaryReadbackErrorIsNotAccessLost()
    {
        Assert.Equal(
            CaptureInvalidationReason.BackendFaulted,
            CaptureNativeFailure.Classify(new InvalidOperationException("ordinary readback failure")),
            "ordinary errors have their own failure reason");
        Assert.Equal(
            CaptureInvalidationReason.AccessLost,
            CaptureNativeFailure.Classify(new System.Runtime.InteropServices.COMException(
                "access lost",
                unchecked((int)0x887A0026))),
            "explicit DXGI access loss remains AccessLost");
        Assert.Equal(
            CaptureInvalidationReason.AccessLost,
            CaptureNativeFailure.Classify(new System.Runtime.InteropServices.COMException(
                "device reset",
                unchecked((int)0x887A0007))),
            "explicit device reset remains AccessLost");
    }

    [RtFact]
    public static void CaptureEpoch_ItemMutationsInvalidateOldPlansExactlyOnce()
    {
        var initial = new CaptureItemState(7, 1920, 1080, 96, 96, TopologyVersion: 3);
        (CaptureItemState State, CaptureInvalidationReason Reason)[] mutations =
        [
            (initial with { IsClosed = true }, CaptureInvalidationReason.ItemClosed),
            (initial with { AccessLost = true }, CaptureInvalidationReason.AccessLost),
            (initial with { PhysicalWidth = 2560 }, CaptureInvalidationReason.SizeChanged),
            (initial with { DpiX = 144, DpiY = 144 }, CaptureInvalidationReason.DpiChanged),
            (initial with { PhysicalX = 320, PhysicalY = -40 }, CaptureInvalidationReason.PositionChanged),
            (initial with { TopologyVersion = 4 }, CaptureInvalidationReason.TopologyChanged),
            (initial with { Handle = 8 }, CaptureInvalidationReason.TopologyChanged),
        ];

        foreach (var mutation in mutations)
        {
            var epochs = new CaptureEpochTracker(initial);
            long oldEpoch = epochs.CurrentEpoch;
            Assert.Equal(mutation.Reason, epochs.Observe(mutation.State), "the actual item mutation is reported");
            Assert.Equal(oldEpoch + 1, epochs.CurrentEpoch, "every item mutation advances the epoch");
            Assert.False(epochs.IsCurrent(oldEpoch), "old frame plans are invalid after the mutation");
            Assert.Null(epochs.Observe(mutation.State), "the same state does not repeatedly invalidate the stream");
            Assert.Equal(oldEpoch + 1, epochs.CurrentEpoch, "unchanged state preserves the new epoch");
        }
    }

    [RtFact]
    public static void LatestFrame_CoalescesAndRejectsStaleEpochs()
    {
        var initial = new CaptureItemState(7, 2, 1, 96, 96, TopologyVersion: 1);
        var epochs = new CaptureEpochTracker(initial);
        var latest = new LatestCaptureFrameBuffer(epochs);
        int callbacks = 0;
        latest.FrameAvailable += _ => callbacks++;

        Assert.True(latest.Publish(CreateFrame(sequence: 1, epoch: 1, firstByte: 10)), "first current-epoch frame is published");
        Assert.True(latest.Publish(CreateFrame(sequence: 2, epoch: 1, firstByte: 20)), "new current-epoch frame replaces the previous latest frame");
        Assert.Equal(2L, Assert.NotNull(latest.Latest, "a latest frame exists").Metadata.Sequence, "slow consumers see only the newest frame");
        Assert.Equal(2, callbacks, "native arrivals invoke the callback without a Node scheduler");

        epochs.Observe(initial with { AccessLost = true });
        Assert.False(latest.Publish(CreateFrame(sequence: 3, epoch: 1, firstByte: 30)), "an old-epoch arrival cannot overwrite the stream");
        Assert.Null(latest.Latest, "invalidated frames are not exposed to consumers");
        Assert.Null(latest.CopyLatestSnapshot(), "invalidated frames cannot be saved by the slow loop");
        Assert.Equal(2, callbacks, "stale arrivals do not raise callbacks");

        Assert.True(latest.Publish(CreateFrame(sequence: 1, epoch: 2, firstByte: 40)), "a rebuilt stream may restart sequence numbers in its new epoch");
        Assert.Equal(3, callbacks, "only accepted current-epoch arrivals raise callbacks");
    }

    [RtFact]
    public static void SlowLoopSnapshot_RechecksEpochAfterDeterministicCopy()
    {
        var initial = new CaptureItemState(7, 2, 1, 96, 96, TopologyVersion: 1);
        var epochs = new CaptureEpochTracker(initial);
        long publishedEpoch = epochs.CurrentEpoch;
        var latest = new LatestCaptureFrameBuffer(epochs, pixels =>
        {
            byte[] copy = pixels.ToArray();
            epochs.Observe(initial with { PhysicalX = 1 });
            return copy;
        });
        Assert.True(latest.Publish(CreateFrame(sequence: 1, epoch: publishedEpoch, firstByte: 10)), "the frame starts current");

        Assert.Null(latest.CopyLatestSnapshot(), "an invalidation after the pixel copy but before return must reject the snapshot");
        Assert.Null(latest.Latest, "the stale frame cannot remain visible to a later consumer");
        Assert.Equal(publishedEpoch + 1, epochs.CurrentEpoch, "the copy-time native mutation advanced the epoch exactly once");
    }

    [RtFact]
    public static void SlowLoopSnapshot_IsDetachedRawBgra32WithStrideAndOrigin()
    {
        var epochs = new CaptureEpochTracker(new CaptureItemState(7, 2, 1, 96, 96, TopologyVersion: 1));
        var latest = new LatestCaptureFrameBuffer(epochs);
        byte[] pixels = [1, 2, 3, 255, 4, 5, 6, 255];
        Assert.True(latest.Publish(CreateFrame(1, 1, pixels[0], pixels)), "test frame is accepted");

        var snapshot = Assert.NotNull(latest.CopyLatestSnapshot(), "slow loop receives a snapshot");
        Assert.Equal(CaptureSnapshotFormat.Bgra32Raw, snapshot.Format, "snapshot encoding is explicit, not an ambiguous bitmap");
        Assert.Equal(CaptureFrameOrigin.WindowsGraphicsCapture, snapshot.Origin, "snapshot origin identifies the real WGC path");
        Assert.Equal(8, snapshot.StrideBytes, "raw BGRA stride is width times four");
        Assert.Equal(8, snapshot.Pixels.Length, "snapshot contains exactly one tightly packed ROI");
        pixels[0] = 99;
        Assert.Equal((byte)1, snapshot.Pixels.Span[0], "snapshot bytes are detached from later producer buffer reuse");
    }

    [RtFact]
    public static void BackendSelection_WgcUnsupportedUsesRealDxgiMonitorFallbackOnly()
    {
        var monitor = CaptureBackendSelector.Select(
            isWindows: true,
            isWindowsGraphicsCaptureSupported: false,
            CaptureTargetKind.Monitor);
        Assert.Equal(CaptureBackendKind.DxgiDesktopDuplication, monitor.Backend, "unsupported WGC selects real DXGI monitor duplication");
        Assert.True(monitor.IsStreaming, "DXGI duplication is a continuous native frame stream");
        Assert.True(monitor.Detail.Contains("Desktop Duplication", StringComparison.Ordinal), "the real fallback technology is explicit");

        var window = CaptureBackendSelector.Select(
            isWindows: true,
            isWindowsGraphicsCaptureSupported: false,
            CaptureTargetKind.Window);
        Assert.Equal(CaptureBackendKind.Unavailable, window.Backend, "window capture has no DXGI monitor impersonation fallback");
        Assert.False(window.IsStreaming, "an unsupported window never becomes a static or monitor stream");

        var nonWindows = CaptureBackendSelector.Select(false, false, CaptureTargetKind.Monitor);
        Assert.Equal(CaptureBackendKind.Unavailable, nonWindows.Backend, "DXGI fallback remains Windows-only");

        var supported = CaptureBackendSelector.Select(true, true, CaptureTargetKind.Monitor);
        Assert.Equal(CaptureBackendKind.WindowsGraphicsCapture, supported.Backend, "supported systems prefer the real WGC path");
        Assert.True(supported.IsStreaming, "the real WGC backend is a frame stream");
    }

    [RtFact]
    public static void BackendSelection_WgcStartupFailureFallsBackOnlyForMonitor()
    {
        int dxgiCalls = 0;
        CaptureStartResult StartDxgi()
        {
            dxgiCalls++;
            return new CaptureStartResult(CaptureBackendKind.DxgiDesktopDuplication, "injected DXGI start result", null);
        }

        var monitor = CaptureStartupCoordinator.Start(
            CaptureTarget.ForMonitor(1),
            isWindows: true,
            isWindowsGraphicsCaptureSupported: true,
            () => new CaptureStartResult(CaptureBackendKind.Unavailable, "injected WGC startup failure", null),
            StartDxgi);
        Assert.Equal(CaptureBackendKind.DxgiDesktopDuplication, monitor.Backend, "a real monitor fallback follows WGC startup failure");
        Assert.Equal(1, dxgiCalls, "the monitor fallback is attempted exactly once");

        var window = CaptureStartupCoordinator.Start(
            CaptureTarget.ForAuthorizedWindow(2, "capture-tests"),
            isWindows: true,
            isWindowsGraphicsCaptureSupported: true,
            () => new CaptureStartResult(CaptureBackendKind.Unavailable, "injected WGC startup failure", null),
            StartDxgi);
        Assert.Equal(CaptureBackendKind.Unavailable, window.Backend, "a failed window start stays explicitly unavailable");
        Assert.Equal(1, dxgiCalls, "window failure never starts a monitor duplication stream");
    }

    [RtFact]
    public static void BgraReadback_CopiesPhysicalRoiFromPaddedNativeStride()
    {
        byte[] source = new byte[40];
        for (int i = 0; i < source.Length; i++) source[i] = (byte)i;

        byte[] roi = BgraReadback.CopyRoi(
            source,
            sourceWidth: 4,
            sourceHeight: 2,
            sourceStrideBytes: 20,
            new CapturePixelRect(1, 0, 2, 2));

        byte[] expected = [4, 5, 6, 7, 8, 9, 10, 11, 24, 25, 26, 27, 28, 29, 30, 31];
        Assert.True(
            roi.AsSpan().SequenceEqual(expected),
            "native row pitch is removed and only the physical ROI is retained");
    }

    [RtFact]
    public static void DxgiReadback_ConvertsObservedHdrHalfFloatRoiToRealBgra()
    {
        const int sourceWidth = 2;
        const int sourceHeight = 2;
        const int sourceStride = 24; // Two RGBA16F pixels plus eight bytes of native padding.
        byte[] source = new byte[sourceStride * sourceHeight];
        WriteHalfPixel(source, 8, 1f, 0f, 0.5f, 1f);
        WriteHalfPixel(source, sourceStride + 8, 0.25f, -1f, 2f, 0.5f);

        byte[] bgra = DxgiReadback.CopyRoi(
            source,
            sourceWidth,
            sourceHeight,
            sourceStride,
            new CapturePixelRect(1, 0, 1, 2),
            SharpDX.DXGI.Format.R16G16B16A16_Float);

        byte[] expected = [188, 0, 255, 255, 255, 0, 137, 128];
        Assert.True(
            bgra.AsSpan().SequenceEqual(expected),
            "observed scRGB half-float DXGI frames become real tightly packed BGRA, including a nonzero ROI and padded stride");
    }

    private static void WriteHalfPixel(byte[] destination, int offset, float r, float g, float b, float a)
    {
        WriteHalf(destination, offset, r);
        WriteHalf(destination, offset + 2, g);
        WriteHalf(destination, offset + 4, b);
        WriteHalf(destination, offset + 6, a);
    }

    private static void WriteHalf(byte[] destination, int offset, float value)
    {
        ushort bits = BitConverter.HalfToUInt16Bits((Half)value);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(destination.AsSpan(offset, 2), bits);
    }

    [RtFact(Category = "live-capture")]
    public static async Task LiveWgcShadowCapture_ReceivesRealFrameAndSlowSnapshot()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("RT_LIVE_CAPTURE"), "1", StringComparison.Ordinal))
        {
            Console.WriteLine("[SKIP] LiveWgcShadowCapture_ReceivesRealFrameAndSlowSnapshot: set RT_LIVE_CAPTURE=1 to access the real primary display.");
            return;
        }

        var stopwatch = Stopwatch.StartNew();
        var target = WindowsCaptureDevices.GetPrimaryMonitorTarget();
        var start = await WindowsCaptureSession.StartAsync(target).ConfigureAwait(false);
        Assert.Equal(CaptureBackendKind.WindowsGraphicsCapture, start.Backend, $"live smoke requires real WGC, not fallback: {start.Detail}");
        using var session = Assert.NotNull(start.Session, "supported live start returns a real session");
        var arrived = new TaskCompletionSource<ShadowCaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        CaptureInvalidation? invalidation = null;
        session.Invalidated += change => invalidation = change;
        session.FrameAvailable += frame => arrived.TrySetResult(frame);
        if (session.Latest is { } existing) arrived.TrySetResult(existing);
        var completed = await Task.WhenAny(arrived.Task, Task.Delay(10_000)).ConfigureAwait(false);
        Assert.Same(
            arrived.Task,
            completed,
            $"real WGC must deliver a frame within ten seconds; status={session.Status}, epoch={session.CurrentEpoch}, " +
            $"detail={session.StatusDetail}, invalidation={invalidation}");
        var frame = await arrived.Task.ConfigureAwait(false);
        stopwatch.Stop();
        var latestSnapshot = session.CopyLatestSnapshot();
        if (latestSnapshot is null) await Task.Delay(100).ConfigureAwait(false); // Allow a concurrent invalidation to publish its native detail.
        var snapshot = Assert.NotNull(
            session.CopyLatestSnapshot(),
            $"the live latest frame has a detached slow-loop snapshot; status={session.Status}, " +
            $"epoch={session.CurrentEpoch}, frameEpoch={frame.Metadata.SourceEpoch}, lastReason={session.LastInvalidationReason}, " +
            $"detail={session.StatusDetail}, invalidation={invalidation}");

        Assert.Equal(FramePixelFormat.Bgra32, frame.Metadata.Format, "real WGC readback is BGRA32");
        Assert.Equal(frame.Geometry.RoiPixels.Width, frame.Metadata.Width, "metadata width matches the physical ROI");
        Assert.Equal(frame.Geometry.RoiPixels.Height, frame.Metadata.Height, "metadata height matches the physical ROI");
        Assert.Equal(frame.Metadata.Width * 4, snapshot.StrideBytes, "live snapshot has tight BGRA stride");
        Assert.Equal(snapshot.StrideBytes * frame.Metadata.Height, snapshot.Pixels.Length, "live snapshot is complete");
        Assert.Equal(CaptureFrameOrigin.WindowsGraphicsCapture, snapshot.Origin, "live snapshot cannot come from a static screenshot");
        Console.WriteLine(
            $"RT_LIVE_CAPTURE measured frame={frame.Metadata.Width}x{frame.Metadata.Height} " +
            $"format={frame.Metadata.Format} firstFrameMs={stopwatch.Elapsed.TotalMilliseconds:F3} " +
            $"item={frame.Geometry.ItemPixels.Width}x{frame.Geometry.ItemPixels.Height} " +
            $"dpi={frame.Geometry.DpiX}x{frame.Geometry.DpiY} " +
            $"logicalItem={frame.Geometry.ItemLogical.X:F2},{frame.Geometry.ItemLogical.Y:F2}," +
            $"{frame.Geometry.ItemLogical.Width:F2}x{frame.Geometry.ItemLogical.Height:F2} " +
            $"snapshot={snapshot.Format}/{snapshot.Pixels.Length}bytes origin={snapshot.Origin}");
    }

    [RtFact(Category = "live-capture")]
    public static void LiveDxgiMonitorFallback_ReceivesContinuousRealFramesAndNonZeroRoi()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("RT_LIVE_CAPTURE"), "1", StringComparison.Ordinal))
        {
            Console.WriteLine("[SKIP] LiveDxgiMonitorFallback_ReceivesContinuousRealFramesAndNonZeroRoi: set RT_LIVE_CAPTURE=1 to duplicate the real primary display.");
            return;
        }

        var target = WindowsCaptureDevices.GetPrimaryMonitorTarget();
        var initial = WindowsCaptureDevices.GetGeometry(target);
        var request = new CaptureRequest(new CaptureLogicalRect(
            initial.ItemLogical.X + 16,
            initial.ItemLogical.Y + 16,
            Math.Min(200, initial.ItemLogical.Width - 32),
            Math.Min(140, initial.ItemLogical.Height - 32)));
        using var ownedWindow = new LiveCaptureTestWindow(initial.ItemPixels.X + 32, initial.ItemPixels.Y + 32, 240, 160);
        var stopwatch = Stopwatch.StartNew();
        // Inject only the WGC support decision; the rest is the production fallback and real native DXGI path.
        var start = WindowsCaptureSession.StartAsync(target, request, isWindows: true, () => false).GetAwaiter().GetResult();
        if (start.Backend == CaptureBackendKind.Unavailable)
        {
            Console.WriteLine($"[SKIP] LiveDxgiMonitorFallback: native DXGI duplication unavailable: {start.Detail}");
            return;
        }
        Assert.Equal(CaptureBackendKind.DxgiDesktopDuplication, start.Backend, "injected WGC-unsupported production fallback selects real DXGI duplication");
        using var session = Assert.NotNull(start.Session, "real DXGI start returns a native session");
        Assert.True(
            ownedWindow.PumpUntil(() => session.Latest is not null),
            $"real DXGI must deliver a first frame; status={session.Status}, detail={session.StatusDetail}");
        var first = session.Latest!;
        stopwatch.Stop();
        Assert.Equal(CaptureFrameOrigin.DxgiDesktopDuplication, first.Origin, "DXGI frames carry their actual native origin");
        Assert.Equal(FramePixelFormat.Bgra32, first.Metadata.Format, "DXGI readback uses the common BGRA contract");
        Assert.True(first.Geometry.RoiPixels.X > first.Geometry.ItemPixels.X, "live DXGI ROI has a nonzero physical X offset");
        Assert.True(first.Geometry.RoiPixels.Y > first.Geometry.ItemPixels.Y, "live DXGI ROI has a nonzero physical Y offset");

        long sequence = first.Metadata.Sequence;
        byte[] previousPixels = first.Pixels.ToArray();
        for (int i = 0; i < 3; i++)
        {
            ownedWindow.AdvanceFrame();
            bool changed = ownedWindow.PumpUntil(() => session.Latest is { } candidate &&
                candidate.Metadata.Sequence > sequence && !candidate.Pixels.Span.SequenceEqual(previousPixels));
            Assert.True(
                changed,
                $"owned-window paint must produce a changed real DXGI frame {i + 1}; status={session.Status}, detail={session.StatusDetail}");
            var next = session.Latest!;
            Assert.False(next.Pixels.Span.SequenceEqual(previousPixels), "the owned window's changed pixels are captured, not a repeated static image");
            sequence = next.Metadata.Sequence;
            previousPixels = next.Pixels.ToArray();
        }

        var snapshot = Assert.NotNull(session.CopyLatestSnapshot(), "DXGI latest frame supports detached slow-loop snapshots");
        Assert.Equal(CaptureFrameOrigin.DxgiDesktopDuplication, snapshot.Origin, "snapshot preserves DXGI origin");
        Assert.Equal(snapshot.Metadata.Width * 4, snapshot.StrideBytes, "DXGI snapshot has tight BGRA stride");
        Console.WriteLine(
            $"RT_LIVE_CAPTURE DXGI measured firstFrameMs={stopwatch.Elapsed.TotalMilliseconds:F3} " +
            $"continuousLastSequence={sequence} origin={snapshot.Origin} format={snapshot.Format} " +
            $"roi={snapshot.Geometry.RoiPixels.X},{snapshot.Geometry.RoiPixels.Y}," +
            $"{snapshot.Geometry.RoiPixels.Width}x{snapshot.Geometry.RoiPixels.Height} " +
            $"item={snapshot.Geometry.ItemPixels.Width}x{snapshot.Geometry.ItemPixels.Height} dpi={snapshot.Geometry.DpiX}x{snapshot.Geometry.DpiY}");
    }

    [RtFact(Category = "live-capture")]
    public static void LiveWgcOwnWindow_ContinuousFramesAndSameSizeMoveInvalidateOldEpoch()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("RT_LIVE_CAPTURE"), "1", StringComparison.Ordinal))
        {
            Console.WriteLine("[SKIP] LiveWgcOwnWindow_ContinuousFramesAndSameSizeMoveInvalidateOldEpoch: set RT_LIVE_CAPTURE=1 to capture only this test's owned window.");
            return;
        }

        var monitor = WindowsCaptureDevices.GetPrimaryMonitorTarget();
        var monitorGeometry = WindowsCaptureDevices.GetGeometry(monitor);
        using var ownedWindow = new LiveCaptureTestWindow(monitorGeometry.ItemPixels.X + 32, monitorGeometry.ItemPixels.Y + 32, 240, 160);
        var target = CaptureTarget.ForAuthorizedWindow(ownedWindow.Handle, "rt-capture-owned-live-test");
        var initial = WindowsCaptureDevices.GetGeometry(target);
        var request = new CaptureRequest(new CaptureLogicalRect(
            initial.ItemLogical.X + 6,
            initial.ItemLogical.Y + 6,
            50,
            40));
        var start = WindowsCaptureSession.StartAsync(target, request).GetAwaiter().GetResult();
        if (start.Backend == CaptureBackendKind.Unavailable)
        {
            Console.WriteLine($"[SKIP] LiveWgcOwnWindow: native WGC window capture unavailable: {start.Detail}");
            return;
        }
        Assert.Equal(CaptureBackendKind.WindowsGraphicsCapture, start.Backend, "window fallback never substitutes DXGI monitor capture");
        using var session = Assert.NotNull(start.Session, "owned-window WGC start returns a native session");
        Assert.True(
            ownedWindow.PumpUntil(() => session.Latest is not null),
            $"owned-window WGC must deliver a first frame; status={session.Status}, detail={session.StatusDetail}");
        var first = session.Latest!;
        Assert.True(first.Geometry.RoiPixels.X > first.Geometry.ItemPixels.X, "live WGC ROI has a nonzero physical X offset");
        Assert.True(first.Geometry.RoiPixels.Y > first.Geometry.ItemPixels.Y, "live WGC ROI has a nonzero physical Y offset");

        long sequence = first.Metadata.Sequence;
        byte[] previousPixels = first.Pixels.ToArray();
        for (int i = 0; i < 2; i++)
        {
            ownedWindow.AdvanceFrame();
            Assert.True(
                ownedWindow.PumpUntil(() => session.Latest is { } candidate &&
                    candidate.Metadata.Sequence > sequence && !candidate.Pixels.Span.SequenceEqual(previousPixels)),
                $"owned-window paint must produce a changed real WGC frame {i + 1}; status={session.Status}, detail={session.StatusDetail}");
            var next = session.Latest!;
            Assert.False(next.Pixels.Span.SequenceEqual(previousPixels), "WGC observes real changed pixels from the owned window");
            sequence = next.Metadata.Sequence;
            previousPixels = next.Pixels.ToArray();
        }

        bool? invalidationReleasedNativeLock = null;
        session.Invalidated += _ =>
        {
            // Deliberate adversarial consumer: Dispose on another thread must not wait on a
            // lock held by the native invalidation callback. The callback itself remains short.
            invalidationReleasedNativeLock = Task.Run(session.Dispose).Wait(2_000);
        };
        long oldEpoch = session.CurrentEpoch;
        var before = WindowsCaptureDevices.GetItemState(target);
        var beforeBounds = ownedWindow.Bounds;
        ownedWindow.MoveBy(24, 16);
        var afterBounds = ownedWindow.Bounds;
        var after = WindowsCaptureDevices.GetItemState(target);
        Assert.Equal(beforeBounds.Width, afterBounds.Width, "the owned test window keeps its width");
        Assert.Equal(beforeBounds.Height, afterBounds.Height, "the owned test window keeps its height");
        Assert.Equal(before.DpiX, after.DpiX, "the owned test window stays at the same X DPI");
        Assert.Equal(before.DpiY, after.DpiY, "the owned test window stays at the same Y DPI");
        Assert.True(after.PhysicalX != before.PhysicalX || after.PhysicalY != before.PhysicalY, "the owned test window really changed physical origin");
        Assert.True(
            ownedWindow.PumpUntil(() => session.LastInvalidationReason == CaptureInvalidationReason.PositionChanged),
            $"same-size/same-DPI move must publish PositionChanged; status={session.Status}, detail={session.StatusDetail}, last={session.LastInvalidationReason}");
        Assert.Equal(oldEpoch + 1, session.CurrentEpoch, "move advances exactly one capture epoch");
        Assert.True(invalidationReleasedNativeLock == true, "Invalidated is invoked without holding the native frame lock");
        Assert.True(session.CopyLatestSnapshot() is null, "old-epoch latest pixels cannot be consumed after the move");
        Console.WriteLine(
            $"RT_LIVE_CAPTURE owned-window move origin=({before.PhysicalX},{before.PhysicalY})->({after.PhysicalX},{after.PhysicalY}) " +
            $"size={afterBounds.Width}x{afterBounds.Height} dpi={after.DpiX}x{after.DpiY} " +
            $"epoch={oldEpoch}->{session.CurrentEpoch} reason={session.LastInvalidationReason} continuousLastSequence={sequence}");
    }

    private static ShadowCaptureFrame CreateFrame(long sequence, long epoch, byte firstByte, byte[]? pixels = null)
    {
        var geometry = CaptureGeometryCalculator.Create(new CapturePixelRect(0, 0, 2, 1), 0, 0, 96, 96);
        pixels ??= [firstByte, 2, 3, 255, 4, 5, 6, 255];
        var metadata = new FrameMeta(sequence, "test:monitor", epoch, 100, 110, 2, 1, FramePixelFormat.Bgra32);
        return new ShadowCaptureFrame(metadata, geometry, pixels, CaptureFrameOrigin.WindowsGraphicsCapture);
    }
}

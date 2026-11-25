using SharpDX.Direct3D11;

namespace Rt.Windows.Capture;

/// <summary>The result of polling native capture health independently of frame arrival.</summary>
internal readonly record struct CaptureHealthPollResult(
    CaptureInvalidationReason? Reason,
    string? Detail,
    bool AlreadyAdvanced = false);

/// <summary>
/// Polls both native item state and the real D3D11 removal reason. The delegates are
/// injectable so a no-frame device loss can be tested without forcing hardware removal.
/// </summary>
internal sealed class CaptureHealthPoller
{
    private readonly CaptureEpochTracker _epochs;
    private readonly Func<CaptureItemState> _readItemState;
    private readonly Func<int> _readDeviceRemovedReason;

    public CaptureHealthPoller(
        CaptureEpochTracker epochs,
        Func<CaptureItemState> readItemState,
        Func<int> readDeviceRemovedReason)
    {
        _epochs = epochs ?? throw new ArgumentNullException(nameof(epochs));
        _readItemState = readItemState ?? throw new ArgumentNullException(nameof(readItemState));
        _readDeviceRemovedReason = readDeviceRemovedReason ?? throw new ArgumentNullException(nameof(readDeviceRemovedReason));
    }

    public CaptureHealthPollResult Poll()
    {
        // Health is checked first: a removed device must not be hidden by a secondary
        // GetItemState failure, and this path runs even when no frame ever arrives.
        int removedReason = _readDeviceRemovedReason();
        if (removedReason != 0)
        {
            const CaptureInvalidationReason deviceReason = CaptureInvalidationReason.AccessLost;
            _epochs.Invalidate(deviceReason);
            return new CaptureHealthPollResult(
                deviceReason,
                $"D3D11 DeviceRemovedReason=0x{removedReason:X8}. Invalidate and recreate the capture plan/backend.",
                AlreadyAdvanced: true);
        }

        CaptureInvalidationReason? itemReason = _epochs.Observe(_readItemState());
        return itemReason is { } reason
            ? new CaptureHealthPollResult(
                reason,
                $"Native capture item changed: {reason}. Consume/schedule/execute stages must recheck the epoch.",
                AlreadyAdvanced: true)
            : default;
    }
}

internal static class D3D11DeviceHealth
{
    public static int ReadRemovedReason(Device device)
    {
        ArgumentNullException.ThrowIfNull(device);
        return device.DeviceRemovedReason.Code;
    }
}

/// <summary>Separates explicit native device/access loss from other backend faults.</summary>
internal static class CaptureNativeFailure
{
    public static CaptureInvalidationReason Classify(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        return IsDeviceOrAccessLoss(unchecked((uint)exception.HResult))
            ? CaptureInvalidationReason.AccessLost
            : CaptureInvalidationReason.BackendFaulted;
    }

    private static bool IsDeviceOrAccessLoss(uint hresult) => hresult switch
    {
        0x887A0005 => true, // DXGI_ERROR_DEVICE_REMOVED
        0x887A0006 => true, // DXGI_ERROR_DEVICE_HUNG
        0x887A0007 => true, // DXGI_ERROR_DEVICE_RESET
        0x887A0026 => true, // DXGI_ERROR_ACCESS_LOST
        0x887A002B => true, // DXGI_ERROR_ACCESS_DENIED
        0x887A0028 => true, // DXGI_ERROR_SESSION_DISCONNECTED
        0x887A0029 => true, // DXGI_ERROR_REMOTE_SESSION_DISCONNECTED
        _ => false,
    };
}

using Rt.Core.Clocks;

namespace Rt.Core.Runtime;

/// <summary>A native-clock timeout whose completion is independent of any caller/Node abort token.</summary>
public sealed class NativeDeadline : IDisposable
{
    private readonly CancellationTokenSource _cancel = new();
    private readonly TaskCompletionSource _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _expired;
    private int _disposed;

    private NativeDeadline(ISchedulableClock clock, TimeSpan timeout)
    {
        if (timeout < TimeSpan.Zero || timeout == Timeout.InfiniteTimeSpan)
            throw new ArgumentOutOfRangeException(nameof(timeout));
        DueQpc = clock.Now + clock.FromTimeSpan(timeout);
        _ = Run(clock);
    }

    public long DueQpc { get; }
    public bool IsExpired => Volatile.Read(ref _expired) != 0;
    public Task Completion => _completion.Task;
    public static NativeDeadline Start(ISchedulableClock clock, TimeSpan timeout) => new(clock, timeout);

    private async Task Run(ISchedulableClock clock)
    {
        try
        {
            await clock.WaitUntilAsync(DueQpc, _cancel.Token).ConfigureAwait(false);
            Interlocked.Exchange(ref _expired, 1);
            _completion.TrySetResult();
        }
        catch (OperationCanceledException) { _completion.TrySetResult(); }
        catch (Exception ex) { _completion.TrySetException(ex); }
    }

    public void Cancel()
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        try { _cancel.Cancel(); } catch (ObjectDisposedException) { }
        _completion.TrySetResult();
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { _cancel.Cancel(); } catch (ObjectDisposedException) { }
        _completion.TrySetResult();
        _cancel.Dispose();
    }
}

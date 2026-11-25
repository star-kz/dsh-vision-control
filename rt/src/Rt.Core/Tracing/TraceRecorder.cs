using System.Text.Json;
using System.Threading.Channels;

namespace Rt.Core.Tracing;

/// <summary>
/// Bounded single-writer asynchronous trace recorder. Producers only serialize an envelope header
/// and perform Channel.TryWrite under a short in-memory lock; all encoding, disk I/O and flushing
/// happen on the consumer task. Overflow is lossy by design and is counted, never waited on.
/// </summary>
public sealed class TraceRecorder : IAsyncDisposable
{
    private readonly Channel<TraceEnvelope> _channel;
    private readonly Task _consumer;
    private readonly object _writeGate = new();
    private long _accepted;
    private long _dropped;
    private long _sequence;
    private bool _completed;

    public TraceRecorder(string path, int capacity = 1024)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        _channel = CreateChannel(capacity);
        _consumer = Task.Run(() => ConsumePathAsync(path));
    }

    public TraceRecorder(Stream stream, int capacity = 1024, bool leaveOpen = false)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (!stream.CanWrite) throw new ArgumentException("trace stream must be writable", nameof(stream));
        _channel = CreateChannel(capacity);
        _consumer = Task.Run(() => ConsumeAsync(stream, leaveOpen));
    }

    public long AcceptedCount => Volatile.Read(ref _accepted);
    public long DroppedCount => Volatile.Read(ref _dropped);

    public bool TryRecord(string kind, long timestampQpc, JsonElement payload, JsonElement? extensions = null)
    {
        // Validate and detach JSON before taking the producer lock.
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        lock (_writeGate)
        {
            if (_completed) return false;
            var envelope = new TraceEnvelope(kind, _sequence, timestampQpc, payload, extensions);
            if (!_channel.Writer.TryWrite(envelope))
            {
                _dropped++;
                return false;
            }
            // Advance only after acceptance, so accepted records remain contiguous.
            _sequence++;
            _accepted++;
            return true;
        }
    }

    public async Task CompleteAsync()
    {
        lock (_writeGate)
        {
            if (!_completed)
            {
                _completed = true;
                _channel.Writer.TryComplete();
            }
        }
        await _consumer.ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync() => await CompleteAsync().ConfigureAwait(false);

    private static Channel<TraceEnvelope> CreateChannel(int capacity)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(capacity, 0);
        return Channel.CreateBounded<TraceEnvelope>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
        });
    }

    private async Task ConsumePathAsync(string path)
    {
        var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read,
            64 * 1024, FileOptions.Asynchronous);
        await ConsumeAsync(stream, leaveOpen: false).ConfigureAwait(false);
    }

    private async Task ConsumeAsync(Stream stream, bool leaveOpen)
    {
        try
        {
            await foreach (TraceEnvelope queued in _channel.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                byte[] record = TraceFile.Encode(queued);
                await stream.WriteAsync(record).ConfigureAwait(false);
                // A live trace_read must observe complete records before the run is stopped.
                // Flush when the bounded consumer catches up; producers still never wait on disk I/O.
                if (_channel.Reader.Count == 0) await stream.FlushAsync().ConfigureAwait(false);
            }
            await stream.FlushAsync().ConfigureAwait(false);
        }
        finally
        {
            if (!leaveOpen) await stream.DisposeAsync().ConfigureAwait(false);
        }
    }
}

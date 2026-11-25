namespace Rt.Core.Runtime;

/// <summary>Session/run admission and shutdown. No factory, Freeze, Stop, or native call runs under the registry lock.</summary>
public sealed class RunCoordinator : IAsyncDisposable
{
    private readonly RunHostFactory _factory;
    private readonly object _sync = new();
    private readonly Dictionary<(string Session, string Run), Entry> _entries = new();
    private bool _disposed;

    public RunCoordinator(RunHostFactory factory) => _factory = factory ?? throw new ArgumentNullException(nameof(factory));

    public int Count { get { lock (_sync) return _entries.Count; } }

    public async Task<IRunHost> StartAsync(RunStartRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.SessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.RunId);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.TargetId);
        var key = (request.SessionId, request.RunId);
        Entry entry;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_entries.ContainsKey(key)) throw new DuplicateRunException(key.Item1, key.Item2);
            if (request.Mode == WorkerRunMode.Active && _entries.Values.Any(x =>
                    x.Request.Mode == WorkerRunMode.Active && x.Request.TargetId == request.TargetId))
                throw new ActiveTargetBusyException(request.TargetId);
            entry = new Entry(request);
            _entries.Add(key, entry);
        }

        IRunHost host;
        try
        {
            host = await _factory(request, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException("run host factory returned null");
            lock (_sync) entry.Host = host;
            entry.Started.TrySetResult(host);
            return host;
        }
        catch (Exception ex)
        {
            lock (_sync) _entries.Remove(key);
            entry.Started.TrySetException(ex);
            throw;
        }
    }

    public IRunHost Get(string sessionId, string runId)
    {
        lock (_sync)
        {
            if (!_entries.TryGetValue((sessionId, runId), out Entry? entry)) throw new RunNotFoundException(sessionId, runId);
            return entry.Host ?? throw new InvalidOperationException($"run '{sessionId}/{runId}' is still starting");
        }
    }

    public Task StopAsync(string sessionId, string runId)
    {
        Entry? entry;
        TaskCompletionSource? completion = null;
        IRunHost? immediate;
        lock (_sync)
        {
            if (!_entries.TryGetValue((sessionId, runId), out entry)) return Task.CompletedTask;
            immediate = entry.Host;
            if (entry.StopCompletion is null)
            {
                completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                entry.StopCompletion = completion;
            }
        }

        // Freeze is non-blocking, idempotent at the coordinator boundary, and takes priority.
        if (immediate is not null && Interlocked.Exchange(ref entry.FreezeSignaled, 1) == 0) immediate.Freeze();
        if (completion is not null) _ = CompleteStopAsync((sessionId, runId), entry, completion);
        return entry.StopCompletion!.Task;
    }

    private async Task CompleteStopAsync((string Session, string Run) key, Entry entry, TaskCompletionSource completion)
    {
        bool cleanupSucceeded = false;
        try
        {
            IRunHost host = await entry.Started.Task.ConfigureAwait(false);
            if (Interlocked.Exchange(ref entry.FreezeSignaled, 1) == 0) host.Freeze();
            await host.StopAsync().ConfigureAwait(false);
            cleanupSucceeded = true;
            completion.TrySetResult();
        }
        catch (Exception ex) { completion.TrySetException(ex); }
        finally
        {
            // Unknown/failed shutdown retains its host and active target exclusion. Removing it
            // would manufacture an idempotent "stopped" response and admit another writer.
            if (cleanupSucceeded) lock (_sync) _entries.Remove(key);
        }
    }

    public void Heartbeat(string sessionId)
    {
        IRunHost[] hosts;
        lock (_sync) hosts = _entries.Where(x => x.Key.Session == sessionId).Select(x => x.Value.Host).Where(x => x is not null).Cast<IRunHost>().ToArray();
        foreach (IRunHost host in hosts) host.Heartbeat();
    }

    public async ValueTask DisposeAsync()
    {
        (string Session, string Run)[] keys;
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true;
            keys = _entries.Keys.ToArray();
        }
        var failures = new List<Exception>();
        foreach (var key in keys)
        {
            try { await StopAsync(key.Session, key.Run).ConfigureAwait(false); }
            catch (Exception ex) { failures.Add(ex); }
        }
        if (failures.Count > 0) throw new AggregateException("one or more native runs did not stop cleanly", failures);
    }

    private sealed class Entry(RunStartRequest request)
    {
        public RunStartRequest Request { get; } = request;
        public TaskCompletionSource<IRunHost> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IRunHost? Host { get; set; }
        public TaskCompletionSource? StopCompletion { get; set; }
        public int FreezeSignaled;
    }
}

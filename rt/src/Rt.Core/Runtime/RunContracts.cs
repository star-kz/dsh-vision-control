namespace Rt.Core.Runtime;

public enum WorkerRunMode { Shadow = 0, Active = 1 }

public sealed record RunStartRequest(string SessionId, string RunId, WorkerRunMode Mode, string TargetId);

public interface IRunHost : IAsyncDisposable
{
    string SessionId { get; }
    string RunId { get; }
    string TargetId { get; }
    WorkerRunMode Mode { get; }
    void Freeze();
    void Heartbeat() { }
    object Status() => new { SessionId, RunId, TargetId, mode = Mode.ToString().ToLowerInvariant(), state = "running" };
    Task StopAsync();
}

public delegate Task<IRunHost> RunHostFactory(RunStartRequest request, CancellationToken cancellationToken);

public sealed class DuplicateRunException(string sessionId, string runId) :
    InvalidOperationException($"run '{sessionId}/{runId}' already exists")
{
    public string SessionId { get; } = sessionId;
    public string RunId { get; } = runId;
}

public sealed class ActiveTargetBusyException(string targetId) :
    InvalidOperationException($"active target '{targetId}' is already owned by another run")
{
    public string TargetId { get; } = targetId;
}

public sealed class RunNotFoundException(string sessionId, string runId) :
    InvalidOperationException($"run '{sessionId}/{runId}' was not found")
{
    public string SessionId { get; } = sessionId;
    public string RunId { get; } = runId;
}

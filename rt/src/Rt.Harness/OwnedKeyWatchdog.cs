using Rt.Core.Clocks;
using Rt.Core.Input;

namespace Rt.Harness;

/// <summary>Binary/source compatibility forwarder. The implementation lives in Rt.Core.Safety.</summary>
public sealed class OwnedKeyWatchdog : Rt.Core.Safety.OwnedKeyWatchdog
{
    public OwnedKeyWatchdog(IInputDispatcher dispatcher, IClock clock, string runId, long sourceEpoch)
        : base(dispatcher, clock, runId, sourceEpoch) { }
}

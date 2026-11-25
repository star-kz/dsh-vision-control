using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;
using Rt.Core.Safety;

namespace Rt.Windows.Input;

/// <summary>
/// Real keyboard dispatcher with conservative receipts. No exception or partial count is rewritten
/// as NotDispatched after the native boundary has been crossed.
/// </summary>
public sealed class SendInputDispatcher : IInputDispatcher
{
    private readonly ForegroundGate _gate;
    private readonly ISendInputNative _native;
    private readonly IClock _clock;
    private readonly IInputDispatchObserver? _observer;
    private readonly object _sync = new();
    private readonly List<SendInputCallFacts> _calls = new();
    private readonly List<InputReceipt> _receipts = new();
    private long _nextCallId;
    private int _flushCount;

    public SendInputDispatcher(
        DedicatedSynthTarget target,
        SafetyArbiter safety,
        IClock clock,
        IInputDispatchObserver? observer = null)
        : this(new ForegroundGate(target, safety, clock, new WindowsWindowFactsSource()),
            new Win32SendInputNative(), clock, observer)
    {
    }

    public SendInputDispatcher(
        ForegroundGate gate,
        ISendInputNative native,
        IClock clock,
        IInputDispatchObserver? observer = null)
    {
        _gate = gate ?? throw new ArgumentNullException(nameof(gate));
        _native = native ?? throw new ArgumentNullException(nameof(native));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
        _observer = observer;
    }

    public IReadOnlyList<SendInputCallFacts> Calls { get { lock (_sync) return _calls.ToArray(); } }
    public IReadOnlyList<InputReceipt> Receipts { get { lock (_sync) return _receipts.ToArray(); } }
    public int FlushCount { get { lock (_sync) return _flushCount; } }

    public IReadOnlyList<InputReceipt> DispatchBatch(IReadOnlyList<InputDispatchRequest> batch)
    {
        ArgumentNullException.ThrowIfNull(batch);
        if (batch.Count == 0) return Array.Empty<InputReceipt>();

        lock (_sync)
        {
            var call = new SendInputCallFacts
            {
                CallId = ++_nextCallId,
                BatchId = batch[0].BatchId,
                RequestedCount = batch.Count,
                BeforeQpc = _clock.Now,
            };
            var before = new List<GateVerdict>();
            string? failure = null;
            foreach (InputDispatchRequest request in batch)
            {
                IReadOnlyList<GateVerdict> verdicts = _gate.EvaluateAll(request);
                before.AddRange(verdicts);
                foreach (GateVerdict verdict in verdicts)
                {
                    if (failure is null && !verdict.Allowed)
                        failure = verdict.Gate + ": " + verdict.Reason;
                }
            }
            call.BeforeVerdicts = before.ToArray();

            SendInputFrame[] frames = Array.Empty<SendInputFrame>();
            if (failure is null)
            {
                try
                {
                    frames = batch.Select(request => KeyboardMapping.Resolve(request.Control, request.Phase)).ToArray();
                    call.Frames = frames;
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
                {
                    failure = ex.Message;
                }
            }

            if (failure is null)
            {
                try
                {
                    _observer?.BeforeSend(batch);
                }
                catch (Exception ex)
                {
                    failure = "pre-dispatch observer: " + ex.Message;
                }
            }

            if (failure is not null)
            {
                call.AfterQpc = _clock.Now;
                call.Error = failure;
                return Complete(batch, call, DispatchOutcome.NotDispatched, failure);
            }

            // Everything below this assignment has crossed the point of no safe non-dispatch claim.
            call.NativeInvoked = true;
            call.BeforeQpc = _clock.Now;
            bool nativeThrew = false;
            try
            {
                SendInputNativeResult result = _native.Send(frames);
                call.InsertedCount = result.InsertedCount;
                call.Win32Error = result.Win32Error;
                if (result.InsertedCount != batch.Count)
                    failure = $"SendInput inserted {result.InsertedCount} of {batch.Count}; every outcome is unknown";
                else if (result.Win32Error != 0)
                    failure = $"SendInput returned Win32 error {result.Win32Error} after insertion; outcome is unknown";
            }
            catch (Exception ex)
            {
                nativeThrew = true;
                call.TimedOut = ex is TimeoutException;
                failure = "SendInput threw after invocation: " + ex.Message;
            }
            finally
            {
                call.AfterQpc = _clock.Now;
            }

            var after = new List<GateVerdict>();
            foreach (InputDispatchRequest request in batch)
            {
                try
                {
                    after.AddRange(_gate.EvaluateAll(request));
                }
                catch (Exception ex)
                {
                    // Native input may already have been delivered. Observation failures cannot
                    // escape or turn this post-native receipt into a non-dispatch claim.
                    failure ??= "post-dispatch window observation: " + ex.Message;
                }
            }
            call.AfterVerdicts = after.ToArray();
            if (after.Any(v => !v.Allowed))
                failure ??= "target/safety facts changed during SendInput; every outcome is unknown";
            call.Error = failure;

            DispatchOutcome outcome = failure is null ? DispatchOutcome.Dispatched : DispatchOutcome.Unknown;
            InputReceipt[] receipts = CreateReceipts(batch, call.BeforeQpc, outcome, failure);
            try
            {
                _observer?.AfterSend(batch, receipts);
            }
            catch (Exception ex)
            {
                outcome = DispatchOutcome.Unknown;
                failure = (failure is null ? string.Empty : failure + "; ") +
                    "post-dispatch observer: " + ex.Message;
                call.Error = failure;
                receipts = CreateReceipts(batch, call.BeforeQpc, outcome, failure);
            }

            // nativeThrew is deliberately not used to infer non-delivery.
            _ = nativeThrew;
            return Store(receipts, call);
        }
    }

    public void Flush()
    {
        lock (_sync) _flushCount++;
    }

    private InputReceipt[] Complete(
        IReadOnlyList<InputDispatchRequest> batch,
        SendInputCallFacts call,
        DispatchOutcome outcome,
        string? error) => Store(CreateReceipts(batch, call.BeforeQpc, outcome, error), call);

    private InputReceipt[] Store(InputReceipt[] receipts, SendInputCallFacts call)
    {
        _calls.Add(call);
        _receipts.AddRange(receipts);
        return receipts;
    }

    private static InputReceipt[] CreateReceipts(
        IReadOnlyList<InputDispatchRequest> batch,
        long dispatchQpc,
        DispatchOutcome outcome,
        string? error) => batch.Select(request => new InputReceipt(
            request.RunId,
            request.ActionId,
            request.SourceEpoch,
            request.Control,
            request.ScheduledQpc,
            dispatchQpc,
            outcome,
            error)).ToArray();
}

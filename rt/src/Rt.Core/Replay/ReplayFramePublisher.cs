using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Frames;

namespace Rt.Core.Replay;

/// <summary>
/// Feeds an <see cref="IFrameSource"/> into a <see cref="FrameRing"/>, switching ring epochs when the
/// recorded source epoch changes. Pacing uses ONLY the injected <see cref="ISchedulableClock"/> — never
/// the wall clock — so a <see cref="VirtualClock"/> makes OriginalTimeline replay fully deterministic:
/// the same input replayed twice produces the same published sequence, epochs and timestamps.
/// </summary>
public sealed class ReplayFramePublisher
{
    private readonly FrameRing _ring;
    private readonly IFrameSource _source;
    private readonly ISchedulableClock _clock;
    private readonly ReplaySpeedMode _mode;

    public ReplayFramePublisher(FrameRing ring, IFrameSource source, ISchedulableClock clock, ReplaySpeedMode mode = ReplaySpeedMode.OriginalTimeline)
    {
        ArgumentNullException.ThrowIfNull(ring);
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(clock);
        if (!Enum.IsDefined(mode))
        {
            throw new ArgumentOutOfRangeException(nameof(mode), mode, "Unknown replay speed mode.");
        }
        _ring = ring;
        _source = source;
        _clock = clock;
        _mode = mode;
    }

    public async Task<ReplaySummary> RunAsync(CancellationToken cancellationToken = default)
    {
        long start = _clock.Now;
        int framesRead = 0;
        int published = 0;
        int dropped = 0;
        int epochChanges = 0;
        long firstSequence = 0;
        long lastSequence = 0;

        while (_source.TryGetNext(out ReplayFrame? frame))
        {
            cancellationToken.ThrowIfCancellationRequested();
            framesRead++;

            if (_mode == ReplaySpeedMode.OriginalTimeline)
            {
                long deadline = start + _clock.FromTimeSpan(frame.CaptureOffset);
                if (deadline > _clock.Now)
                {
                    await _clock.WaitUntilAsync(deadline, cancellationToken).ConfigureAwait(false);
                }
            }

            if (frame.SourceEpoch != _ring.SourceEpoch)
            {
                _ring.BeginEpoch(frame.SourceEpoch);
                epochChanges++;
            }

            long received = _clock.Now;
            if (_ring.TryPublish(frame.Payload, received, received, frame.Width, frame.Height, frame.Format, out FrameMeta meta))
            {
                published++;
                if (firstSequence == 0)
                {
                    firstSequence = meta.Sequence;
                }
                lastSequence = meta.Sequence;
            }
            else
            {
                dropped++;
            }
        }

        return new ReplaySummary(framesRead, published, dropped, epochChanges, firstSequence, lastSequence, start, _clock.Now);
    }
}

using System.Diagnostics.CodeAnalysis;

namespace Rt.Core.Replay;

/// <summary>In-memory <see cref="IFrameSource"/> over a fixed frame list, yielding frames in order.</summary>
public sealed class ReplayFrameSource : IFrameSource
{
    private readonly IReadOnlyList<ReplayFrame> _frames;
    private int _position;

    public ReplayFrameSource(IReadOnlyList<ReplayFrame> frames)
    {
        ArgumentNullException.ThrowIfNull(frames);
        _frames = frames;
    }

    public int FrameCount => _frames.Count;

    /// <summary>Number of frames already handed out.</summary>
    public int Position => Volatile.Read(ref _position);

    public bool TryGetNext([NotNullWhen(true)] out ReplayFrame? frame)
    {
        int pos = Volatile.Read(ref _position);
        if (pos >= _frames.Count)
        {
            frame = null;
            return false;
        }
        frame = _frames[pos];
        Volatile.Write(ref _position, pos + 1);
        return true;
    }
}

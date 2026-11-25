using System.Diagnostics.CodeAnalysis;

namespace Rt.Core.Replay;

/// <summary>Pull-based, single-consumer sequence of replay frames.</summary>
public interface IFrameSource
{
    int FrameCount { get; }

    bool TryGetNext([NotNullWhen(true)] out ReplayFrame? frame);
}

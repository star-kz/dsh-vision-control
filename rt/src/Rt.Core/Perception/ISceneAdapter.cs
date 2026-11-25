namespace Rt.Core.Perception;

/// <summary>Descriptor-driven deterministic detection. It never dispatches input.</summary>
public interface ISceneAdapter
{
    SceneDescriptor Descriptor { get; }
    IReadOnlyList<Detection> Detect(SceneFrame frame);
}

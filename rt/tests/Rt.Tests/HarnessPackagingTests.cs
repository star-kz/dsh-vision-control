using Rt.Harness;

namespace Rt.Tests;

internal static class HarnessPackagingTests
{
    [RtFact]
    public static void PublishedAndSourceSiblingLayouts()
    {
        string root = Path.Combine(Path.GetTempPath(), "rt-hil-layout-" + Guid.NewGuid().ToString("N"));
        try
        {
            const string framework = "net8.0-windows10.0.19041.0";
            string publishedBase = Path.Combine(root, "native", "win-x64", "harness");
            string publishedSynth = Path.Combine(root, "native", "win-x64", "synth", "Rt.SynthWindow.exe");
            Directory.CreateDirectory(publishedBase);
            Directory.CreateDirectory(Path.GetDirectoryName(publishedSynth)!);
            File.WriteAllText(publishedSynth, "test");
            string published = RealHilRunner.LocateSibling(publishedBase, "Rt.SynthWindow", "synth", "Rt.SynthWindow.exe");
            Assert.Equal(Path.GetFullPath(publishedSynth), Path.GetFullPath(published), "published Harness must find packaged synth");

            string sourceBase = Path.Combine(root, "src", "Rt.Harness", "bin", "Release", framework);
            string sourceSynth = Path.Combine(root, "src", "Rt.SynthWindow", "bin", "Release", framework, "Rt.SynthWindow.exe");
            Directory.CreateDirectory(sourceBase);
            Directory.CreateDirectory(Path.GetDirectoryName(sourceSynth)!);
            File.WriteAllText(sourceSynth, "test");
            string source = RealHilRunner.LocateSibling(sourceBase, "Rt.SynthWindow", "synth", "Rt.SynthWindow.exe");
            Assert.Equal(Path.GetFullPath(sourceSynth), Path.GetFullPath(source), "source Harness must keep finding source synth");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}

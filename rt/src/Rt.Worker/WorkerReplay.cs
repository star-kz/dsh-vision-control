using System.Security.Cryptography;
using Rt.Core.Clocks;
using Rt.Core.Tracing;

namespace Rt.Worker;

internal sealed record ReplayExecution(
    int PlanCount,
    int VirtualEvents,
    int Receipts,
    long FinalQpc,
    int GoldenBytes,
    string GoldenSha256);

internal static class WorkerReplay
{
    public static ReplayExecution Execute(string tracePath, string? goldenPath)
    {
        ArgumentException.ThrowIfNullOrEmpty(tracePath);
        string fullTrace = Path.GetFullPath(tracePath);
        if (goldenPath is not null &&
            string.Equals(fullTrace, Path.GetFullPath(goldenPath), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("golden output must not overwrite the input trace");

        GoldenReplayResult result = GoldenReplay.Run(fullTrace, new VirtualClock());
        if (goldenPath is not null)
        {
            string? parent = Path.GetDirectoryName(Path.GetFullPath(goldenPath));
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            File.WriteAllBytes(goldenPath, result.ActionPlanStream);
        }
        return new ReplayExecution(
            result.PlanCount,
            result.VirtualEvents.Count,
            result.Receipts.Count,
            result.FinalClock,
            result.ActionPlanStream.Length,
            Convert.ToHexString(SHA256.HashData(result.ActionPlanStream)).ToLowerInvariant());
    }

    public static void AssertEqual(string actualPath, string expectedPath)
    {
        byte[] actual = File.ReadAllBytes(actualPath);
        byte[] expected = File.ReadAllBytes(expectedPath);
        if (actual.AsSpan().SequenceEqual(expected)) return;
        int common = Math.Min(actual.Length, expected.Length);
        int firstDifference = 0;
        while (firstDifference < common && actual[firstDifference] == expected[firstDifference]) firstDifference++;
        throw new InvalidDataException(
            $"golden assertion failed: actual={actual.Length} bytes expected={expected.Length} bytes firstDifference={firstDifference}");
    }
}

internal sealed class WorkerException : Exception
{
    public WorkerException(string code, string message) : base(message) => Code = code;
    public string Code { get; }
}

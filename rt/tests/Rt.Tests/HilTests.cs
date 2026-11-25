using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Rt.Core.Clocks;
using Rt.Core.Contracts;
using Rt.Core.Input;

namespace Rt.Tests;

public static class HilTests
{
    private static readonly object BuildLock = new();
    private static string? _harnessPath;

    // The private test host compiles Core source into its own assembly. Harness uses the real
    // Core.dll, so proxies implement those external interfaces instead of mixing type identities.
    public class DispatcherProxy : DispatchProxy
    {
        public List<object> Requests { get; } = new();
        public int NextOutcome { get; set; } = 1;

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == "Flush") return null;
            object[] requests = ((System.Collections.IEnumerable)args![0]!).Cast<object>().ToArray();
            Requests.AddRange(requests);
            if (requests.Length == 0) return Array.CreateInstance(targetMethod!.ReturnType.GetElementType()!, 0);
            Type requestType = requests[0].GetType();
            Assembly core = requestType.Assembly;
            Type receiptType = core.GetType("Rt.Core.Contracts.InputReceipt", throwOnError: true)!;
            Type outcomeType = core.GetType("Rt.Core.Contracts.DispatchOutcome", throwOnError: true)!;
            Array receipts = Array.CreateInstance(receiptType, requests.Length);
            for (int i = 0; i < requests.Length; i++)
            {
                object r = requests[i];
                object? Value(string name) => requestType.GetProperty(name)!.GetValue(r);
                receipts.SetValue(Activator.CreateInstance(receiptType,
                    Value("RunId"), Value("ActionId"), Value("SourceEpoch"), Value("Control"),
                    Value("ScheduledQpc"), Value("DispatchQpc"), Enum.ToObject(outcomeType, NextOutcome),
                    NextOutcome == 1 ? null : "unknown"), i);
            }
            return receipts;
        }
    }

    public class ClockProxy : DispatchProxy
    {
        public IClock Target { get; set; } = null!;
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => targetMethod?.Name switch
        {
            "get_Frequency" => Target.Frequency,
            "get_Now" => Target.Now,
            "ToUnixTime" => Target.ToUnixTime((long)args![0]!),
            "FromUnixTime" => Target.FromUnixTime((DateTimeOffset)args![0]!),
            "ToTimeSpan" => Target.ToTimeSpan((long)args![0]!),
            "FromTimeSpan" => Target.FromTimeSpan((TimeSpan)args![0]!),
            _ => throw new NotSupportedException(targetMethod?.Name),
        };
    }

    private static string Root()
    {
        var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "rt", "src", "Rt.Core", "Rt.Core.csproj"))) return directory.FullName;
            directory = directory.Parent!;
        }
        throw new DirectoryNotFoundException("cannot locate realtime runtime repository root");
    }

    private static string HarnessPath()
    {
        if (_harnessPath is not null) return _harnessPath;
        lock (BuildLock)
        {
            if (_harnessPath is not null) return _harnessPath;
            string project = Path.Combine(Root(), "rt", "src", "Rt.Harness", "Rt.Harness.csproj");
            string output = Path.Combine(Path.GetTempPath(), "rt-task6-evidence", "hil-build.log");
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            var start = new ProcessStartInfo("dotnet", "build \"" + project + "\" -c Release --nologo")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using Process process = Process.Start(start) ?? throw new InvalidOperationException("dotnet build did not start");
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(120_000))
            {
                process.Kill(entireProcessTree: true);
                throw new TimeoutException("Rt.Harness build timed out");
            }
            File.WriteAllText(output, stdout + Environment.NewLine + stderr, Encoding.UTF8);
            Assert.Equal(0, process.ExitCode, "Rt.Harness must build; log: " + output);
            string dll = Path.Combine(Path.GetDirectoryName(project)!, "bin", "Release",
                "net8.0-windows10.0.19041.0", "Rt.Harness.dll");
            Assert.True(File.Exists(dll), "Rt.Harness executable assembly must exist: " + dll);
            return _harnessPath = dll;
        }
    }

    private static object Proxy(Type interfaceType, Type proxyType)
    {
        MethodInfo create = typeof(DispatchProxy).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method => method.Name == "Create" && method.IsGenericMethodDefinition &&
                method.GetGenericArguments().Length == 2);
        try
        {
            return create.MakeGenericMethod(interfaceType, proxyType).Invoke(null, null)!;
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            throw ex.InnerException;
        }
    }

    private static dynamic[] Watchdog(IClock clock)
    {
        Assembly assembly = Assembly.LoadFrom(HarnessPath());
        Type type = assembly.GetType("Rt.Harness.OwnedKeyWatchdog", throwOnError: true)!;
        ConstructorInfo constructor = type.GetConstructors().Single();
        var dispatcher = (DispatcherProxy)Proxy(constructor.GetParameters()[0].ParameterType, typeof(DispatcherProxy));
        var clockProxy = (ClockProxy)Proxy(constructor.GetParameters()[1].ParameterType, typeof(ClockProxy));
        clockProxy.Target = clock;
        dynamic watchdog = Activator.CreateInstance(type, dispatcher, clockProxy, "hil-unit", 7L)
            ?? throw new InvalidOperationException("watchdog construction returned null");
        return new[] { watchdog, dispatcher };
    }

    [RtFact]
    public static void Watchdog_ReleasesOnlyOwnedKeysAndRepeatedStopIsIdempotent()
    {
        var clock = new VirtualClock(1_000);
        dynamic[] setup = Watchdog(clock);
        dynamic watchdog = setup[0];
        DispatcherProxy dispatcher = (DispatcherProxy)setup[1];
        watchdog.Register("key.a");
        watchdog.Register("key.s");
        watchdog.MarkReleased("key.s");
        watchdog.ReleaseAll();
        watchdog.ReleaseAll();
        watchdog.Stop();
        watchdog.Stop();

        dynamic release = dispatcher.Requests.Single();
        Assert.Equal("key.a", (string)release.Control, "only the still-owned key is released");
        Assert.Equal("Up", release.Phase.ToString(), "watchdog emits key-up only");
        Assert.True((bool)release.Forced, "watchdog release bypasses stale heartbeat but not the live gate");
        Assert.Equal(1, (int)watchdog.ReleaseAttemptCount, "duplicate stop/release does not duplicate a successful release");
        Assert.Equal(0, ((IEnumerable<string>)watchdog.OwnedControls).Count(), "successful release clears ownership");
    }

    [RtFact]
    public static void Watchdog_HeartbeatLossAndUnknownOutcomeRemainConservative()
    {
        var clock = new VirtualClock(2_000);
        dynamic[] setup = Watchdog(clock);
        dynamic watchdog = setup[0];
        DispatcherProxy dispatcher = (DispatcherProxy)setup[1];
        dispatcher.NextOutcome = 2;
        watchdog.Register("key.d");
        watchdog.OnHeartbeatLost();
        Assert.Equal(1, dispatcher.Requests.Count, "heartbeat loss triggers an independent release attempt");
        Assert.Equal(2, dispatcher.NextOutcome, "test boundary is explicitly unknown");
        Assert.True(((IEnumerable<string>)watchdog.OwnedControls).Contains("key.d"),
            "unknown key-up never clears ownership");

        dispatcher.NextOutcome = 1;
        watchdog.ReleaseAll();
        Assert.Equal(2, dispatcher.Requests.Count, "retained ownership permits an explicit retry");
        Assert.Equal(0, ((IEnumerable<string>)watchdog.OwnedControls).Count(), "confirmed retry clears ownership");
    }

    [RtFact]
    public static void Reconciliation_ReportsThreeWayEarlyLateMissDupAndQuantiles()
    {
        string directory = Path.Combine(Path.GetTempPath(), "rt-task6-evidence", "reconcile-unit");
        Directory.CreateDirectory(directory);
        string ground = Path.Combine(directory, "ground.jsonl");
        string trace = Path.Combine(directory, "trace.jsonl");
        string window = Path.Combine(directory, "window.jsonl");
        string output = Path.Combine(directory, "report.json");
        const long f = 10_000_000;
        var groundRows = new[]
        {
            new { actionId = "a1", control = "key.a", phase = "Down", scheduledQpc = f },
            new { actionId = "a2", control = "key.s", phase = "Down", scheduledQpc = 2 * f },
            new { actionId = "a3", control = "key.d", phase = "Down", scheduledQpc = 3 * f },
            new { actionId = "a4", control = "key.f", phase = "Down", scheduledQpc = 4 * f },
        };
        var traceRows = groundRows.Select((g, i) => new
        {
            g.actionId, g.control, g.phase, g.scheduledQpc,
            dispatchQpc = g.scheduledQpc,
            outcome = i == 2 ? "NotDispatched" : "Dispatched",
        });
        var windowRows = new[]
        {
            new { actionId = "a1", control = "key.a", phase = "Down", qpc = f - 1_000_000 },
            new { actionId = "a2", control = "key.s", phase = "Down", qpc = 2 * f + 2_000_000 },
            new { actionId = "a2", control = "key.s", phase = "Down", qpc = 2 * f + 2_100_000 },
            new { actionId = "a4", control = "key.f", phase = "Down", qpc = 4 * f + 4_000_000 },
            new { actionId = "orphan", control = "key.j", phase = "Down", qpc = 5 * f },
        };
        WriteJsonl(ground, groundRows);
        WriteJsonl(trace, traceRows);
        WriteJsonl(window, windowRows);

        string dll = HarnessPath();
        var start = new ProcessStartInfo("dotnet", "\"" + dll + "\" reconcile --frequency " + f +
            " --ground-truth \"" + ground + "\" --trace \"" + trace + "\" --window \"" + window + "\" --output \"" + output + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using Process process = Process.Start(start) ?? throw new InvalidOperationException("reconciler did not start");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(30_000)) { process.Kill(true); throw new TimeoutException("reconciler timed out"); }
        Assert.True(process.ExitCode == 0, "reconcile command failed: " + stdout + stderr);
        using JsonDocument report = JsonDocument.Parse(File.ReadAllText(output));
        JsonElement root = report.RootElement;
        Assert.Equal(1, root.GetProperty("early").GetInt32(), "one early window arrival");
        Assert.Equal(2, root.GetProperty("late").GetInt32(), "two late window arrivals");
        Assert.Equal(1, root.GetProperty("miss").GetInt32(), "one ground-truth event has no window arrival");
        Assert.Equal(1, root.GetProperty("dup").GetInt32(), "one duplicate window arrival");
        Assert.Equal(1, root.GetProperty("orphanWindowEvents").GetInt32(), "unmatched window events remain visible");
        Assert.Equal(200.0, root.GetProperty("latencyMs").GetProperty("p50").GetDouble(), "P50 signed latency");
        Assert.Equal(400.0, root.GetProperty("latencyMs").GetProperty("p95").GetDouble(), "P95 signed latency");
        Assert.Equal(400.0, root.GetProperty("latencyMs").GetProperty("p99").GetDouble(), "P99 signed latency");
    }

    private static void WriteJsonl<T>(string path, IEnumerable<T> rows) =>
        File.WriteAllText(path, string.Join(Environment.NewLine,
            rows.Select(row => JsonSerializer.Serialize(row))) + Environment.NewLine, Encoding.UTF8);
}

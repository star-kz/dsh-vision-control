using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Rt.Core.Contracts;
using Rt.Core.Safety;
using Rt.Core.Scheduling;
using Rt.Windows;
using Rt.Windows.Input;

namespace Rt.Harness;

public static class RealHilRunner
{
    private const long Epoch = 7;
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static int Run(string scenario, string outputDir)
    {
        if (scenario.Equals("all", StringComparison.Ordinal))
        {
            foreach (string name in new[] { "standard", "focus-theft", "heartbeat", "kill", "repeat-stop" })
                Run(name, Path.Combine(outputDir, name));
            return 0;
        }
        if (scenario is not ("standard" or "focus-theft" or "heartbeat" or "kill" or "repeat-stop"))
            throw new ArgumentException("unknown real HIL scenario: " + scenario);
        Directory.CreateDirectory(outputDir);
        using var clock = new QpcClock();
        long start = clock.Now + Ms(clock, 15_000);
        List<HilAction> actions = BuildSchedule(scenario, start, clock.Frequency);
        string schedule = Path.Combine(outputDir, "schedule.json");
        File.WriteAllText(schedule, JsonSerializer.Serialize(new { actions }, JsonOptions));
        string title = DedicatedSynthTarget.RequiredTitleMagic + "|" + scenario + "|" + Guid.NewGuid().ToString("N");
        using WindowProcess primary = StartWindow(outputDir, "primary", title, schedule);
        return scenario == "kill"
            ? RunKill(outputDir, primary, schedule, actions, start)
            : RunInteractive(scenario, outputDir, primary, actions, start);
    }

    private static int RunInteractive(string scenario, string outputDir, WindowProcess primary,
        List<HilAction> actions, long start)
    {
        WindowProcess? decoy = null;
        Scheduler? scheduler = null;
        OwnedKeyWatchdog? watchdog = null;
        var flags = new JsonObject
        {
            ["realSendInput"] = true,
            ["mockInput"] = false,
            ["scenario"] = scenario,
            ["repeatStopCompleted"] = false,
            ["heartbeatLost"] = false,
            ["focusTheftExecuted"] = false,
        };
        try
        {
            using var clock = new QpcClock();
            Activate(primary);
            if (scenario == "focus-theft")
            {
                string decoyTitle = "RT-SYNTH-HIL-DECOY-9D27C4|" + Guid.NewGuid().ToString("N");
                decoy = StartWindow(outputDir, "decoy", decoyTitle, null);
            }
            var safety = new SafetyArbiter(clock);
            string runId = "hil-" + scenario + "-" + Guid.NewGuid().ToString("N");
            SafetySnapshot snapshot = AuthorizedSnapshot(clock, primary.Ready, runId,
                actions.Select(a => a.Control).Distinct().ToArray());
            safety.Update(snapshot);
            string tracePath = Path.Combine(outputDir, "trace.jsonl");
            string ownershipPath = Path.Combine(outputDir, "ownership.jsonl");
            var observer = new HilObserver(tracePath, ownershipPath);
            var target = Target(primary.Ready);
            var dispatcher = new SendInputDispatcher(target, safety, clock, observer);
            watchdog = new OwnedKeyWatchdog(dispatcher, clock, runId + "-watchdog", Epoch);
            observer.Watchdog = watchdog;
            scheduler = new Scheduler(clock, safety, dispatcher, runId, Ms(clock, 3000));
            ScheduleAll(scheduler, actions, primary.Ready.Title);
            flags["runId"] = runId;
            flags["targetPid"] = primary.Process.Id;
            flags["targetHwnd"] = primary.Ready.Hwnd.ToInt64();

            if (scenario == "focus-theft")
            {
                Wait(clock, start + Ms(clock, 120));
                Activate(decoy!);
                flags["focusTheftExecuted"] = true;
                flags["focusStolenQpc"] = clock.Now;
                Wait(clock, start + Ms(clock, 450));
                Activate(primary);
                flags["focusRestoredQpc"] = clock.Now;
            }
            else if (scenario == "heartbeat")
            {
                Wait(clock, start + Ms(clock, 150));
                safety.Update(snapshot with { HeartbeatValid = false });
                flags["heartbeatLost"] = true;
                flags["heartbeatLostQpc"] = clock.Now;
                watchdog.OnHeartbeatLost();
            }
            else if (scenario == "repeat-stop")
            {
                Wait(clock, start + Ms(clock, 150));
                scheduler.Stop();
                scheduler.Stop();
                watchdog.Stop();
                watchdog.Stop();
                flags["repeatStopCompleted"] = true;
                flags["stopQpc"] = clock.Now;
            }

            WaitForCompletion(scheduler, clock, 30_000);
            scheduler.Stop();
            scheduler.Stop();
            watchdog.Stop();
            watchdog.Stop();
            flags["repeatStopCompleted"] = true;
            flags["watchdogReleaseAttempts"] = watchdog.ReleaseAttemptCount;
            flags["watchdogOwnedAtEnd"] = watchdog.OwnedControls.Count;
            flags["nativeCallCount"] = dispatcher.Calls.Count;
            File.WriteAllText(Path.Combine(outputDir, "calls.json"), JsonSerializer.Serialize(dispatcher.Calls, JsonOptions));
            File.WriteAllText(Path.Combine(outputDir, "receipts.json"), JsonSerializer.Serialize(dispatcher.Receipts, JsonOptions));
            File.WriteAllText(Path.Combine(outputDir, "scheduler-receipts.json"), JsonSerializer.Serialize(scheduler.Receipts, JsonOptions));
            File.WriteAllText(Path.Combine(outputDir, "scheduler-gates.json"), JsonSerializer.Serialize(scheduler.GateVerdicts, JsonOptions));
        }
        finally
        {
            scheduler?.Stop();
            watchdog?.Stop();
            decoy?.Dispose();
        }
        primary.Dispose();
        Reconciler.Reconcile(Path.Combine(outputDir, "primary-ground-truth.jsonl"),
            Path.Combine(outputDir, "trace.jsonl"), Path.Combine(outputDir, "primary-window.jsonl"),
            Path.Combine(outputDir, "reconciliation.json"), 10_000_000);
        ValidateInteractive(scenario, outputDir, flags);
        File.WriteAllText(Path.Combine(outputDir, "scenario.json"), flags.ToJsonString(JsonOptions));
        Console.WriteLine("REAL HIL " + scenario + ": " + Path.Combine(outputDir, "scenario.json"));
        return 0;
    }

    private static void ValidateInteractive(string scenario, string outputDir, JsonObject flags)
    {
        using JsonDocument report = JsonDocument.Parse(File.ReadAllText(Path.Combine(outputDir, "reconciliation.json")));
        JsonElement root = report.RootElement;
        flags["matched"] = root.GetProperty("matched").GetInt32();
        flags["early"] = root.GetProperty("early").GetInt32();
        flags["late"] = root.GetProperty("late").GetInt32();
        flags["miss"] = root.GetProperty("miss").GetInt32();
        flags["dup"] = root.GetProperty("dup").GetInt32();
        flags["traceUnknown"] = root.GetProperty("traceUnknown").GetInt32();
        flags["traceNotDispatched"] = root.GetProperty("traceNotDispatched").GetInt32();
        flags["decoyWindowEvents"] = 0;
        if (root.GetProperty("traceUnknown").GetInt32() != 0)
            throw new InvalidOperationException("real HIL produced unknown receipts; inspect calls.json before claiming success");
        if (scenario == "standard" && root.GetProperty("matched").GetInt32() < root.GetProperty("totalGroundTruth").GetInt32() * 4 / 5)
            throw new InvalidOperationException("standard real HIL matched fewer than 80% of ground-truth events");
        if (scenario == "focus-theft")
        {
            string decoyLog = Path.Combine(outputDir, "decoy-window.jsonl");
            int decoyEvents = File.Exists(decoyLog) ? ReadLinesShared(decoyLog).Count(line => line.Contains("\"phase\"", StringComparison.Ordinal)) : 0;
            flags["decoyWindowEvents"] = decoyEvents;
            if (decoyEvents != 0) throw new InvalidOperationException("focus-theft decoy received keyboard input");
            bool denied = ReadLinesShared(Path.Combine(outputDir, "trace.jsonl")).Any(line =>
                line.Contains("stolen-tap", StringComparison.Ordinal) && line.Contains("NotDispatched", StringComparison.Ordinal));
            flags["stolenTapDenied"] = denied;
            if (!denied) throw new InvalidOperationException("stolen-focus tap was not conservatively denied");
        }
        if (scenario == "heartbeat")
        {
            bool release = ReadLinesShared(Path.Combine(outputDir, "trace.jsonl")).Any(line =>
                line.Contains("watchdog-", StringComparison.Ordinal) && line.Contains("Dispatched", StringComparison.Ordinal));
            flags["heartbeatWatchdogReleaseDispatched"] = release;
            if (!release) throw new InvalidOperationException("heartbeat loss did not produce a confirmed independent release");
        }
        flags["validated"] = true;
    }

    public static int RunWorker(string readyFile, string scheduleFile, string outputDir, string ownershipFile, string heartbeatFile)
    {
        Directory.CreateDirectory(outputDir);
        ReadyWindow ready = ReadReady(readyFile);
        using var clock = new QpcClock();
        var safety = new SafetyArbiter(clock);
        string runId = "hil-kill-worker-" + Guid.NewGuid().ToString("N");
        List<HilAction> actions = ReadSchedule(scheduleFile);
        safety.Update(AuthorizedSnapshot(clock, ready, runId, actions.Select(a => a.Control).Distinct().ToArray()));
        var observer = new HilObserver(Path.Combine(outputDir, "worker-trace.jsonl"), ownershipFile);
        var dispatcher = new SendInputDispatcher(Target(ready), safety, clock, observer);
        using var scheduler = new Scheduler(clock, safety, dispatcher, runId, Ms(clock, 3000));
        ScheduleAll(scheduler, actions, ready.Title);
        File.WriteAllText(Path.Combine(outputDir, "worker-ready.json"), JsonSerializer.Serialize(new { pid = Environment.ProcessId, runId }, JsonOptions));
        long deadline = clock.Now + Ms(clock, 30_000);
        while (scheduler.PendingCount > 0 && clock.Now < deadline)
        {
            AppendJsonLine(heartbeatFile, new { qpc = clock.Now, pid = Environment.ProcessId });
            Thread.Sleep(10);
        }
        scheduler.Stop();
        scheduler.Stop();
        File.WriteAllText(Path.Combine(outputDir, "worker-receipts.json"), JsonSerializer.Serialize(scheduler.Receipts, JsonOptions));
        File.WriteAllText(Path.Combine(outputDir, "worker-calls.json"), JsonSerializer.Serialize(dispatcher.Calls, JsonOptions));
        return 0;
    }

    private static int RunKill(string outputDir, WindowProcess primary, string schedule,
        List<HilAction> actions, long start)
    {
        string workerDir = Path.Combine(outputDir, "worker");
        Directory.CreateDirectory(workerDir);
        string ownership = Path.Combine(outputDir, "ownership.jsonl");
        string heartbeat = Path.Combine(outputDir, "heartbeat.jsonl");
        string parentTrace = Path.Combine(outputDir, "parent-trace.jsonl");
        var startInfo = new ProcessStartInfo(LocateHarness(),
            "worker --ready-file \"" + ReadyPath(outputDir, "primary") + "\" --schedule \"" + schedule +
            "\" --output-dir \"" + workerDir + "\" --ownership-file \"" + ownership + "\" --heartbeat-file \"" + heartbeat + "\"")
        { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        using var worker = Process.Start(startInfo) ?? throw new InvalidOperationException("failed to start real worker");
        var flags = new JsonObject { ["realSendInput"] = true, ["mockInput"] = false, ["scenario"] = "kill",
            ["workerPid"] = worker.Id, ["independentParentWatchdog"] = true };
        using var clock = new QpcClock();
        var safety = new SafetyArbiter(clock);
        string parentRun = "hil-kill-parent-" + Guid.NewGuid().ToString("N");
        safety.Update(AuthorizedSnapshot(clock, primary.Ready, parentRun, actions.Select(a => a.Control).Distinct().ToArray()));
        var observer = new HilObserver(parentTrace, null);
        var dispatcher = new SendInputDispatcher(Target(primary.Ready), safety, clock, observer);
        var watchdog = new OwnedKeyWatchdog(dispatcher, clock, parentRun, Epoch);
        observer.Watchdog = watchdog;
        watchdog.Start(() => HeartbeatFresh(heartbeat, clock), TimeSpan.FromMilliseconds(10));
        try
        {
            Activate(primary);
            long deadline = clock.Now + Ms(clock, 8000);
            int consumed = 0;
            bool downObserved = false;
            while (clock.Now < deadline && !downObserved)
            {
                consumed = ConsumeOwnership(ownership, consumed, watchdog);
                downObserved = watchdog.OwnedControls.Count > 0 &&
                    ReadLinesShared(Path.Combine(outputDir, "primary-window.jsonl")).Any(line => line.Contains("\"Down\"", StringComparison.Ordinal));
                Thread.Sleep(5);
            }
            if (!downObserved) throw new InvalidOperationException("worker never produced a real owned key-down");
            flags["killQpc"] = clock.Now;
            worker.Kill(entireProcessTree: true);
            worker.WaitForExit(5000);
            flags["workerKilled"] = worker.HasExited;
            deadline = clock.Now + Ms(clock, 3000);
            while (clock.Now < deadline && watchdog.OwnedControls.Count > 0)
            {
                consumed = ConsumeOwnership(ownership, consumed, watchdog);
                Thread.Sleep(5);
            }
            watchdog.Stop();
            watchdog.Stop();
            flags["watchdogReleaseAttempts"] = watchdog.ReleaseAttemptCount;
            flags["watchdogOwnedAtEnd"] = watchdog.OwnedControls.Count;
            flags["nativeCallCount"] = dispatcher.Calls.Count;
            File.WriteAllText(Path.Combine(outputDir, "parent-calls.json"), JsonSerializer.Serialize(dispatcher.Calls, JsonOptions));
        }
        finally
        {
            watchdog.Stop();
            if (!worker.HasExited) worker.Kill(true);
        }
        primary.Dispose();
        string workerTrace = Path.Combine(workerDir, "worker-trace.jsonl");
        File.WriteAllText(Path.Combine(outputDir, "trace.jsonl"), string.Join(Environment.NewLine,
            new[] { workerTrace, parentTrace }.Where(File.Exists).SelectMany(ReadLinesShared)) + Environment.NewLine);
        Reconciler.Reconcile(Path.Combine(outputDir, "primary-ground-truth.jsonl"),
            Path.Combine(outputDir, "trace.jsonl"), Path.Combine(outputDir, "primary-window.jsonl"),
            Path.Combine(outputDir, "reconciliation.json"), 10_000_000);
        bool parentRelease = File.Exists(parentTrace) && ReadLinesShared(parentTrace).Any(line =>
            line.Contains("watchdog-", StringComparison.Ordinal) && line.Contains("Dispatched", StringComparison.Ordinal));
        bool windowUp = ReadLinesShared(Path.Combine(outputDir, "primary-window.jsonl")).Any(line => line.Contains("\"Up\"", StringComparison.Ordinal));
        flags["parentWatchdogReleaseDispatched"] = parentRelease;
        flags["windowObservedRelease"] = windowUp;
        flags["validated"] = parentRelease && windowUp && watchdog.OwnedControls.Count == 0;
        File.WriteAllText(Path.Combine(outputDir, "scenario.json"), flags.ToJsonString(JsonOptions));
        if (!flags["validated"]!.GetValue<bool>()) throw new InvalidOperationException("worker kill did not reconcile to an independent confirmed release");
        Console.WriteLine("REAL HIL kill: " + Path.Combine(outputDir, "scenario.json"));
        return 0;
    }

    private static int ConsumeOwnership(string path, int consumed, OwnedKeyWatchdog watchdog)
    {
        if (!File.Exists(path)) return consumed;
        string[] lines = ReadLinesShared(path).Where(x => !string.IsNullOrWhiteSpace(x)).ToArray();
        for (; consumed < lines.Length; consumed++)
        {
            using JsonDocument row = JsonDocument.Parse(lines[consumed]);
            JsonElement root = row.RootElement;
            string control = root.GetProperty("control").GetString()!;
            string phase = root.GetProperty("phase").GetString()!;
            string outcome = root.GetProperty("outcome").GetString()!;
            if (phase == "Down" && outcome != "NotDispatched") watchdog.Register(control);
            if (phase == "Up" && outcome == "Dispatched") watchdog.MarkReleased(control);
        }
        return consumed;
    }

    private static bool HeartbeatFresh(string path, QpcClock clock)
    {
        if (!File.Exists(path)) return false;
        string? last = ReadLinesShared(path).LastOrDefault(line => !string.IsNullOrWhiteSpace(line));
        if (last is null) return false;
        using JsonDocument row = JsonDocument.Parse(last);
        return clock.Now - row.RootElement.GetProperty("qpc").GetInt64() <= Ms(clock, 150);
    }

    private static List<HilAction> BuildSchedule(string scenario, long start, long frequency)
    {
        var actions = new List<HilAction>();
        string[] lanes = { "key.a", "key.s", "key.d", "key.f", "key.j", "key.k" };
        long T(double ms) => start + (long)(ms * frequency / 1000);
        if (scenario == "standard")
        {
            for (int i = 0; i < 16; i++) actions.Add(new HilAction("rapid-" + i, lanes[i % 4], T(i * 70), T(i * 70 + 12), T(i * 70 + 100)));
            for (int i = 0; i < 4; i++) actions.Add(new HilAction("chord-" + i, lanes[i], T(1400), T(1500 + i * 10), T(1500)));
            actions.Add(new HilAction("long-hold", "key.j", T(2100), T(2850), T(2200)));
        }
        else if (scenario == "focus-theft")
        {
            actions.Add(new HilAction("focus-hold", "key.a", T(0), T(900), T(100)));
            actions.Add(new HilAction("stolen-tap", "key.s", T(250), T(280), T(350)));
            actions.Add(new HilAction("restored-tap", "key.d", T(600), T(620), T(700)));
        }
        else if (scenario == "heartbeat")
        {
            actions.Add(new HilAction("heartbeat-hold", "key.a", T(0), T(900), T(100)));
            actions.Add(new HilAction("heartbeat-denied", "key.s", T(400), T(420), T(500)));
        }
        else if (scenario == "kill")
            actions.Add(new HilAction("kill-hold", "key.a", T(0), T(2000), T(100)));
        else
        {
            actions.Add(new HilAction("stop-hold", "key.a", T(0), T(1000), T(100)));
            actions.Add(new HilAction("stop-cancelled", "key.s", T(400), T(420), T(500)));
        }
        return actions;
    }

    private static void ScheduleAll(Scheduler scheduler, IReadOnlyList<HilAction> actions, string target)
    {
        foreach (HilAction action in actions)
        {
            var spec = new InputEventSpec(action.Control, action.DownQpc, action.UpQpc, action.LatestQpc);
            var plan = new ActionPlan(action.ActionId, Epoch, target, action.DownQpc - 1,
                action.UpQpc + 10_000_000, new[] { spec });
            if (!scheduler.TrySchedule(plan)) throw new InvalidOperationException("scheduler rejected " + action.ActionId);
        }
    }

    private static List<HilAction> ReadSchedule(string path)
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty("actions").EnumerateArray().Select(a => new HilAction(
            a.GetProperty("actionId").GetString()!, a.GetProperty("control").GetString()!,
            a.GetProperty("downQpc").GetInt64(), a.GetProperty("upQpc").GetInt64(), a.GetProperty("latestQpc").GetInt64())).ToList();
    }

    private static SafetySnapshot AuthorizedSnapshot(QpcClock clock, ReadyWindow ready, string runId, IReadOnlyList<string> controls) =>
        new(runId, ready.Title, Epoch)
        {
            Authorized = true, Active = true, Focused = true, HeartbeatValid = true,
            AuthorizationExpiresQpc = clock.Now + Ms(clock, 60_000), AllowedControls = controls,
            Bounds = new CoordinateBounds(ready.Left, ready.Top, ready.Width, ready.Height),
        };

    private static DedicatedSynthTarget Target(ReadyWindow ready) => new(ready.Hwnd, ready.Pid, ready.Title);

    private static WindowProcess StartWindow(string output, string role, string title, string? schedule)
    {
        string args = "--output-dir \"" + output + "\" --role " + role + " --title \"" + title + "\"";
        if (schedule is not null) args += " --schedule \"" + schedule + "\"";
        var process = Process.Start(new ProcessStartInfo(LocateSynth(), args) { UseShellExecute = false })
            ?? throw new InvalidOperationException("failed to start dedicated synth window");
        string readyPath = ReadyPath(output, role);
        long deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 10;
        while (Stopwatch.GetTimestamp() < deadline)
        {
            if (process.HasExited) throw new InvalidOperationException("synth window exited before ready, code " + process.ExitCode);
            if (File.Exists(readyPath))
            {
                ReadyWindow ready = ReadReady(readyPath);
                if (ready.Pid == process.Id && ready.Title == title) return new WindowProcess(process, ready);
            }
            Thread.Sleep(20);
        }
        process.Kill(true);
        throw new TimeoutException("dedicated synth window did not publish ready facts");
    }

    private static void Activate(WindowProcess window)
    {
        if (window.Process.HasExited) throw new InvalidOperationException("cannot activate an exited self-built window");
        WindowFacts current = new WindowsWindowFactsSource().ReadWindow(window.Ready.Hwnd);
        if (current.ProcessId != window.Process.Id || current.Title != window.Ready.Title ||
            current.ProcessName != DedicatedSynthTarget.RequiredProcessName)
            throw new InvalidOperationException("refusing activation: live target identity changed");
        if (IsIconic(window.Ready.Hwnd)) ShowWindow(window.Ready.Hwnd, 9);
        bool foregroundRequested = SetForegroundWindow(window.Ready.Hwnd);
        if (!foregroundRequested)
        {
            uint currentThread = GetCurrentThreadId();
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out _);
            bool attached = false;
            try
            {
                // Temporarily share input state only to activate the verified dedicated HWND.
                // No keyboard message is sent to the current foreground application.
                attached = foregroundThread != 0 && foregroundThread != currentThread &&
                    AttachThreadInput(currentThread, foregroundThread, true);
                BringWindowToTop(window.Ready.Hwnd);
                foregroundRequested = SetForegroundWindow(window.Ready.Hwnd);
                if (!foregroundRequested) SwitchToThisWindow(window.Ready.Hwnd, true);
            }
            finally
            {
                if (attached) AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
        // Ask the verified target's own UI thread to perform foreground activation.
        // This is a private message to one HWND, not global input or a broadcast.
        bool selfActivationMessageSent = SendMessageTimeout(window.Ready.Hwnd, 0x8000 + 0x4a,
            0, 0, 0x0003, 1000, out nuint selfActivationResult) != 0;
        var source = new WindowsWindowFactsSource();
        int activationWaitMs = 2000;
        if (int.TryParse(Environment.GetEnvironmentVariable("RT_HIL_ACTIVATION_WAIT_MS"), out int configuredWait))
            activationWaitMs = Math.Clamp(configuredWait, 2000, 120000);
        long deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * activationWaitMs / 1000;
        while (Stopwatch.GetTimestamp() < deadline)
        {
            WindowFacts foreground = source.ReadForeground();
            if (foreground.Hwnd == window.Ready.Hwnd && foreground.ProcessId == window.Process.Id &&
                foreground.Title == window.Ready.Title) return;
            Thread.Sleep(10);
        }
        WindowFacts refused = source.ReadForeground();
        throw new InvalidOperationException($"Windows refused foreground activation of the dedicated HIL window; SetForegroundWindow={foregroundRequested}, selfActivationMessageSent={selfActivationMessageSent}, selfActivationResult={selfActivationResult}, actualForegroundHwnd=0x{refused.Hwnd.ToInt64():x}; real HIL is blocked rather than sending blindly");
    }

    private static void Wait(QpcClock clock, long deadline)
    {
        if (deadline > clock.Now) clock.WaitUntilAsync(deadline).AsTask().GetAwaiter().GetResult();
    }

    private static void WaitForCompletion(Scheduler scheduler, QpcClock clock, int timeoutMs)
    {
        long deadline = clock.Now + Ms(clock, timeoutMs);
        while (scheduler.PendingCount > 0 && clock.Now < deadline) Thread.Sleep(5);
        if (scheduler.PendingCount != 0) throw new TimeoutException("scheduler did not drain; stopping to release owned keys");
    }

    private static ReadyWindow ReadReady(string path)
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement r = doc.RootElement;
        JsonElement b = r.GetProperty("bounds");
        return new ReadyWindow((nint)r.GetProperty("hwnd").GetInt64(), r.GetProperty("pid").GetInt32(),
            r.GetProperty("title").GetString()!, b.GetProperty("left").GetInt32(), b.GetProperty("top").GetInt32(),
            b.GetProperty("width").GetInt32(), b.GetProperty("height").GetInt32());
    }

    private static string LocateSynth() => LocateSibling(AppContext.BaseDirectory, "Rt.SynthWindow", "synth", "Rt.SynthWindow.exe");
    private static string LocateHarness() => Path.Combine(AppContext.BaseDirectory, "Rt.Harness.exe");

    internal static string LocateSibling(string baseDirectory, string project, string publishedDirectory, string executable)
    {
        string published = Path.GetFullPath(Path.Combine(baseDirectory, "..", publishedDirectory, executable));
        if (File.Exists(published)) return published;

        var dir = new DirectoryInfo(baseDirectory);
        while (dir is not null && dir.Name != "Rt.Harness") dir = dir.Parent!;
        if (dir?.Parent is not null)
        {
            string framework = Path.GetFileName(baseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            string source = Path.Combine(dir.Parent.FullName, project, "bin", "Release", framework, executable);
            if (File.Exists(source)) return source;
        }
        throw new FileNotFoundException("build or publish the dedicated executable before real HIL", published);
    }

    private static string ReadyPath(string output, string role) => Path.Combine(output, role + "-ready.json");
    private static long Ms(QpcClock clock, double ms) => (long)(ms * clock.Frequency / 1000);
    internal static void AppendJsonLine<T>(string path, T row)
    {
        using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        using var writer = new StreamWriter(stream);
        writer.WriteLine(JsonSerializer.Serialize(row));
    }
    internal static string[] ReadLinesShared(string path)
    {
        if (!File.Exists(path)) return Array.Empty<string>();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        string text = reader.ReadToEnd();
        return text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
    }

    private sealed record HilAction(string ActionId, string Control, long DownQpc, long UpQpc, long LatestQpc);
    private sealed record ReadyWindow(nint Hwnd, int Pid, string Title, int Left, int Top, int Width, int Height);
    private sealed class WindowProcess : IDisposable
    {
        private bool _disposed;
        public WindowProcess(Process process, ReadyWindow ready) { Process = process; Ready = ready; }
        public Process Process { get; }
        public ReadyWindow Ready { get; }
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (!Process.HasExited)
            {
                Process.CloseMainWindow();
                if (!Process.WaitForExit(3000)) Process.Kill(true);
            }
            Process.Dispose();
        }
    }

    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool attach);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool BringWindowToTop(nint hwnd);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(nint hwnd, [MarshalAs(UnmanagedType.Bool)] bool altTab);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SendMessageTimeout(nint hwnd, uint message, nuint wParam, nint lParam, uint flags, uint timeoutMs, out nuint result);
}

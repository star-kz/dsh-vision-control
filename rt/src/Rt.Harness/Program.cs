using System.Globalization;
using System.Text.Json;
using Rt.Windows.Input;

namespace Rt.Harness;

public static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("REFUSED: real input is inert unless an explicit HIL command is supplied.");
            return 2;
        }
        try
        {
            if (args[0].Equals("reconcile", StringComparison.Ordinal))
            {
                Dictionary<string, string> options = Options(args);
                Reconciler.Reconcile(
                    Required(options, "ground-truth"), Required(options, "trace"), Required(options, "window"),
                    Required(options, "output"), long.Parse(Required(options, "frequency"), CultureInfo.InvariantCulture));
                return 0;
            }
            if (args[0].Equals("verify-target", StringComparison.Ordinal))
            {
                Dictionary<string, string> options = Options(args);
                nint hwnd = checked((nint)long.Parse(Required(options, "hwnd"), CultureInfo.InvariantCulture));
                int processId = int.Parse(Required(options, "process-id"), CultureInfo.InvariantCulture);
                var requested = new DedicatedSynthTarget(hwnd, processId, Required(options, "title"));
                HilTargetVerification verification = new HilTargetVerifier(new WindowsWindowFactsSource()).Verify(requested);
                WindowFacts facts = verification.Facts;
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    ok = verification.Ok,
                    reason = verification.Reason,
                    facts = new
                    {
                        hwnd = facts.Hwnd.ToString(CultureInfo.InvariantCulture),
                        processId = facts.ProcessId,
                        processName = facts.ProcessName,
                        title = facts.Title,
                        bounds = new { x = facts.Bounds.Left, y = facts.Bounds.Top, width = facts.Bounds.Width, height = facts.Bounds.Height },
                        isVisible = facts.IsVisible,
                        isMinimized = facts.IsMinimized,
                    },
                }));
                return verification.Ok ? 0 : 3;
            }
            if (args[0].Equals("run-real", StringComparison.Ordinal))
            {
                Dictionary<string, string> options = Options(args);
                return RealHilRunner.Run(Required(options, "scenario"), Required(options, "output-dir"));
            }
            if (args[0].Equals("worker", StringComparison.Ordinal))
            {
                Dictionary<string, string> options = Options(args);
                return RealHilRunner.RunWorker(Required(options, "ready-file"), Required(options, "schedule"),
                    Required(options, "output-dir"), Required(options, "ownership-file"), Required(options, "heartbeat-file"));
            }
            Console.Error.WriteLine("REFUSED: unknown HIL command; no input was sent.");
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("HIL FAILED: " + ex);
            return 1;
        }
    }

    private static Dictionary<string, string> Options(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < args.Length; i += 2)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal) || i + 1 >= args.Length)
                throw new ArgumentException("options must be --name value pairs");
            result[args[i][2..]] = args[i + 1];
        }
        return result;
    }

    private static string Required(Dictionary<string, string> options, string name) =>
        options.TryGetValue(name, out string? value) && !string.IsNullOrWhiteSpace(value)
            ? value : throw new ArgumentException("missing required --" + name);
}

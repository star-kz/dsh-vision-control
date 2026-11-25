using System.Diagnostics;
using System.Reflection;
using System.Runtime.ExceptionServices;

namespace Rt.Tests;

/// <summary>
/// Zero-dependency self-hosted test runner: discovers [RtFact] methods by reflection, runs them
/// in declaration order, prints one PASS/FAIL line per test plus a summary, and exits non-zero
/// when anything failed. No NuGet packages are involved.
/// Usage: Rt.Tests [--filter &lt;substring&gt;] [--category &lt;name&gt;] [--list]
/// </summary>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string? filter = null;
        string? category = null;
        bool list = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--filter" && i + 1 < args.Length) filter = args[++i];
            else if (args[i] == "--category" && i + 1 < args.Length) category = args[++i];
            else if (args[i] == "--list") list = true;
        }

        var tests = typeof(Program).Assembly.GetTypes()
            .Where(t => t.IsClass)
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Select(m => (Type: t, Method: m, Attr: m.GetCustomAttribute<RtFactAttribute>())))
            .Where(x => x.Attr is not null)
            .Where(x => filter is null || $"{x.Type.Name}.{x.Method.Name}".Contains(filter, StringComparison.OrdinalIgnoreCase))
            .Where(x => category is null || string.Equals(x.Attr!.Category, category, StringComparison.OrdinalIgnoreCase))
            .OrderBy(x => x.Type.Name, StringComparer.Ordinal)
            .ThenBy(x => x.Method.MetadataToken)
            .ToList();

        if (list)
        {
            foreach (var (type, method, attr) in tests)
                Console.WriteLine($"{type.Name}.{method.Name} [{attr!.Category ?? "-"}]");
            return 0;
        }

        Console.WriteLine("Rt.Tests self-hosted runner (zero-NuGet)");
        Console.WriteLine($"  env      : {Environment.OSVersion} | .NET {Environment.Version} | {Environment.ProcessorCount} logical CPUs");
        Console.WriteLine($"  clock    : QPC {Stopwatch.Frequency} Hz");
        Console.WriteLine($"  selection: {tests.Count} test(s)" + (filter is null ? "" : $" filter='{filter}'") + (category is null ? "" : $" category='{category}'"));
        Console.WriteLine();

        int passed = 0;
        var failures = new List<string>();
        var total = Stopwatch.StartNew();
        foreach (var (type, method, attr) in tests)
        {
            string name = $"{type.Name}.{method.Name}";
            string tag = attr!.Category is null ? "" : $" [{attr.Category}]";
            var stopwatch = Stopwatch.StartNew();
            try
            {
                object? result;
                try
                {
                    result = method.Invoke(null, null);
                }
                catch (TargetInvocationException tie) when (tie.InnerException is not null)
                {
                    ExceptionDispatchInfo.Capture(tie.InnerException).Throw();
                    throw;
                }
                switch (result)
                {
                    case Task task:
                        await task.ConfigureAwait(false);
                        break;
                    case ValueTask valueTask:
                        await valueTask.ConfigureAwait(false);
                        break;
                }
                stopwatch.Stop();
                passed++;
                Console.WriteLine($"[PASS] {name}{tag} ({stopwatch.Elapsed.TotalMilliseconds:F1} ms)");
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                failures.Add(name);
                Console.WriteLine($"[FAIL] {name}{tag} ({stopwatch.Elapsed.TotalMilliseconds:F1} ms)");
                Console.WriteLine($"       {ex.GetType().Name}: {ex.Message}");
                if (ex is not AssertFailedException && ex.StackTrace is { } stack)
                {
                    foreach (string line in stack.Split('\n'))
                        Console.WriteLine("       " + line.TrimEnd());
                }
            }
        }
        total.Stop();

        Console.WriteLine();
        Console.WriteLine($"Total: {tests.Count}  Passed: {passed}  Failed: {failures.Count}  Elapsed: {total.Elapsed.TotalMilliseconds:F0} ms");
        if (failures.Count > 0)
        {
            Console.WriteLine("Failed:");
            foreach (string failure in failures) Console.WriteLine($"  - {failure}");
            return 1;
        }
        return 0;
    }
}

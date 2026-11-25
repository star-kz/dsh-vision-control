using System.Text.Json;

namespace Rt.Worker;

internal static class WorkerApplication
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<int> RunAsync(string[] args, TextReader input, TextWriter output, TextWriter error)
    {
        try
        {
            if (args.Length == 1 && args[0] is "--stdio" or "stdio")
            {
                await using var server = new StdioServer(input, output);
                await server.RunAsync();
                return 0;
            }
            if (args.Length == 1 && args[0] is "--help" or "-h" or "help")
            {
                await output.WriteLineAsync(Usage);
                return 0;
            }
            if (args.Length == 0) throw new WorkerException("BAD_USAGE", Usage);
            return await RunCliAsync(args, output);
        }
        catch (Exception ex)
        {
            string code = ex is WorkerException worker ? worker.Code : "COMMAND_FAILED";
            string message = ex is TypeInitializationException { InnerException: { } inner } ? inner.Message : ex.Message;
            await error.WriteLineAsync(Serialize(new { ok = false, error = new { code, message } }));
            return code == "BAD_USAGE" ? 2 : 1;
        }
    }

    private static async Task<int> RunCliAsync(string[] args, TextWriter output)
    {
        string command = args[0];
        if (command == "--replay") command = "replay";
        if (command is "replay" or "golden")
        {
            Dictionary<string, string?> options = ParseOptions(args.Skip(1));
            if (!options.ContainsKey("--virtual-input"))
                throw new WorkerException("VIRTUAL_INPUT_REQUIRED",
                    "Task 4 replay requires --virtual-input; real capture and SendInput are not implemented");
            string trace = RequiredOption(options, "--trace");
            string golden = RequiredOption(options, "--golden");
            ReplayExecution result = WorkerReplay.Execute(trace, golden);
            if (options.TryGetValue("--assert", out string? expected))
                WorkerReplay.AssertEqual(golden, RequiredValue(expected, "--assert"));
            await output.WriteLineAsync(Serialize(new
            {
                ok = true, command = "replay", virtualInput = true, golden,
                result.PlanCount, result.VirtualEvents, result.Receipts,
                result.FinalQpc, result.GoldenBytes, result.GoldenSha256,
            }));
            return 0;
        }
        if (command is "assert" or "--assert")
        {
            Dictionary<string, string?> options = ParseOptions(args.Skip(1));
            string actual = RequiredOption(options, "--actual");
            string expected = RequiredOption(options, "--expected");
            WorkerReplay.AssertEqual(actual, expected);
            await output.WriteLineAsync(Serialize(new { ok = true, command = "assert", actual, expected }));
            return 0;
        }
        throw new WorkerException("BAD_USAGE", $"unknown command '{command}'. {Usage}");
    }

    private static Dictionary<string, string?> ParseOptions(IEnumerable<string> args)
    {
        var result = new Dictionary<string, string?>(StringComparer.Ordinal);
        string? pending = null;
        foreach (string arg in args)
        {
            if (pending is not null)
            {
                result.Add(pending, arg);
                pending = null;
                continue;
            }
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                // --replay <trace> is accepted as an alias for replay --trace <trace>.
                if (!result.ContainsKey("--trace")) { result.Add("--trace", arg); continue; }
                throw new WorkerException("BAD_USAGE", $"unexpected positional argument '{arg}'");
            }
            if (arg == "--virtual-input") { result.Add(arg, null); continue; }
            if (arg is not ("--trace" or "--golden" or "--assert" or "--actual" or "--expected" or "--output"))
                throw new WorkerException("BAD_USAGE", $"unknown option '{arg}'");
            pending = arg;
        }
        if (pending is not null) throw new WorkerException("BAD_USAGE", $"option '{pending}' requires a value");
        if (result.TryGetValue("--output", out string? output))
        {
            if (result.ContainsKey("--golden")) throw new WorkerException("BAD_USAGE", "use only one of --golden and --output");
            result.Add("--golden", RequiredValue(output, "--output"));
        }
        return result;
    }

    private static string RequiredOption(Dictionary<string, string?> options, string name) =>
        options.TryGetValue(name, out string? value)
            ? RequiredValue(value, name)
            : throw new WorkerException("BAD_USAGE", $"missing required option '{name}'");

    private static string RequiredValue(string? value, string name) =>
        !string.IsNullOrWhiteSpace(value) ? value : throw new WorkerException("BAD_USAGE", $"option '{name}' requires a value");

    private static string Serialize(object value) => JsonSerializer.Serialize(value, JsonOptions);

    private const string Usage =
        "Rt.Worker --stdio | replay --trace <trace.rtt> --virtual-input --golden <plans.jsonl> [--assert <expected.jsonl>] | " +
        "golden --trace <trace.rtt> --virtual-input --golden <plans.jsonl> | assert --actual <plans.jsonl> --expected <expected.jsonl>";
}

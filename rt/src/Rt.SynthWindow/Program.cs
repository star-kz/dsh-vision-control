namespace Rt.SynthWindow;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            Dictionary<string, string> options = Options(args);
            string output = Required(options, "output-dir");
            string role = options.TryGetValue("role", out string? value) ? value : "primary";
            if (role is not ("primary" or "decoy")) throw new ArgumentException("role must be primary or decoy");
            string? schedule = options.TryGetValue("schedule", out string? path) ? path : null;
            if (role == "primary" && string.IsNullOrWhiteSpace(schedule))
                throw new ArgumentException("the primary window requires an explicit ground-truth schedule");
            string title = Required(options, "title");
            Directory.CreateDirectory(output);
            ApplicationConfiguration.Initialize();
            Application.Run(new SynthForm(output, role, title, schedule));
            return 0;
        }
        catch (Exception ex)
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "rt-task6-synthwindow-error.log"),
                DateTimeOffset.UtcNow.ToString("O") + " " + ex + Environment.NewLine);
            return 1;
        }
    }

    private static Dictionary<string, string> Options(IReadOnlyList<string> args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Count; i += 2)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal) || i + 1 >= args.Count)
                throw new ArgumentException("options must be --name value pairs");
            result[args[i][2..]] = args[i + 1];
        }
        return result;
    }

    private static string Required(Dictionary<string, string> options, string name) =>
        options.TryGetValue(name, out string? value) && !string.IsNullOrWhiteSpace(value)
            ? value : throw new ArgumentException("missing required --" + name);
}

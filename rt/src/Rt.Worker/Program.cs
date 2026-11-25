namespace Rt.Worker;

internal static class Program
{
    public static async Task<int> Main(string[] args) =>
        await WorkerApplication.RunAsync(args, Console.In, Console.Out, Console.Error);
}

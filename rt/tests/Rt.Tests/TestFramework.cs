using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;

namespace Rt.Tests;

/// <summary>Marks a public static test method (void, Task or ValueTask) for the self-hosted runner.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class RtFactAttribute : Attribute
{
    /// <summary>Optional category, e.g. "timing" or "stress" for live-machine tests.</summary>
    public string? Category { get; set; }
}

/// <summary>Thrown by <see cref="Assert"/> when a test assertion fails.</summary>
public sealed class AssertFailedException : Exception
{
    public AssertFailedException(string message) : base(message) { }
}

/// <summary>Minimal assertion helpers; failures carry the measured values so RED logs are self-explanatory.</summary>
public static class Assert
{
    [DoesNotReturn]
    public static void Fail(string message) => throw new AssertFailedException(message);

    public static void True(bool condition, string message)
    {
        if (!condition) Fail(message);
    }

    public static void False(bool condition, string message) => True(!condition, message);

    public static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            Fail($"{message} — expected <{Fmt(expected)}> but was <{Fmt(actual)}>");
    }

    public static void NotEqual<T>(T expected, T actual, string message)
    {
        if (EqualityComparer<T>.Default.Equals(expected, actual))
            Fail($"{message} — value <{Fmt(actual)}> must differ");
    }

    public static void Same(object? expected, object? actual, string message)
    {
        if (!ReferenceEquals(expected, actual)) Fail(message);
    }

    public static void NotSame(object? expected, object? actual, string message)
    {
        if (ReferenceEquals(expected, actual)) Fail(message);
    }

    public static void Null(object? value, string message)
    {
        if (value is not null) Fail($"{message} — expected null but got <{Fmt(value)}>");
    }

    public static T NotNull<T>(T? value, string message) where T : class
    {
        if (value is null) Fail($"{message} — expected non-null");
        return value;
    }

    public static void GreaterOrEqual<T>(T actual, T minimum, string message) where T : IComparable<T>
    {
        if (actual.CompareTo(minimum) < 0) Fail($"{message} — actual <{Fmt(actual)}> < minimum <{Fmt(minimum)}>");
    }

    public static void LessOrEqual<T>(T actual, T maximum, string message) where T : IComparable<T>
    {
        if (actual.CompareTo(maximum) > 0) Fail($"{message} — actual <{Fmt(actual)}> > maximum <{Fmt(maximum)}>");
    }

    public static TException Throws<TException>(Action action, string message) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException ex)
        {
            return ex;
        }
        catch (Exception ex)
        {
            throw NewFail($"{message} — expected {typeof(TException).Name} but got {ex.GetType().Name}: {ex.Message}");
        }
        throw NewFail($"{message} — expected {typeof(TException).Name} but nothing was thrown");
    }

    public static async Task<TException> ThrowsAsync<TException>(Func<Task> action, string message) where TException : Exception
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (TException ex)
        {
            return ex;
        }
        catch (Exception ex)
        {
            throw NewFail($"{message} — expected {typeof(TException).Name} but got {ex.GetType().Name}: {ex.Message}");
        }
        throw NewFail($"{message} — expected {typeof(TException).Name} but the task completed successfully");
    }

    /// <summary>Creates (does not throw) an assertion failure — lets callers write "throw NewFail(...)" where the compiler needs a definite throw for reachability.</summary>
    private static AssertFailedException NewFail(string message) => new(message);

    private static string Fmt(object? value) => value switch
    {
        null => "null",
        string s => s,
        byte[] b => $"byte[{b.Length}]",
        _ => value.ToString() ?? "?",
    };
}

/// <summary>Bounded spin-wait helper so driver loops never hang forever on a missing signal.</summary>
public static class Spin
{
    public static void WaitForCondition(Func<bool> condition, string what, int timeoutMs = 10_000)
    {
        var stopwatch = Stopwatch.StartNew();
        int iterations = 0;
        while (!condition())
        {
            if (stopwatch.ElapsedMilliseconds > timeoutMs)
                Assert.Fail($"timed out after {timeoutMs} ms waiting for: {what}");
            if (iterations++ < 500) Thread.SpinWait(256);
            else Thread.Sleep(1);
        }
    }
}

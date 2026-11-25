using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Rt.SynthWindow;

public sealed class SynthForm : Form
{
    private const int WmKeydown = 0x0100;
    private const int WmKeyup = 0x0101;
    private const int WmSysKeydown = 0x0104;
    private const int WmSysKeyup = 0x0105;
    public const int WmHilActivate = 0x8000 + 0x4a;
    private readonly string _output;
    private readonly string _role;
    private readonly List<GroundAction> _actions = new();
    private readonly string[] _lanes;
    private readonly StreamWriter _windowLog;
    private readonly object _logSync = new();
    private readonly System.Windows.Forms.Timer _paintTimer;
    private long _sequence;
    private bool _closed;

    public SynthForm(string output, string role, string title, string? schedulePath)
    {
        _output = output;
        _role = role;
        Text = title;
        StartPosition = FormStartPosition.Manual;
        Location = role == "primary" ? new Point(100, 100) : new Point(920, 140);
        ClientSize = new Size(720, 620);
        BackColor = Color.FromArgb(10, 14, 25);
        ForeColor = Color.White;
        Font = new Font("Consolas", 12, FontStyle.Regular);
        DoubleBuffered = true;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        // The dedicated target must remain clickable above a fullscreen game during HIL setup.
        // This affects only our self-built window; it never changes another process's window state.
        TopMost = true;

        if (schedulePath is not null)
        {
            using JsonDocument schedule = JsonDocument.Parse(File.ReadAllText(schedulePath));
            if (schedule.RootElement.TryGetProperty("actions", out JsonElement actions))
            {
                foreach (JsonElement action in actions.EnumerateArray())
                {
                    _actions.Add(new GroundAction(
                        action.GetProperty("actionId").GetString()!,
                        action.GetProperty("control").GetString()!,
                        action.GetProperty("downQpc").GetInt64(),
                        action.GetProperty("upQpc").GetInt64(),
                        action.TryGetProperty("latestQpc", out JsonElement latest) ? latest.GetInt64() : action.GetProperty("upQpc").GetInt64()));
                }
            }
        }
        _lanes = schedulePath is not null && _actions.Count > 0
            ? _actions.Select(a => a.Control).Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray()
            : new[] { "key.a", "key.s", "key.d", "key.f" };
        _windowLog = new StreamWriter(Path.Combine(output, role + "-window.jsonl"), false)
        {
            AutoFlush = true,
        };
        if (schedulePath is not null)
        {
            using var ground = new StreamWriter(Path.Combine(output, role + "-ground-truth.jsonl"), false);
            foreach (GroundAction action in _actions)
            {
                WriteGround(ground, action, "Down", action.DownQpc, action.LatestQpc);
                WriteGround(ground, action, "Up", action.UpQpc, action.LatestQpc);
            }
        }

        _paintTimer = new System.Windows.Forms.Timer { Interval = 8 };
        _paintTimer.Tick += (_, _) => Invalidate();
        Shown += (_, _) => PublishReady();
        FormClosed += (_, _) => Finish();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // Activation originates in the dedicated GUI process, never by sending keys to the desktop.
        BringToFront();
        Activate();
        SetForegroundWindow(Handle);
        _paintTimer.Start();
    }

    private void PublishReady()
    {
        GetWindowRect(Handle, out Rect rect);
        var ready = new
        {
            hwnd = Handle.ToInt64(),
            pid = Environment.ProcessId,
            processName = Process.GetCurrentProcess().ProcessName,
            title = Text,
            bounds = new { left = rect.Left, top = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top },
            frequency = Frequency(),
            lanes = _lanes,
        };
        File.WriteAllText(Path.Combine(_output, _role + "-ready.json"), JsonSerializer.Serialize(ready, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static long Qpc() { QueryPerformanceCounter(out long qpc); return qpc; }
    private static long Frequency() { QueryPerformanceFrequency(out long frequency); return frequency; }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmHilActivate)
        {
            // Sent only to the revalidated dedicated HWND. This is a private window
            // message, never keyboard/mouse input and never broadcast to other windows.
            if (IsIconic(Handle)) ShowWindow(Handle, 9);
            TopMost = true;
            BringToFront();
            Activate();
            SwitchToThisWindow(Handle, true);
            SetForegroundWindow(Handle);
            m.Result = GetForegroundWindow() == Handle ? 1 : 0;
            return;
        }
        if (m.Msg is WmKeydown or WmKeyup or WmSysKeydown or WmSysKeyup)
        {
            long qpc = Qpc();
            long lParam = m.LParam.ToInt64();
            int scanCode = (int)((lParam >> 16) & 0xff);
            bool extended = (lParam & (1L << 24)) != 0;
            bool repeat = (lParam & (1L << 30)) != 0;
            string phase = m.Msg is WmKeyup or WmSysKeyup ? "Up" : "Down";
            string control = FromScanCode(scanCode, extended);
            lock (_logSync)
            {
                _windowLog.WriteLine(JsonSerializer.Serialize(new
                {
                    sequence = ++_sequence,
                    actionId = string.Empty,
                    control,
                    phase,
                    qpc,
                    scanCode,
                    extended,
                    repeat,
                    foreground = GetForegroundWindow() == Handle,
                }));
            }
            Invalidate();
        }
        base.WndProc(ref m);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(BackColor);
        using var title = new SolidBrush(Color.White);
        using var muted = new SolidBrush(Color.FromArgb(140, 155, 180));
        g.DrawString("DEDICATED HIL TARGET — NO OTHER WINDOW IS A VALID TARGET", Font, title, 18, 14);
        g.DrawString($"role={_role}  pid={Environment.ProcessId}  ground-actions={_actions.Count}", Font, muted, 18, 42);

        int laneWidth = Math.Max(72, (ClientSize.Width - 40) / _lanes.Length);
        int totalWidth = laneWidth * _lanes.Length;
        int left = (ClientSize.Width - totalWidth) / 2;
        const int hitY = 510;
        long now = Qpc();
        long frequency = Frequency();
        for (int i = 0; i < _lanes.Length; i++)
        {
            int x = left + i * laneWidth;
            using var laneBrush = new SolidBrush(i % 2 == 0 ? Color.FromArgb(20, 28, 48) : Color.FromArgb(26, 35, 57));
            g.FillRectangle(laneBrush, x, 80, laneWidth - 3, 470);
            using var hit = new Pen(Color.FromArgb(75, 220, 190), 3);
            g.DrawLine(hit, x + 3, hitY, x + laneWidth - 9, hitY);
            g.DrawString(_lanes[i].Replace("key.", string.Empty, StringComparison.Ordinal).ToUpperInvariant(),
                Font, title, x + 12, hitY + 16);
        }
        foreach (GroundAction action in _actions)
        {
            int lane = Array.IndexOf(_lanes, action.Control);
            if (lane < 0) continue;
            double downMs = (action.DownQpc - now) * 1000.0 / frequency;
            double upMs = (action.UpQpc - now) * 1000.0 / frequency;
            if (upMs < -100 || downMs > 1700) continue;
            int x = left + lane * laneWidth + 10;
            double yDown = hitY - downMs * 0.25;
            double yUp = hitY - upMs * 0.25;
            float y = (float)Math.Min(yDown, yUp);
            float height = (float)Math.Max(12, Math.Abs(yDown - yUp));
            using var note = new SolidBrush(Color.FromArgb(115, 145, 255));
            g.FillRectangle(note, x, y, laneWidth - 23, height);
        }
    }

    private void Finish()
    {
        if (_closed) return;
        _closed = true;
        _paintTimer.Stop();
        lock (_logSync) _windowLog.Flush();
        try
        {
            using var bitmap = new Bitmap(ClientSize.Width, ClientSize.Height);
            DrawToBitmap(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height));
            bitmap.Save(Path.Combine(_output, _role + ".png"));
        }
        catch (Exception ex)
        {
            File.WriteAllText(Path.Combine(_output, _role + "-screenshot-error.txt"), ex.ToString());
        }
        GetWindowRect(Handle, out Rect rect);
        var summary = new
        {
            role = _role,
            pid = Environment.ProcessId,
            hwnd = Handle.ToInt64(),
            title = Text,
            groundTruthEvents = _actions.Count * 2,
            windowEvents = _sequence,
            frequency = Frequency(),
            finalBounds = new { left = rect.Left, top = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top },
        };
        File.WriteAllText(Path.Combine(_output, _role + "-summary.json"), JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true }));
        _windowLog.Dispose();
    }

    private static void WriteGround(StreamWriter writer, GroundAction action, string phase, long scheduledQpc, long latestQpc) =>
        writer.WriteLine(JsonSerializer.Serialize(new
        {
            actionId = action.ActionId,
            control = action.Control,
            phase,
            scheduledQpc,
            latestQpc,
        }));

    private static string FromScanCode(int scanCode, bool extended) => (extended, scanCode) switch
    {
        (false, 0x1e) => "key.a", (false, 0x1f) => "key.s", (false, 0x20) => "key.d",
        (false, 0x21) => "key.f", (false, 0x24) => "key.j", (false, 0x25) => "key.k",
        (false, 0x26) => "key.l", (false, 0x27) => "key.semicolon", (false, 0x39) => "key.space",
        (true, 0x4b) => "key.left", (true, 0x48) => "key.up", (true, 0x50) => "key.down",
        (true, 0x4d) => "key.right", _ => $"unmapped.scan-{scanCode:x2}.extended-{extended}",
    };

    private sealed record GroundAction(string ActionId, string Control, long DownQpc, long UpQpc, long LatestQpc);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(nint hwnd, bool altTab);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("kernel32.dll")] private static extern bool QueryPerformanceCounter(out long value);
    [DllImport("kernel32.dll")] private static extern bool QueryPerformanceFrequency(out long value);
}

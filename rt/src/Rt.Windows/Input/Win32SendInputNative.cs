using System.Runtime.InteropServices;

namespace Rt.Windows.Input;

/// <summary>Thin user32 SendInput boundary. Keyboard events use KEYEVENTF_SCANCODE.</summary>
public sealed class Win32SendInputNative : ISendInputNative
{
    private const uint InputKeyboard = 1;
    private const uint KeyeventfExtendedkey = 0x0001;
    private const uint KeyeventfKeyup = 0x0002;
    private const uint KeyeventfScancode = 0x0008;

    public SendInputNativeResult Send(IReadOnlyList<SendInputFrame> inputs)
    {
        ArgumentNullException.ThrowIfNull(inputs);
        if (inputs.Count == 0) return new SendInputNativeResult(0, 0);
        var native = new NativeInput[inputs.Count];
        for (int i = 0; i < inputs.Count; i++)
        {
            SendInputFrame frame = inputs[i];
            uint flags = KeyeventfScancode;
            if (frame.Extended) flags |= KeyeventfExtendedkey;
            if (frame.KeyUp) flags |= KeyeventfKeyup;
            native[i] = new NativeInput
            {
                Type = InputKeyboard,
                Data = new InputUnion
                {
                    Keyboard = new KeyboardInput
                    {
                        VirtualKey = frame.VirtualKey,
                        ScanCode = frame.ScanCode,
                        Flags = flags,
                        Time = 0,
                        ExtraInfo = 0,
                    },
                },
            };
        }

        uint inserted = SendInput((uint)native.Length, native, Marshal.SizeOf<NativeInput>());
        int error = inserted == (uint)native.Length ? 0 : Marshal.GetLastWin32Error();
        return new SendInputNativeResult(checked((int)inserted), error);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeInput
    {
        public uint Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public nuint ExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, NativeInput[] inputs, int size);
}

namespace Rt.Core.Tracing;

/// <summary>Small dependency-free IEEE CRC-32 implementation used by the on-disk format.</summary>
internal static class Crc32
{
    public static uint Compute(ReadOnlySpan<byte> bytes)
    {
        uint crc = uint.MaxValue;
        foreach (byte value in bytes)
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
                crc = (crc >> 1) ^ (0xEDB88320U & (uint)-(int)(crc & 1));
        }
        return ~crc;
    }
}

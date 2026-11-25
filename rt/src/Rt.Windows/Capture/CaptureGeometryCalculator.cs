namespace Rt.Windows.Capture;

/// <summary>Pure DPI/ROI mapping shared by live capture and deterministic tests.</summary>
public static class CaptureGeometryCalculator
{
    public static CaptureGeometry Create(
        CapturePixelRect itemPixels,
        double logicalX,
        double logicalY,
        int dpiX,
        int dpiY,
        CaptureLogicalRect? requestedRoiLogical = null)
    {
        if (itemPixels.Width <= 0) throw new ArgumentOutOfRangeException(nameof(itemPixels), "Item pixel width must be positive.");
        if (itemPixels.Height <= 0) throw new ArgumentOutOfRangeException(nameof(itemPixels), "Item pixel height must be positive.");
        if (dpiX <= 0) throw new ArgumentOutOfRangeException(nameof(dpiX));
        if (dpiY <= 0) throw new ArgumentOutOfRangeException(nameof(dpiY));
        if (!double.IsFinite(logicalX)) throw new ArgumentOutOfRangeException(nameof(logicalX));
        if (!double.IsFinite(logicalY)) throw new ArgumentOutOfRangeException(nameof(logicalY));

        var itemLogical = new CaptureLogicalRect(
            logicalX,
            logicalY,
            itemPixels.Width * 96.0 / dpiX,
            itemPixels.Height * 96.0 / dpiY);

        CaptureLogicalRect requested = requestedRoiLogical ?? itemLogical;
        ValidateLogicalRect(requested);
        double right = requested.X + requested.Width;
        double bottom = requested.Y + requested.Height;
        double clampedLeft = Math.Max(requested.X, itemLogical.X);
        double clampedTop = Math.Max(requested.Y, itemLogical.Y);
        double clampedRight = Math.Min(right, itemLogical.X + itemLogical.Width);
        double clampedBottom = Math.Min(bottom, itemLogical.Y + itemLogical.Height);
        if (clampedRight <= clampedLeft || clampedBottom <= clampedTop)
            throw new ArgumentOutOfRangeException(nameof(requestedRoiLogical), "The requested ROI does not intersect the capture item.");

        int itemRight = checked(itemPixels.X + itemPixels.Width);
        int itemBottom = checked(itemPixels.Y + itemPixels.Height);
        int left = Clamp(itemPixels.X + FloorScaled(clampedLeft - itemLogical.X, dpiX), itemPixels.X, itemRight);
        int top = Clamp(itemPixels.Y + FloorScaled(clampedTop - itemLogical.Y, dpiY), itemPixels.Y, itemBottom);
        int roiRight = Clamp(itemPixels.X + CeilScaled(clampedRight - itemLogical.X, dpiX), itemPixels.X, itemRight);
        int roiBottom = Clamp(itemPixels.Y + CeilScaled(clampedBottom - itemLogical.Y, dpiY), itemPixels.Y, itemBottom);
        if (roiRight <= left || roiBottom <= top)
            throw new ArgumentOutOfRangeException(nameof(requestedRoiLogical), "The requested ROI is smaller than one physical pixel.");

        var roiPixels = new CapturePixelRect(left, top, roiRight - left, roiBottom - top);
        var roiLogical = new CaptureLogicalRect(
            itemLogical.X + (left - itemPixels.X) * 96.0 / dpiX,
            itemLogical.Y + (top - itemPixels.Y) * 96.0 / dpiY,
            (roiRight - left) * 96.0 / dpiX,
            (roiBottom - top) * 96.0 / dpiY);
        return new CaptureGeometry(itemPixels, roiPixels, itemLogical, roiLogical, dpiX, dpiY);
    }

    private static void ValidateLogicalRect(CaptureLogicalRect rect)
    {
        if (!double.IsFinite(rect.X) || !double.IsFinite(rect.Y) ||
            !double.IsFinite(rect.Width) || !double.IsFinite(rect.Height) ||
            rect.Width <= 0 || rect.Height <= 0)
            throw new ArgumentOutOfRangeException(nameof(rect), "ROI coordinates must be finite and its size must be positive.");
    }

    private static int FloorScaled(double logicalOffset, int dpi) => checked((int)Math.Floor(logicalOffset * dpi / 96.0));

    private static int CeilScaled(double logicalOffset, int dpi) => checked((int)Math.Ceiling(logicalOffset * dpi / 96.0));

    private static int Clamp(int value, int minimum, int maximum) => Math.Min(Math.Max(value, minimum), maximum);
}

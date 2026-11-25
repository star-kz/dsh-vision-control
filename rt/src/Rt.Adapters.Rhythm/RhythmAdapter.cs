using Rt.Core.Perception;
using System.Buffers;

namespace Rt.Adapters.Rhythm;

/// <summary>
/// Explainable falling-note detector: per-lane BGRA color matching plus connected-component geometry.
/// This is deliberately not a general AI model and does not claim to recognize arbitrary games.
/// </summary>
public sealed class RhythmAdapter : ISceneAdapter
{
    private const string HeadCategory = "noteHead";
    private const string TailCategory = "noteTail";
    private const string BodyCategory = "noteBody";

    public RhythmAdapter(SceneDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        Validate(descriptor);
        Descriptor = descriptor;
    }

    public SceneDescriptor Descriptor { get; }

    public IReadOnlyList<Detection> Detect(SceneFrame frame)
    {
        if (frame.Meta.Format != Rt.Core.Contracts.FramePixelFormat.Bgra32 ||
            Descriptor.Regions.Any(region =>
                region.Roi.X < 0 || region.Roi.Y < 0 ||
                region.Roi.Right > frame.Meta.Width || region.Roi.Bottom > frame.Meta.Height))
            return Array.Empty<Detection>();

        CategoryDescriptor head = Descriptor.Categories.Single(category => category.Name == HeadCategory);
        CategoryDescriptor? tail = Descriptor.Categories.SingleOrDefault(category => category.Name == TailCategory);
        CategoryDescriptor? body = Descriptor.Categories.SingleOrDefault(category => category.Name == BodyCategory);
        int scratchLength = Descriptor.Regions.Max(region => checked(region.Roi.Width * region.Roi.Height));
        byte[] visited = ArrayPool<byte>.Shared.Rent(scratchLength);
        int[] queue = ArrayPool<int>.Shared.Rent(scratchLength);
        try
        {
            var notes = new List<Detection>();
            foreach (RegionDescriptor region in Descriptor.Regions)
            {
                List<DetectionPart> heads = FindComponents(frame, region.Roi, head, visited, queue);
                foreach (DetectionPart headPart in heads.OrderBy(part => part.Bounds.Y))
                {
                    var parts = new List<DetectionPart> { headPart };
                    DetectionPart? tailPart = null;
                    if (tail is not null && headPart.Bounds.Y > region.Roi.Y)
                    {
                        PixelRect search = SearchAbove(region.Roi, headPart.Bounds, region.Roi.Y, headPart.Bounds.Y);
                        tailPart = FindComponents(frame, search, tail, visited, queue)
                            .Where(candidate => Aligned(candidate.Bounds, headPart.Bounds))
                            .OrderBy(candidate => headPart.Bounds.Y - candidate.Bounds.Bottom)
                            .FirstOrDefault();
                    }
                    if (tailPart is not null)
                    {
                        parts.Add(tailPart);
                        if (body is not null && tailPart.Bounds.Bottom < headPart.Bounds.Y)
                        {
                            PixelRect search = SearchAbove(region.Roi, headPart.Bounds,
                                tailPart.Bounds.Bottom, headPart.Bounds.Y);
                            parts.AddRange(FindComponents(frame, search, body, visited, queue)
                                .Where(candidate => Aligned(candidate.Bounds, headPart.Bounds)));
                        }
                    }
                    PixelRect bounds = Union(parts.Select(part => part.Bounds));
                    double confidence = parts.Min(part => part.Confidence);
                    notes.Add(new Detection(region.Id, "note", bounds, confidence, parts));
                }
            }
            return notes;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(visited);
            ArrayPool<int>.Shared.Return(queue);
        }
    }

    private static List<DetectionPart> FindComponents(
        SceneFrame frame,
        PixelRect roi,
        CategoryDescriptor category,
        byte[] visited,
        int[] queue)
    {
        ReadOnlySpan<byte> pixels = frame.Bgra.Span;
        int count = checked(roi.Width * roi.Height);
        Array.Clear(visited, 0, count);
        var components = new List<DetectionPart>();
        int blueMin = Math.Max(0, category.Color.B - category.Color.Tolerance);
        int blueMax = Math.Min(255, category.Color.B + category.Color.Tolerance);
        int greenMin = Math.Max(0, category.Color.G - category.Color.Tolerance);
        int greenMax = Math.Min(255, category.Color.G + category.Color.Tolerance);
        int redMin = Math.Max(0, category.Color.R - category.Color.Tolerance);
        int redMax = Math.Min(255, category.Color.R + category.Color.Tolerance);
        for (int localY = 0; localY < roi.Height; localY++)
        for (int localX = 0; localX < roi.Width; localX++)
        {
            int start = localY * roi.Width + localX;
            if (visited[start] != 0) continue;
            int pixelOffset = (roi.Y + localY) * frame.StrideBytes + (roi.X + localX) * 4;
            if (pixels[pixelOffset] < blueMin || pixels[pixelOffset] > blueMax ||
                pixels[pixelOffset + 1] < greenMin || pixels[pixelOffset + 1] > greenMax ||
                pixels[pixelOffset + 2] < redMin || pixels[pixelOffset + 2] > redMax)
                continue;

            int head = 0;
            int tail = 0;
            queue[tail++] = start;
            visited[start] = 1;
            int area = 0;
            int minX = localX;
            int maxX = localX;
            int minY = localY;
            int maxY = localY;
            while (head < tail)
            {
                int current = queue[head++];
                int x = current % roi.Width;
                int y = current / roi.Width;
                area++;
                minX = Math.Min(minX, x);
                maxX = Math.Max(maxX, x);
                minY = Math.Min(minY, y);
                maxY = Math.Max(maxY, y);
                for (int direction = 0; direction < 4; direction++)
                {
                    int nextX = x + (direction == 0 ? -1 : direction == 1 ? 1 : 0);
                    int nextY = y + (direction == 2 ? -1 : direction == 3 ? 1 : 0);
                    if (nextX < 0 || nextY < 0 || nextX >= roi.Width || nextY >= roi.Height) continue;
                    int next = nextY * roi.Width + nextX;
                    if (visited[next] != 0 || !Matches(pixels, frame.StrideBytes, roi.X + nextX, roi.Y + nextY, category.Color))
                        continue;
                    visited[next] = 1;
                    queue[tail++] = next;
                }
            }

            int width = maxX - minX + 1;
            int height = maxY - minY + 1;
            double fill = (double)area / (width * height);
            if (area < category.MinArea || width < category.MinWidth || height < category.MinHeight ||
                fill < category.MinFill)
                continue;
            double confidence = fill * Math.Min(1d, (double)area / category.ExpectedArea);
            components.Add(new DetectionPart(
                category.Name,
                new PixelRect(roi.X + minX, roi.Y + minY, width, height),
                confidence));
        }
        return components;

    }

    private static PixelRect SearchAbove(PixelRect roi, PixelRect head, int top, int bottom)
    {
        int left = Math.Max(roi.X, head.X - head.Width / 2);
        int right = Math.Min(roi.Right, head.Right + head.Width / 2);
        return new PixelRect(left, top, right - left, bottom - top);
    }

    private static bool Aligned(PixelRect left, PixelRect right)
    {
        int overlap = Math.Min(left.Right, right.Right) - Math.Max(left.X, right.X);
        return overlap >= Math.Min(left.Width, right.Width) / 2;
    }

    private static PixelRect Union(IEnumerable<PixelRect> rectangles)
    {
        int left = rectangles.Min(rectangle => rectangle.X);
        int top = rectangles.Min(rectangle => rectangle.Y);
        int right = rectangles.Max(rectangle => rectangle.Right);
        int bottom = rectangles.Max(rectangle => rectangle.Bottom);
        return new PixelRect(left, top, right - left, bottom - top);
    }

    private static bool Matches(
        ReadOnlySpan<byte> pixels,
        int stride,
        int x,
        int y,
        ColorRule color)
    {
        int offset = y * stride + x * 4;
        return Math.Abs(pixels[offset] - color.B) <= color.Tolerance &&
               Math.Abs(pixels[offset + 1] - color.G) <= color.Tolerance &&
               Math.Abs(pixels[offset + 2] - color.R) <= color.Tolerance;
    }

    private static void Validate(SceneDescriptor descriptor)
    {
        if (descriptor.Categories is null || descriptor.Categories.Count == 0 ||
            descriptor.Categories.Any(category => category is null || string.IsNullOrWhiteSpace(category.Name)))
            throw new ArgumentException("At least one named category is required.", nameof(descriptor));
        if (descriptor.Categories.Select(category => category.Name).Distinct(StringComparer.Ordinal).Count() !=
            descriptor.Categories.Count)
            throw new ArgumentException("Category names must be unique.", nameof(descriptor));
        if (!descriptor.Categories.Any(category => category.Name == HeadCategory))
            throw new ArgumentException("The rhythm descriptor requires noteHead.", nameof(descriptor));
        foreach (CategoryDescriptor category in descriptor.Categories)
        {
            if (category.MinArea <= 0 || category.MinWidth <= 0 || category.MinHeight <= 0 ||
                category.ExpectedArea < category.MinArea || category.MinFill is <= 0 or > 1)
                throw new ArgumentException($"Invalid geometry for category {category.Name}.", nameof(descriptor));
        }
        if (descriptor.Regions is null || descriptor.Regions.Count == 0 ||
            descriptor.Regions.Any(region => region is null || string.IsNullOrWhiteSpace(region.Id) ||
                string.IsNullOrWhiteSpace(region.Control) || region.Roi.Width <= 0 || region.Roi.Height <= 0 ||
                region.Roi.X < 0 || region.Roi.Y < 0 || region.ArrivalLineY < region.Roi.Y ||
                region.ArrivalLineY > region.Roi.Bottom))
            throw new ArgumentException("Regions require unique names, valid ROIs, arrival lines and controls.", nameof(descriptor));
        if (descriptor.Regions.Select(region => region.Id).Distinct(StringComparer.Ordinal).Count() != descriptor.Regions.Count ||
            descriptor.Regions.Select(region => region.Control).Distinct(StringComparer.Ordinal).Count() != descriptor.Regions.Count)
            throw new ArgumentException("Region IDs and whitelisted controls must be unique.", nameof(descriptor));
        ArgumentNullException.ThrowIfNull(descriptor.Tracking);
        ArgumentNullException.ThrowIfNull(descriptor.Policy);
    }
}

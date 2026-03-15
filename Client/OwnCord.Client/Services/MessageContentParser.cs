using System.Text.RegularExpressions;

namespace OwnCord.Client.Services;

/// <summary>
/// Parses message content into segments for rich rendering.
/// Handles code blocks (```), inline code (`), bold (**), italic (*), and plain text.
/// </summary>
public static class MessageContentParser
{
    public enum SegmentType { Text, CodeBlock, InlineCode, Bold, Italic }

    public record ContentSegment(SegmentType Type, string Text, string? Language = null);

    // Matches ```language\n...\n``` (multiline)
    private static readonly Regex CodeBlockRegex = new(
        @"```(\w*)\n?([\s\S]*?)```",
        RegexOptions.Compiled);

    // Matches `...` (single backtick inline code, no newlines)
    private static readonly Regex InlineCodeRegex = new(
        @"`([^`\n]+)`",
        RegexOptions.Compiled);

    // Matches **...** (bold)
    private static readonly Regex BoldRegex = new(
        @"\*\*(.+?)\*\*",
        RegexOptions.Compiled);

    // Matches *...* (italic, but not **)
    private static readonly Regex ItalicRegex = new(
        @"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)",
        RegexOptions.Compiled);

    public static IReadOnlyList<ContentSegment> Parse(string content)
    {
        if (string.IsNullOrEmpty(content))
            return Array.Empty<ContentSegment>();

        var segments = new List<ContentSegment>();
        ParseCodeBlocks(content, segments);
        return segments;
    }

    private static void ParseCodeBlocks(string text, List<ContentSegment> segments)
    {
        var lastIndex = 0;

        foreach (Match match in CodeBlockRegex.Matches(text))
        {
            if (match.Index > lastIndex)
            {
                ParseInlineCode(text[lastIndex..match.Index], segments);
            }

            var language = match.Groups[1].Value;
            var code = match.Groups[2].Value;
            segments.Add(new ContentSegment(
                SegmentType.CodeBlock,
                code,
                string.IsNullOrEmpty(language) ? null : language));

            lastIndex = match.Index + match.Length;
        }

        if (lastIndex < text.Length)
        {
            ParseInlineCode(text[lastIndex..], segments);
        }
    }

    private static void ParseInlineCode(string text, List<ContentSegment> segments)
    {
        var lastIndex = 0;

        foreach (Match match in InlineCodeRegex.Matches(text))
        {
            if (match.Index > lastIndex)
            {
                ParseBoldAndItalic(text[lastIndex..match.Index], segments);
            }

            segments.Add(new ContentSegment(SegmentType.InlineCode, match.Groups[1].Value));
            lastIndex = match.Index + match.Length;
        }

        if (lastIndex < text.Length)
        {
            ParseBoldAndItalic(text[lastIndex..], segments);
        }
    }

    private static void ParseBoldAndItalic(string text, List<ContentSegment> segments)
    {
        var lastIndex = 0;

        foreach (Match match in BoldRegex.Matches(text))
        {
            if (match.Index > lastIndex)
            {
                ParseItalic(text[lastIndex..match.Index], segments);
            }

            segments.Add(new ContentSegment(SegmentType.Bold, match.Groups[1].Value));
            lastIndex = match.Index + match.Length;
        }

        if (lastIndex < text.Length)
        {
            ParseItalic(text[lastIndex..], segments);
        }
    }

    private static void ParseItalic(string text, List<ContentSegment> segments)
    {
        var lastIndex = 0;

        foreach (Match match in ItalicRegex.Matches(text))
        {
            if (match.Index > lastIndex)
            {
                AddTextSegment(text[lastIndex..match.Index], segments);
            }

            segments.Add(new ContentSegment(SegmentType.Italic, match.Groups[1].Value));
            lastIndex = match.Index + match.Length;
        }

        if (lastIndex < text.Length)
        {
            AddTextSegment(text[lastIndex..], segments);
        }
    }

    private static void AddTextSegment(string text, List<ContentSegment> segments)
    {
        if (!string.IsNullOrEmpty(text))
        {
            segments.Add(new ContentSegment(SegmentType.Text, text));
        }
    }
}

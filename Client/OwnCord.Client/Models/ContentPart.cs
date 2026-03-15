using System;
using System.Collections.Generic;

namespace OwnCord.Client.Models;

public sealed class ContentPart
{
    public bool IsCode { get; }
    public string Text { get; }
    public string? Language { get; }

    public ContentPart(string text, bool isCode = false, string? language = null)
    {
        Text = text;
        IsCode = isCode;
        Language = language;
    }

    /// <summary>Parse message content into text and code block segments.</summary>
    public static IReadOnlyList<ContentPart> Parse(string content)
    {
        var parts = new List<ContentPart>();
        var remaining = content;

        while (remaining.Length > 0)
        {
            var fenceStart = remaining.IndexOf("```", StringComparison.Ordinal);
            if (fenceStart < 0)
            {
                if (remaining.Length > 0)
                    parts.Add(new ContentPart(remaining));
                break;
            }

            // Add text before the code block
            if (fenceStart > 0)
                parts.Add(new ContentPart(remaining[..fenceStart]));

            // Find the language hint (rest of the line after ```)
            var afterFence = remaining[(fenceStart + 3)..];
            var langEnd = afterFence.IndexOf('\n');
            string? language = null;

            if (langEnd >= 0)
            {
                var langHint = afterFence[..langEnd].Trim();
                if (langHint.Length > 0 && langHint.Length < 20)
                    language = langHint;
                afterFence = afterFence[(langEnd + 1)..];
            }

            // Find closing ```
            var fenceEnd = afterFence.IndexOf("```", StringComparison.Ordinal);
            if (fenceEnd >= 0)
            {
                var code = afterFence[..fenceEnd];
                // Remove trailing newline from code if present
                if (code.EndsWith('\n'))
                    code = code[..^1];
                parts.Add(new ContentPart(code, isCode: true, language: language));
                remaining = afterFence[(fenceEnd + 3)..];
            }
            else
            {
                // No closing fence — treat rest as code
                var code = afterFence;
                if (code.EndsWith('\n'))
                    code = code[..^1];
                parts.Add(new ContentPart(code, isCode: true, language: language));
                break;
            }
        }

        // If no parts were created, return the original content as a single text part
        if (parts.Count == 0)
            parts.Add(new ContentPart(content));

        return parts;
    }
}

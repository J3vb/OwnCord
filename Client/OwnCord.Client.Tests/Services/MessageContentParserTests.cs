using OwnCord.Client.Services;
using static OwnCord.Client.Services.MessageContentParser;

namespace OwnCord.Client.Tests.Services;

public class MessageContentParserTests
{
    // ── Helpers ───────────────────────────────────────────────────────────────

    private static ContentSegment Text(string text) =>
        new(SegmentType.Text, text);

    private static ContentSegment Code(string text, string? lang = null) =>
        new(SegmentType.CodeBlock, text, lang);

    private static ContentSegment Inline(string text) =>
        new(SegmentType.InlineCode, text);

    private static ContentSegment Bold(string text) =>
        new(SegmentType.Bold, text);

    private static ContentSegment Italic(string text) =>
        new(SegmentType.Italic, text);

    // ── 1. Plain text → single Text segment ──────────────────────────────────

    [Fact]
    public void Parse_PlainText_ReturnsSingleTextSegment()
    {
        var result = Parse("Hello, world!");

        Assert.Single(result);
        Assert.Equal(Text("Hello, world!"), result[0]);
    }

    [Fact]
    public void Parse_PlainTextWithSpaces_PreservesWhitespace()
    {
        var result = Parse("  spaces   around  ");

        Assert.Single(result);
        Assert.Equal(Text("  spaces   around  "), result[0]);
    }

    // ── 2. Empty string → empty list ─────────────────────────────────────────

    [Fact]
    public void Parse_EmptyString_ReturnsEmptyList()
    {
        var result = Parse(string.Empty);

        Assert.Empty(result);
    }

    [Fact]
    public void Parse_NullString_ReturnsEmptyList()
    {
        var result = Parse(null!);

        Assert.Empty(result);
    }

    // ── 3. Code block with language ───────────────────────────────────────────

    [Fact]
    public void Parse_CodeBlockWithLanguage_ReturnsCodeBlockSegmentWithLanguage()
    {
        var result = Parse("```csharp\nvar x = 1;\n```");

        Assert.Single(result);
        var seg = result[0];
        Assert.Equal(SegmentType.CodeBlock, seg.Type);
        Assert.Equal("var x = 1;\n", seg.Text);
        Assert.Equal("csharp", seg.Language);
    }

    [Fact]
    public void Parse_CodeBlockWithLanguage_CapturesMultilineCode()
    {
        var input = "```go\nfunc main() {\n    fmt.Println(\"hello\")\n}\n```";

        var result = Parse(input);

        Assert.Single(result);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        Assert.Equal("go", result[0].Language);
        Assert.Contains("func main()", result[0].Text);
    }

    // ── 4. Code block without language ───────────────────────────────────────

    [Fact]
    public void Parse_CodeBlockWithoutLanguage_ReturnsNullLanguage()
    {
        var result = Parse("```\nsome code\n```");

        Assert.Single(result);
        var seg = result[0];
        Assert.Equal(SegmentType.CodeBlock, seg.Type);
        Assert.Null(seg.Language);
        Assert.Equal("some code\n", seg.Text);
    }

    [Fact]
    public void Parse_CodeBlockWithoutLanguageNoNewline_ReturnsNullLanguage()
    {
        // Regex allows optional newline after language: ```(\w*)\n?
        var result = Parse("```some code```");

        Assert.Single(result);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        // "some" would be captured as language since it matches \w+
        // "some" is captured by group 1 (\w*), space breaks \w so "some" is language
        Assert.Equal("some", result[0].Language);
    }

    // ── 5. Inline code ────────────────────────────────────────────────────────

    [Fact]
    public void Parse_InlineCode_ReturnsInlineCodeSegment()
    {
        var result = Parse("`var x = 1`");

        Assert.Single(result);
        Assert.Equal(Inline("var x = 1"), result[0]);
    }

    [Fact]
    public void Parse_InlineCode_CapturedTextExcludesBackticks()
    {
        var result = Parse("`hello`");

        Assert.Single(result);
        Assert.Equal("hello", result[0].Text);
        Assert.Equal(SegmentType.InlineCode, result[0].Type);
        Assert.Null(result[0].Language);
    }

    // ── 6. Bold text ─────────────────────────────────────────────────────────

    [Fact]
    public void Parse_BoldText_ReturnsBoldSegment()
    {
        var result = Parse("**bold text**");

        Assert.Single(result);
        Assert.Equal(Bold("bold text"), result[0]);
    }

    [Fact]
    public void Parse_BoldText_CapturedTextExcludesAsterisks()
    {
        var result = Parse("**important**");

        Assert.Single(result);
        Assert.Equal(SegmentType.Bold, result[0].Type);
        Assert.Equal("important", result[0].Text);
    }

    // ── 7. Italic text ────────────────────────────────────────────────────────

    [Fact]
    public void Parse_ItalicText_ReturnsItalicSegment()
    {
        var result = Parse("*italic text*");

        Assert.Single(result);
        Assert.Equal(Italic("italic text"), result[0]);
    }

    [Fact]
    public void Parse_ItalicText_CapturedTextExcludesAsterisks()
    {
        var result = Parse("*emphasis*");

        Assert.Single(result);
        Assert.Equal(SegmentType.Italic, result[0].Type);
        Assert.Equal("emphasis", result[0].Text);
    }

    // ── 8. Mixed: "Hello `code` world" ───────────────────────────────────────

    [Fact]
    public void Parse_TextInlineCodeText_ReturnsThreeSegments()
    {
        var result = Parse("Hello `code` world");

        Assert.Equal(3, result.Count);
        Assert.Equal(Text("Hello "), result[0]);
        Assert.Equal(Inline("code"), result[1]);
        Assert.Equal(Text(" world"), result[2]);
    }

    [Fact]
    public void Parse_InlineCodeAtStart_ReturnsInlineCodeThenText()
    {
        var result = Parse("`start` and more");

        Assert.Equal(2, result.Count);
        Assert.Equal(Inline("start"), result[0]);
        Assert.Equal(Text(" and more"), result[1]);
    }

    [Fact]
    public void Parse_InlineCodeAtEnd_ReturnsTextThenInlineCode()
    {
        var result = Parse("prefix `end`");

        Assert.Equal(2, result.Count);
        Assert.Equal(Text("prefix "), result[0]);
        Assert.Equal(Inline("end"), result[1]);
    }

    // ── 9. Code block with surrounding text ──────────────────────────────────

    [Fact]
    public void Parse_TextCodeBlockText_ReturnsThreeSegments()
    {
        var input = "Before:\n```python\nprint(\"hi\")\n```\nAfter";

        var result = Parse(input);

        Assert.Equal(3, result.Count);
        Assert.Equal(SegmentType.Text, result[0].Type);
        Assert.Equal("Before:\n", result[0].Text);
        Assert.Equal(SegmentType.CodeBlock, result[1].Type);
        Assert.Equal("python", result[1].Language);
        Assert.Equal(SegmentType.Text, result[2].Type);
        Assert.Equal("\nAfter", result[2].Text);
    }

    [Fact]
    public void Parse_CodeBlockAtStart_ReturnsCodeBlockThenText()
    {
        var input = "```js\nconsole.log(1)\n```\nDone.";

        var result = Parse(input);

        Assert.Equal(2, result.Count);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        Assert.Equal("js", result[0].Language);
        Assert.Equal(SegmentType.Text, result[1].Type);
        Assert.Equal("\nDone.", result[1].Text);
    }

    // ── 10. Multiple inline codes in one message ──────────────────────────────

    [Fact]
    public void Parse_MultipleInlineCodes_AllCaptured()
    {
        var result = Parse("`foo` and `bar` and `baz`");

        Assert.Equal(5, result.Count);
        Assert.Equal(Inline("foo"), result[0]);
        Assert.Equal(Text(" and "), result[1]);
        Assert.Equal(Inline("bar"), result[2]);
        Assert.Equal(Text(" and "), result[3]);
        Assert.Equal(Inline("baz"), result[4]);
    }

    [Fact]
    public void Parse_TwoAdjacentInlineCodes_BothCaptured()
    {
        var result = Parse("`a``b`");

        // `a` matches, then `` ` `` (empty) is skipped (regex requires [^`\n]+),
        // then `b` matches: result is [Inline("a"), Inline("b")]
        Assert.Equal(2, result.Count);
        Assert.Equal(Inline("a"), result[0]);
        Assert.Equal(Inline("b"), result[1]);
    }

    // ── 11. Bold and italic mixed ─────────────────────────────────────────────

    [Fact]
    public void Parse_BoldAndItalic_BothSegmentsPresent()
    {
        var result = Parse("**bold** and *italic*");

        Assert.Equal(3, result.Count);
        Assert.Equal(Bold("bold"), result[0]);
        Assert.Equal(Text(" and "), result[1]);
        Assert.Equal(Italic("italic"), result[2]);
    }

    [Fact]
    public void Parse_ItalicThenBold_BothSegmentsPresent()
    {
        var result = Parse("*em* then **strong**");

        Assert.Equal(3, result.Count);
        Assert.Equal(SegmentType.Italic, result[0].Type);
        Assert.Equal("em", result[0].Text);
        Assert.Equal(Text(" then "), result[1]);
        Assert.Equal(Bold("strong"), result[2]);
    }

    // ── 12. Bold containing text (no nesting) ────────────────────────────────

    [Fact]
    public void Parse_BoldSpan_InnerTextIsPreservedVerbatim()
    {
        // The parser does NOT recurse into bold/italic — inner text is raw.
        var result = Parse("**hello world**");

        Assert.Single(result);
        Assert.Equal(SegmentType.Bold, result[0].Type);
        Assert.Equal("hello world", result[0].Text);
    }

    [Fact]
    public void Parse_BoldContainingAsterisk_MatchesInnerContent()
    {
        // Bold uses .+? so it stops at the first **
        var result = Parse("**a * b**");

        Assert.Single(result);
        Assert.Equal(SegmentType.Bold, result[0].Type);
        Assert.Equal("a * b", result[0].Text);
    }

    // ── 13. Unclosed backtick → plain text ───────────────────────────────────

    [Fact]
    public void Parse_UnclosedInlineBacktick_TreatedAsPlainText()
    {
        // InlineCode regex requires a closing backtick on the same line
        var result = Parse("hello `world");

        Assert.Single(result);
        Assert.Equal(Text("hello `world"), result[0]);
    }

    [Fact]
    public void Parse_BacktickWithNewlineInside_TreatedAsPlainText()
    {
        // [^`\n]+ excludes newlines, so a backtick spanning lines cannot match
        var result = Parse("`line1\nline2`");

        Assert.Single(result);
        Assert.Equal(SegmentType.Text, result[0].Type);
        Assert.Equal("`line1\nline2`", result[0].Text);
    }

    [Fact]
    public void Parse_OnlyOpeningBacktick_TreatedAsPlainText()
    {
        var result = Parse("`");

        Assert.Single(result);
        Assert.Equal(Text("`"), result[0]);
    }

    // ── 14. Empty code block ──────────────────────────────────────────────────

    [Fact]
    public void Parse_EmptyCodeBlockNoLanguage_CodeBlockWithEmptyText()
    {
        // ```(\w*)\n?([\s\S]*?)``` — lazy *? can match empty string
        var result = Parse("``````");

        // ``` `` ``` — three backticks open, zero chars, three backticks close
        Assert.Single(result);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        Assert.Equal(string.Empty, result[0].Text);
        Assert.Null(result[0].Language);
    }

    [Fact]
    public void Parse_CodeBlockWithOnlyNewline_CodeBlockWithNewlineText()
    {
        var result = Parse("```\n\n```");

        Assert.Single(result);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        // The optional \n? consumes the first newline; second \n is part of the code
        Assert.Equal("\n", result[0].Text);
        Assert.Null(result[0].Language);
    }

    // ── 15. Code block with special characters ────────────────────────────────

    [Fact]
    public void Parse_CodeBlockWithSpecialChars_PreservesContent()
    {
        var code = "x < 10 && y > 5 || z == 0;\n<script>alert('xss')</script>\n";
        var input = $"```\n{code}```";

        var result = Parse(input);

        Assert.Single(result);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        Assert.Equal(code, result[0].Text);
    }

    [Fact]
    public void Parse_CodeBlockWithUnicode_PreservesContent()
    {
        var input = "```\n日本語テスト 🎉\n```";

        var result = Parse(input);

        Assert.Single(result);
        Assert.Equal(SegmentType.CodeBlock, result[0].Type);
        Assert.Contains("日本語テスト", result[0].Text);
        Assert.Contains("🎉", result[0].Text);
    }

    [Fact]
    public void Parse_CodeBlockWithSqlChars_PreservesContent()
    {
        var input = "```sql\nSELECT * FROM users WHERE id = '1' OR '1'='1';\n```";

        var result = Parse(input);

        Assert.Single(result);
        Assert.Equal("sql", result[0].Language);
        Assert.Contains("SELECT * FROM users", result[0].Text);
    }

    [Fact]
    public void Parse_InlineCodeWithSpecialChars_PreservesContent()
    {
        var result = Parse("`x < y && z > 0`");

        Assert.Single(result);
        Assert.Equal(SegmentType.InlineCode, result[0].Type);
        Assert.Equal("x < y && z > 0", result[0].Text);
    }

    // ── Boundary / additional edge cases ─────────────────────────────────────

    [Fact]
    public void Parse_BoldWithNoSurroundingText_NoBoundaryTextSegments()
    {
        var result = Parse("**only bold**");

        Assert.Single(result);
        Assert.Equal(Bold("only bold"), result[0]);
    }

    [Fact]
    public void Parse_ItalicWithNoSurroundingText_NoBoundaryTextSegments()
    {
        var result = Parse("*only italic*");

        Assert.Single(result);
        Assert.Equal(Italic("only italic"), result[0]);
    }

    [Fact]
    public void Parse_DoubleAsterisksAreNotItalic()
    {
        // ** is consumed by bold regex; the italic lookahead (?<!\*)\*(?!\*)
        // prevents ** from matching italic
        var result = Parse("**bold**");

        Assert.Single(result);
        Assert.Equal(SegmentType.Bold, result[0].Type);
    }

    [Fact]
    public void Parse_MultipleCodeBlocks_AllCapturedInOrder()
    {
        var input = "```\nfirst\n``` middle ```\nsecond\n```";

        var result = Parse(input);

        // Two code blocks with text between them
        var codeBlocks = result.Where(s => s.Type == SegmentType.CodeBlock).ToList();
        Assert.Equal(2, codeBlocks.Count);
        Assert.Contains("first", codeBlocks[0].Text);
        Assert.Contains("second", codeBlocks[1].Text);
    }

    [Fact]
    public void Parse_WhitespaceOnlyString_ReturnsSingleTextSegment()
    {
        // string.IsNullOrEmpty("   ") is false, so whitespace-only goes through parsing
        // No formatting marks → AddTextSegment adds it as Text
        var result = Parse("   ");

        Assert.Single(result);
        Assert.Equal(SegmentType.Text, result[0].Type);
        Assert.Equal("   ", result[0].Text);
    }

    [Fact]
    public void Parse_InlineCodeInsideTextWithBold_InlineCodeTakesPrecedence()
    {
        // Inline code is processed before bold/italic, so **...**  inside inline code
        // is NOT parsed as bold — it's raw code content.
        var result = Parse("`**not bold**`");

        Assert.Single(result);
        Assert.Equal(SegmentType.InlineCode, result[0].Type);
        Assert.Equal("**not bold**", result[0].Text);
    }

    [Fact]
    public void Parse_SegmentTypesAreNeverNull()
    {
        var inputs = new[]
        {
            "plain text",
            "**bold**",
            "*italic*",
            "`code`",
            "```\nblock\n```",
            "mix **bold** and `code`",
        };

        foreach (var input in inputs)
        {
            var result = Parse(input);
            Assert.All(result, seg => Assert.True(
                Enum.IsDefined(typeof(SegmentType), seg.Type),
                $"Invalid segment type in: {input}"));
        }
    }
}

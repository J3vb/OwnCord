using System.Globalization;
using System.Windows;
using System.Windows.Media;
using OwnCord.Client.Converters;
using OwnCord.Client.Models;

namespace OwnCord.Client.Tests.Converters;

public class FirstCharConverterTests
{
    private readonly FirstCharConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Theory]
    [InlineData("hello", "H")]
    [InlineData("World", "W")]
    [InlineData("a", "A")]
    [InlineData("123", "1")]
    public void Convert_ReturnsFirstCharUppercased(string input, string expected)
    {
        var result = _converter.Convert(input, typeof(string), null!, _culture);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void Convert_EmptyString_ReturnsQuestionMark()
    {
        var result = _converter.Convert("", typeof(string), null!, _culture);
        Assert.Equal("?", result);
    }

    [Fact]
    public void Convert_Null_ReturnsQuestionMark()
    {
        var result = _converter.Convert(null, typeof(string), null!, _culture);
        Assert.Equal("?", result);
    }

    [Fact]
    public void Convert_NonString_ReturnsQuestionMark()
    {
        var result = _converter.Convert(42, typeof(string), null!, _culture);
        Assert.Equal("?", result);
    }

    [Fact]
    public void ConvertBack_ThrowsNotSupported()
    {
        Assert.Throws<NotSupportedException>(() =>
            _converter.ConvertBack("H", typeof(string), null!, _culture));
    }
}

public class FirstLetterConverterTests
{
    private readonly FirstLetterConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Theory]
    [InlineData("alice", "A")]
    [InlineData("Bob", "B")]
    public void Convert_ReturnsFirstLetterUppercased(string input, string expected)
    {
        var result = _converter.Convert(input, typeof(string), null!, _culture);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void Convert_EmptyString_ReturnsQuestionMark()
    {
        var result = _converter.Convert("", typeof(string), null!, _culture);
        Assert.Equal("?", result);
    }

    [Fact]
    public void Convert_Null_ReturnsQuestionMark()
    {
        var result = _converter.Convert(null, typeof(string), null!, _culture);
        Assert.Equal("?", result);
    }
}

public class RelativeTimeConverterTests
{
    private readonly RelativeTimeConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_JustNow_WithinLastMinute()
    {
        var dt = DateTime.UtcNow.AddSeconds(-30);
        var result = (string)_converter.Convert(dt, typeof(string), null!, _culture);
        Assert.Equal("just now", result);
    }

    [Fact]
    public void Convert_MinutesAgo()
    {
        var dt = DateTime.UtcNow.AddMinutes(-15);
        var result = (string)_converter.Convert(dt, typeof(string), null!, _culture);
        Assert.Equal("15m ago", result);
    }

    [Fact]
    public void Convert_HoursAgo()
    {
        var dt = DateTime.UtcNow.AddHours(-3);
        var result = (string)_converter.Convert(dt, typeof(string), null!, _culture);
        Assert.Equal("3h ago", result);
    }

    [Fact]
    public void Convert_Yesterday()
    {
        var dt = DateTime.UtcNow.AddHours(-30);
        var result = (string)_converter.Convert(dt, typeof(string), null!, _culture);
        Assert.Equal("yesterday", result);
    }

    [Fact]
    public void Convert_DaysAgo()
    {
        var dt = DateTime.UtcNow.AddDays(-4);
        var result = (string)_converter.Convert(dt, typeof(string), null!, _culture);
        Assert.Equal("4d ago", result);
    }

    [Fact]
    public void Convert_OlderThanWeek_ReturnsFormattedDate()
    {
        var dt = DateTime.UtcNow.AddDays(-30);
        var result = (string)_converter.Convert(dt, typeof(string), null!, _culture);
        // Should be formatted like "Feb 13" (month abbrev + day)
        Assert.Matches(@"^[A-Z][a-z]{2} \d{1,2}$", result);
    }

    [Fact]
    public void Convert_NonDateTime_ReturnsNever()
    {
        var result = _converter.Convert("not a date", typeof(string), null!, _culture);
        Assert.Equal("never", result);
    }

    [Fact]
    public void Convert_Null_ReturnsNever()
    {
        var result = _converter.Convert(null, typeof(string), null!, _culture);
        Assert.Equal("never", result);
    }

    [Fact]
    public void ConvertBack_ThrowsNotSupported()
    {
        Assert.Throws<NotSupportedException>(() =>
            _converter.ConvertBack("just now", typeof(DateTime?), null!, _culture));
    }
}

public class ColorToBrushConverterTests
{
    private readonly ColorToBrushConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_ValidHex_ReturnsBrush()
    {
        var result = _converter.Convert("#ff0000", typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Colors.Red, brush.Color);
    }

    [Fact]
    public void Convert_Null_ReturnsFallbackBlurple()
    {
        var result = _converter.Convert(null, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Color.FromRgb(0x58, 0x65, 0xF2), brush.Color);
    }

    [Fact]
    public void Convert_ShortString_ReturnsFallback()
    {
        var result = _converter.Convert("#fff", typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Color.FromRgb(0x58, 0x65, 0xF2), brush.Color);
    }

    [Fact]
    public void Convert_InvalidHex_ReturnsFallback()
    {
        var result = _converter.Convert("#zzzzzz", typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Color.FromRgb(0x58, 0x65, 0xF2), brush.Color);
    }

    [Fact]
    public void ConvertBack_ThrowsNotSupported()
    {
        Assert.Throws<NotSupportedException>(() =>
            _converter.ConvertBack(new SolidColorBrush(), typeof(string), null!, _culture));
    }
}

public class HexColorToBrushConverterTests
{
    private readonly HexColorToBrushConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_ValidHex_ReturnsBrush()
    {
        var result = _converter.Convert("#00ff00", typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Color.FromRgb(0, 255, 0), brush.Color);
    }

    [Fact]
    public void Convert_NoHashPrefix_ReturnsFallback()
    {
        var result = _converter.Convert("ff0000", typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        // Fallback is #949ba4
        Assert.Equal(Color.FromRgb(0x94, 0x9B, 0xA4), brush.Color);
    }

    [Fact]
    public void Convert_Null_ReturnsFallback()
    {
        var result = _converter.Convert(null, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Color.FromRgb(0x94, 0x9B, 0xA4), brush.Color);
    }
}

public class HostPortConverterTests
{
    private readonly HostPortConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_DefaultPort_ReturnsHostOnly()
    {
        var result = _converter.Convert(
            new object[] { "example.com", 8443 }, typeof(string), null!, _culture);
        Assert.Equal("example.com", result);
    }

    [Fact]
    public void Convert_CustomPort_ReturnsHostColon()
    {
        var result = _converter.Convert(
            new object[] { "example.com", 9090 }, typeof(string), null!, _culture);
        Assert.Equal("example.com:9090", result);
    }

    [Fact]
    public void Convert_NullHost_ReturnsEmptyWithPort()
    {
        var result = _converter.Convert(
            new object[] { null!, 9090 }, typeof(string), null!, _culture);
        Assert.Equal(":9090", result);
    }

    [Fact]
    public void Convert_SingleValue_DefaultsPort8443()
    {
        var result = _converter.Convert(
            new object[] { "example.com" }, typeof(string), null!, _culture);
        Assert.Equal("example.com", result);
    }

    [Fact]
    public void ConvertBack_ThrowsNotSupported()
    {
        Assert.Throws<NotSupportedException>(() =>
            _converter.ConvertBack("x", new[] { typeof(string) }, null!, _culture));
    }
}

public class BoolToVisibilityConverterTests
{
    private readonly BoolToVisibilityConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_True_ReturnsVisible()
    {
        var result = _converter.Convert(true, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Visible, result);
    }

    [Fact]
    public void Convert_False_ReturnsCollapsed()
    {
        var result = _converter.Convert(false, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Collapsed, result);
    }

    [Fact]
    public void ConvertBack_Visible_ReturnsTrue()
    {
        var result = _converter.ConvertBack(Visibility.Visible, typeof(bool), null!, _culture);
        Assert.Equal(true, result);
    }

    [Fact]
    public void ConvertBack_Collapsed_ReturnsFalse()
    {
        var result = _converter.ConvertBack(Visibility.Collapsed, typeof(bool), null!, _culture);
        Assert.Equal(false, result);
    }
}

public class InverseBoolToVisibilityConverterTests
{
    private readonly InverseBoolToVisibilityConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_True_ReturnsCollapsed()
    {
        var result = _converter.Convert(true, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Collapsed, result);
    }

    [Fact]
    public void Convert_False_ReturnsVisible()
    {
        var result = _converter.Convert(false, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Visible, result);
    }

    [Fact]
    public void ConvertBack_Collapsed_ReturnsTrue()
    {
        var result = _converter.ConvertBack(Visibility.Collapsed, typeof(bool), null!, _culture);
        Assert.Equal(true, result);
    }
}

public class IntToVisibilityConverterTests
{
    private readonly IntToVisibilityConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_PositiveInt_ReturnsVisible()
    {
        var result = _converter.Convert(5, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Visible, result);
    }

    [Fact]
    public void Convert_Zero_ReturnsCollapsed()
    {
        var result = _converter.Convert(0, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Collapsed, result);
    }

    [Fact]
    public void Convert_NegativeInt_ReturnsCollapsed()
    {
        var result = _converter.Convert(-1, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Collapsed, result);
    }

    [Fact]
    public void Convert_NonInt_ReturnsCollapsed()
    {
        var result = _converter.Convert("not an int", typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Collapsed, result);
    }
}

public class NullToVisibilityConverterTests
{
    private readonly NullToVisibilityConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_NonNull_ReturnsVisible()
    {
        var result = _converter.Convert("something", typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Visible, result);
    }

    [Fact]
    public void Convert_Null_ReturnsCollapsed()
    {
        var result = _converter.Convert(null, typeof(Visibility), null!, _culture);
        Assert.Equal(Visibility.Collapsed, result);
    }
}

public class InverseBoolConverterTests
{
    private readonly InverseBoolConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_True_ReturnsFalse()
    {
        var result = _converter.Convert(true, typeof(bool), null!, _culture);
        Assert.Equal(false, result);
    }

    [Fact]
    public void Convert_False_ReturnsTrue()
    {
        var result = _converter.Convert(false, typeof(bool), null!, _culture);
        Assert.Equal(true, result);
    }

    [Fact]
    public void ConvertBack_True_ReturnsFalse()
    {
        var result = _converter.ConvertBack(true, typeof(bool), null!, _culture);
        Assert.Equal(false, result);
    }
}

public class StatusToBrushConverterTests
{
    private readonly StatusToBrushConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_Online_ReturnsGreen()
    {
        var result = _converter.Convert(UserStatus.Online, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#23a55a"), brush.Color);
    }

    [Fact]
    public void Convert_Idle_ReturnsYellow()
    {
        var result = _converter.Convert(UserStatus.Idle, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#f0b232"), brush.Color);
    }

    [Fact]
    public void Convert_Dnd_ReturnsRed()
    {
        var result = _converter.Convert(UserStatus.Dnd, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#f23f43"), brush.Color);
    }

    [Fact]
    public void Convert_Offline_ReturnsGray()
    {
        var result = _converter.Convert(UserStatus.Offline, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#6d6f78"), brush.Color);
    }
}

public class BoolToRedBrushConverterTests
{
    private readonly BoolToRedBrushConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_True_ReturnsRed()
    {
        var result = _converter.Convert(true, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#f23f43"), brush.Color);
    }

    [Fact]
    public void Convert_False_ReturnsNormal()
    {
        var result = _converter.Convert(false, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#b5bac1"), brush.Color);
    }
}

public class SpeakingToStrokeBrushConverterTests
{
    private readonly SpeakingToStrokeBrushConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_True_ReturnsGreen()
    {
        var result = _converter.Convert(true, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal((Color)ColorConverter.ConvertFromString("#23a55a"), brush.Color);
    }

    [Fact]
    public void Convert_False_ReturnsTransparent()
    {
        var result = _converter.Convert(false, typeof(SolidColorBrush), null!, _culture);
        var brush = Assert.IsType<SolidColorBrush>(result);
        Assert.Equal(Colors.Transparent, brush.Color);
    }
}

public class BoolToArrowConverterTests
{
    private readonly BoolToArrowConverter _converter = new();
    private readonly CultureInfo _culture = CultureInfo.InvariantCulture;

    [Fact]
    public void Convert_True_ReturnsDownArrow()
    {
        var result = _converter.Convert(true, typeof(string), null!, _culture);
        Assert.Equal("\u25BE", result); // ▾
    }

    [Fact]
    public void Convert_False_ReturnsRightArrow()
    {
        var result = _converter.Convert(false, typeof(string), null!, _culture);
        Assert.Equal("\u25B8", result); // ▸
    }

    [Fact]
    public void ConvertBack_ThrowsNotSupported()
    {
        Assert.Throws<NotSupportedException>(() =>
            _converter.ConvertBack("▾", typeof(bool), null!, _culture));
    }
}

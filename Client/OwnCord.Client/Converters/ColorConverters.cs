using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;

namespace OwnCord.Client.Converters;

/// <summary>Converts a hex color string (#rrggbb) to a SolidColorBrush.</summary>
[ValueConversion(typeof(string), typeof(SolidColorBrush))]
public sealed class HexColorToBrushConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is string hex && hex.StartsWith('#') && hex.Length >= 7)
        {
            try
            {
                var color = (Color)ColorConverter.ConvertFromString(hex);
                return new SolidColorBrush(color);
            }
            catch
            {
                // Fall through to default
            }
        }

        // Default fallback color (muted text)
        return new SolidColorBrush((Color)ColorConverter.ConvertFromString("#949ba4"));
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>Converts a UserStatus enum to the corresponding status dot color brush.</summary>
[ValueConversion(typeof(string), typeof(SolidColorBrush))]
public sealed class StatusToBrushConverter : IValueConverter
{
    private static readonly SolidColorBrush Online = new((Color)ColorConverter.ConvertFromString("#23a55a"));
    private static readonly SolidColorBrush Idle = new((Color)ColorConverter.ConvertFromString("#f0b232"));
    private static readonly SolidColorBrush Dnd = new((Color)ColorConverter.ConvertFromString("#f23f43"));
    private static readonly SolidColorBrush Offline = new((Color)ColorConverter.ConvertFromString("#6d6f78"));

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        return value switch
        {
            Models.UserStatus.Online => Online,
            Models.UserStatus.Idle => Idle,
            Models.UserStatus.Dnd => Dnd,
            _ => Offline
        };
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>Gets the first letter of a string (for avatar circle initials).</summary>
[ValueConversion(typeof(string), typeof(string))]
public sealed class FirstLetterConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => value is string s && s.Length > 0 ? s[0].ToString().ToUpperInvariant() : "?";

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>Converts a bool to a Foreground color (red when true, muted when false).</summary>
[ValueConversion(typeof(bool), typeof(SolidColorBrush))]
public sealed class BoolToRedBrushConverter : IValueConverter
{
    private static readonly SolidColorBrush Red = new((Color)ColorConverter.ConvertFromString("#f23f43"));
    private static readonly SolidColorBrush Normal = new((Color)ColorConverter.ConvertFromString("#b5bac1"));

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is true ? Red : Normal;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>Converts a bool speaking state to a green or transparent stroke brush.</summary>
[ValueConversion(typeof(bool), typeof(SolidColorBrush))]
public sealed class SpeakingToStrokeBrushConverter : IValueConverter
{
    private static readonly SolidColorBrush Speaking = new((Color)ColorConverter.ConvertFromString("#23a55a"));
    private static readonly SolidColorBrush Silent = new(Colors.Transparent);

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is true ? Speaking : Silent;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>Converts a boolean expand state to an arrow character.</summary>
[ValueConversion(typeof(bool), typeof(string))]
public sealed class BoolToArrowConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
        => value is true ? "\u25BE" : "\u25B8"; // ▾ or ▸

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

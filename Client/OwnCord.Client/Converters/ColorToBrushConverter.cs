using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;

namespace OwnCord.Client.Converters;

/// <summary>Converts a hex color string like "#5865f2" to a SolidColorBrush.</summary>
[ValueConversion(typeof(string), typeof(SolidColorBrush))]
public sealed class ColorToBrushConverter : IValueConverter
{
    private static readonly SolidColorBrush Fallback = new(Color.FromRgb(0x58, 0x65, 0xF2));

    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not string hex || hex.Length < 7)
            return Fallback;

        try
        {
            var color = (Color)ColorConverter.ConvertFromString(hex);
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            return brush;
        }
        catch
        {
            return Fallback;
        }
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

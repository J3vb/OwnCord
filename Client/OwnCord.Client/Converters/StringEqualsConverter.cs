using System.Globalization;
using System.Windows.Data;

namespace OwnCord.Client.Converters;

/// <summary>
/// Returns true when the bound string value equals the converter parameter (case-insensitive).
/// Useful for highlighting the active tab in a tab bar.
/// </summary>
[ValueConversion(typeof(string), typeof(bool))]
public sealed class StringEqualsConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is string s && parameter is string p
           && string.Equals(s, p, StringComparison.OrdinalIgnoreCase);

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

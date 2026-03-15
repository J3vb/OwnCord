using System.Globalization;
using System.Windows.Data;

namespace OwnCord.Client.Converters;

/// <summary>Returns the first character of a string, uppercased.</summary>
[ValueConversion(typeof(string), typeof(string))]
public sealed class FirstCharConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not string s || s.Length == 0)
            return "?";
        return char.ToUpperInvariant(s[0]).ToString();
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

using System.Globalization;
using System.Windows.Data;

namespace OwnCord.Client.Converters;

/// <summary>
/// IMultiValueConverter that returns true when the first two bound values are equal strings.
/// Used with MultiBinding to compare two dynamic properties (e.g. Tag vs SelectedSection).
/// </summary>
public sealed class EqualityConverter : IMultiValueConverter
{
    public object Convert(object[] values, Type targetType, object parameter, CultureInfo culture)
    {
        if (values.Length < 2) return false;
        var a = values[0]?.ToString();
        var b = values[1]?.ToString();
        return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    }

    public object[] ConvertBack(object value, Type[] targetTypes, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

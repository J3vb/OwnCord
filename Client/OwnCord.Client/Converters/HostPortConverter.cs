using System.Globalization;
using System.Windows.Data;

namespace OwnCord.Client.Converters;

/// <summary>Combines Host and Port into a display string. Used as a multi-value converter.</summary>
public sealed class HostPortConverter : IMultiValueConverter
{
    public object Convert(object[] values, Type targetType, object parameter, CultureInfo culture)
    {
        var host = values[0] as string ?? "";
        var port = values.Length > 1 && values[1] is int p ? p : 8443;
        return port == 8443 ? host : $"{host}:{port}";
    }

    public object[] ConvertBack(object value, Type[] targetTypes, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;

namespace OwnCord.Client.Converters;

/// <summary>
/// Converts a health status string to a SolidColorBrush for the status indicator dot.
/// "online" = Green, "checking" = Yellow, "offline" = Red, "unknown"/other = Gray.
/// </summary>
public sealed class HealthStatusToBrushConverter : IValueConverter
{
    private static readonly SolidColorBrush OnlineBrush = new(Color.FromRgb(0x23, 0xa5, 0x5a));
    private static readonly SolidColorBrush CheckingBrush = new(Color.FromRgb(0xf0, 0xb2, 0x32));
    private static readonly SolidColorBrush OfflineBrush = new(Color.FromRgb(0xf2, 0x3f, 0x43));
    private static readonly SolidColorBrush UnknownBrush = new(Color.FromRgb(0x6d, 0x6f, 0x78));

    static HealthStatusToBrushConverter()
    {
        OnlineBrush.Freeze();
        CheckingBrush.Freeze();
        OfflineBrush.Freeze();
        UnknownBrush.Freeze();
    }

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        return (value as string) switch
        {
            "online" => OnlineBrush,
            "checking" => CheckingBrush,
            "offline" => OfflineBrush,
            _ => UnknownBrush
        };
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

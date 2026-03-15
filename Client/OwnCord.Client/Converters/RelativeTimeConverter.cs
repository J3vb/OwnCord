using System.Globalization;
using System.Windows.Data;

namespace OwnCord.Client.Converters;

/// <summary>Converts a DateTime? to a human-readable relative time string.</summary>
[ValueConversion(typeof(DateTime?), typeof(string))]
public sealed class RelativeTimeConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not DateTime dt)
            return "never";

        var span = DateTime.UtcNow - dt.ToUniversalTime();

        return span.TotalSeconds switch
        {
            < 60 => "just now",
            < 3600 => $"{(int)span.TotalMinutes}m ago",
            < 86400 => $"{(int)span.TotalHours}h ago",
            < 172800 => "yesterday",
            < 604800 => $"{(int)span.TotalDays}d ago",
            _ => dt.ToLocalTime().ToString("MMM d", culture)
        };
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

using System.Windows;
using System.Windows.Controls;
using OwnCord.Client.Models;

namespace OwnCord.Client.Converters;

public sealed class ContentPartTemplateSelector : DataTemplateSelector
{
    public DataTemplate? TextTemplate { get; set; }
    public DataTemplate? CodeTemplate { get; set; }

    public override DataTemplate? SelectTemplate(object item, DependencyObject container)
    {
        if (item is ContentPart part)
            return part.IsCode ? CodeTemplate : TextTemplate;
        return base.SelectTemplate(item, container);
    }
}

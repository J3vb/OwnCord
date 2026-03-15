using System.Collections;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;

namespace OwnCord.Client.Controls;

public partial class ServerStripControl : UserControl
{
    public static readonly DependencyProperty ServersProperty =
        DependencyProperty.Register(
            nameof(Servers),
            typeof(IEnumerable),
            typeof(ServerStripControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty SelectedServerProperty =
        DependencyProperty.Register(
            nameof(SelectedServer),
            typeof(object),
            typeof(ServerStripControl),
            new PropertyMetadata(null, OnSelectedServerChanged));

    public static readonly DependencyProperty SelectServerCommandProperty =
        DependencyProperty.Register(
            nameof(SelectServerCommand),
            typeof(ICommand),
            typeof(ServerStripControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty AddServerCommandProperty =
        DependencyProperty.Register(
            nameof(AddServerCommand),
            typeof(ICommand),
            typeof(ServerStripControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty HomeCommandProperty =
        DependencyProperty.Register(
            nameof(HomeCommand),
            typeof(ICommand),
            typeof(ServerStripControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty IsHomeViewProperty =
        DependencyProperty.Register(
            nameof(IsHomeView),
            typeof(bool),
            typeof(ServerStripControl),
            new PropertyMetadata(false, OnIsHomeViewChanged));

    public ServerStripControl()
    {
        InitializeComponent();
        Loaded += (_, _) =>
        {
            UpdateActiveIndicators();
            UpdateHomeIndicator();
        };
    }

    public IEnumerable? Servers
    {
        get => (IEnumerable?)GetValue(ServersProperty);
        set => SetValue(ServersProperty, value);
    }

    public object? SelectedServer
    {
        get => GetValue(SelectedServerProperty);
        set => SetValue(SelectedServerProperty, value);
    }

    public ICommand? SelectServerCommand
    {
        get => (ICommand?)GetValue(SelectServerCommandProperty);
        set => SetValue(SelectServerCommandProperty, value);
    }

    public ICommand? AddServerCommand
    {
        get => (ICommand?)GetValue(AddServerCommandProperty);
        set => SetValue(AddServerCommandProperty, value);
    }

    public ICommand? HomeCommand
    {
        get => (ICommand?)GetValue(HomeCommandProperty);
        set => SetValue(HomeCommandProperty, value);
    }

    public bool IsHomeView
    {
        get => (bool)GetValue(IsHomeViewProperty);
        set => SetValue(IsHomeViewProperty, value);
    }

    private static void OnSelectedServerChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is ServerStripControl control)
        {
            control.UpdateActiveIndicators();
            control.UpdateHomeIndicator();
        }
    }

    private static void OnIsHomeViewChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is ServerStripControl control)
        {
            control.UpdateHomeIndicator();
            control.UpdateActiveIndicators();
        }
    }

    private void UpdateActiveIndicators()
    {
        var container = ServerList.ItemContainerGenerator;
        for (int i = 0; i < ServerList.Items.Count; i++)
        {
            var element = container.ContainerFromIndex(i) as FrameworkElement;
            if (element == null) continue;

            var isActive = ServerList.Items[i] == SelectedServer;

            var indicator = FindChild<Rectangle>(element, "Indicator");
            var iconBorder = FindChild<Border>(element, "IconBorder");

            if (indicator != null)
                indicator.Height = isActive ? 36 : 0;
            if (iconBorder != null)
                iconBorder.CornerRadius = isActive ? new CornerRadius(12) : new CornerRadius(24);
        }
    }

    private void UpdateHomeIndicator()
    {
        var indicator = FindChild<Rectangle>(HomeButton, "Indicator");
        var iconBorder = FindChild<Border>(HomeButton, "IconBorder");

        if (indicator != null)
            indicator.Height = IsHomeView ? 36 : 0;
        if (iconBorder != null)
            iconBorder.CornerRadius = IsHomeView ? new CornerRadius(12) : new CornerRadius(24);
    }

    private static T? FindChild<T>(DependencyObject parent, string name) where T : FrameworkElement
    {
        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T fe && fe.Name == name)
                return fe;
            var result = FindChild<T>(child, name);
            if (result != null) return result;
        }
        return null;
    }
}

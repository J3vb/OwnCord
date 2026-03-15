using System.Collections;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

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

    public ServerStripControl()
    {
        InitializeComponent();
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

    private static void OnSelectedServerChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        // Future: update active indicator heights based on which server is selected.
        // The visual active state can be driven by the ViewModel binding the
        // SelectedServer property and comparing in a DataTrigger or multi-binding.
    }
}

using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace OwnCord.Client.Controls;

public partial class SettingsOverlayControl : UserControl
{
    public static readonly DependencyProperty SelectedSectionProperty =
        DependencyProperty.Register(
            nameof(SelectedSection),
            typeof(string),
            typeof(SettingsOverlayControl),
            new PropertyMetadata("My Account"));

    public static readonly DependencyProperty CloseCommandProperty =
        DependencyProperty.Register(
            nameof(CloseCommand),
            typeof(ICommand),
            typeof(SettingsOverlayControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty LogoutCommandProperty =
        DependencyProperty.Register(
            nameof(LogoutCommand),
            typeof(ICommand),
            typeof(SettingsOverlayControl),
            new PropertyMetadata(null));

    public SettingsOverlayControl()
    {
        InitializeComponent();
    }

    public string SelectedSection
    {
        get => (string)GetValue(SelectedSectionProperty);
        set => SetValue(SelectedSectionProperty, value);
    }

    public ICommand CloseCommand
    {
        get => (ICommand)GetValue(CloseCommandProperty);
        set => SetValue(CloseCommandProperty, value);
    }

    public ICommand LogoutCommand
    {
        get => (ICommand)GetValue(LogoutCommandProperty);
        set => SetValue(LogoutCommandProperty, value);
    }

    private void OnSidebarClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is string section)
        {
            SelectedSection = section;
        }
    }
}

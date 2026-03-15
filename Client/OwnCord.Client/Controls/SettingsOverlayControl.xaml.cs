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

    public static readonly DependencyProperty UsernameProperty =
        DependencyProperty.Register(
            nameof(Username),
            typeof(string),
            typeof(SettingsOverlayControl),
            new PropertyMetadata("Unknown"));

    public static readonly DependencyProperty UserStatusProperty =
        DependencyProperty.Register(
            nameof(UserStatus),
            typeof(string),
            typeof(SettingsOverlayControl),
            new PropertyMetadata("Offline"));

    public static readonly DependencyProperty ServerNameProperty =
        DependencyProperty.Register(
            nameof(ServerName),
            typeof(string),
            typeof(SettingsOverlayControl),
            new PropertyMetadata("Not connected"));

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

    public string Username
    {
        get => (string)GetValue(UsernameProperty);
        set => SetValue(UsernameProperty, value);
    }

    public string UserStatus
    {
        get => (string)GetValue(UserStatusProperty);
        set => SetValue(UserStatusProperty, value);
    }

    public string ServerName
    {
        get => (string)GetValue(ServerNameProperty);
        set => SetValue(ServerNameProperty, value);
    }

    private void OnSidebarClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is string section)
        {
            SelectedSection = section;
        }
    }

    private void OnPlaceholderClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement el && el.Tag is string description)
        {
            MessageBox.Show(description, "Coming Soon", MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }

    private void OnToggleClick(object sender, RoutedEventArgs e)
    {
        if (sender is CheckBox cb && cb.Tag is string label)
        {
            var state = cb.IsChecked == true ? "enabled" : "disabled";
            // Placeholder — in future these will persist to settings
            System.Diagnostics.Debug.WriteLine($"Setting '{label}' {state}");
        }
    }
}

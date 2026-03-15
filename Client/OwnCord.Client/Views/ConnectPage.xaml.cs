using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using OwnCord.Client.Models;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Views;

public partial class ConnectPage : Page
{
    private readonly ConnectViewModel _vm;
    private readonly TextBox[] _totpBoxes;

    private static readonly SolidColorBrush OnlineBrush = new(Color.FromRgb(0x23, 0xa5, 0x5a));
    private static readonly SolidColorBrush CheckingBrush = new(Color.FromRgb(0xf0, 0xb2, 0x32));
    private static readonly SolidColorBrush OfflineBrush = new(Color.FromRgb(0xf2, 0x3f, 0x43));
    private static readonly SolidColorBrush UnknownBrush = new(Color.FromRgb(0x6d, 0x6f, 0x78));

    static ConnectPage()
    {
        OnlineBrush.Freeze();
        CheckingBrush.Freeze();
        OfflineBrush.Freeze();
        UnknownBrush.Freeze();
    }

    public ConnectPage(ConnectViewModel vm)
    {
        InitializeComponent();
        _vm = vm;
        DataContext = vm;

        _totpBoxes = [Totp1, Totp2, Totp3, Totp4, Totp5, Totp6];

        vm.PasswordLoaded += pwd => PasswordBox.Password = pwd ?? string.Empty;
        vm.EditProfileRequested += OnEditProfileRequested;
        vm.HealthStatusChanged += RefreshHealthDots;

        Loaded += OnPageLoaded;
    }

    private async void OnPageLoaded(object sender, RoutedEventArgs e)
    {
        if (_vm.Profiles.Count > 0)
        {
            await _vm.RefreshHealthAsync();
        }
    }

    private void RefreshHealthDots()
    {
        Dispatcher.InvokeAsync(() =>
        {
            for (var i = 0; i < ProfileList.Items.Count; i++)
            {
                if (ProfileList.ItemContainerGenerator.ContainerFromIndex(i) is not ListBoxItem container)
                    continue;

                var profile = ProfileList.Items[i] as ServerProfile;
                if (profile is null) continue;

                var dot = FindVisualChild<Ellipse>(container, "HealthDot");
                if (dot is null) continue;

                var status = _vm.GetHealthStatus(profile.Id);
                dot.Fill = status switch
                {
                    "online" => OnlineBrush,
                    "checking" => CheckingBrush,
                    "offline" => OfflineBrush,
                    _ => UnknownBrush
                };
            }
        });
    }

    private static T? FindVisualChild<T>(DependencyObject parent, string name) where T : FrameworkElement
    {
        var count = VisualTreeHelper.GetChildrenCount(parent);
        for (var i = 0; i < count; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T typed && typed.Name == name)
                return typed;

            var found = FindVisualChild<T>(child, name);
            if (found is not null)
                return found;
        }
        return null;
    }

    private void ConnectButton_Click(object sender, RoutedEventArgs e)
    {
        _vm.Password = PasswordBox.Password;
        _vm.ConnectCommand.Execute(null);
    }

    private void DeleteProfile_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.Tag is ServerProfile profile)
        {
            _vm.SelectedProfile = profile;
            _vm.DeleteProfileCommand.Execute(null);
        }
    }

    private void EditProfile_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.Tag is ServerProfile profile)
        {
            _vm.EditProfileCommand.Execute(profile);
        }
    }

    private void SwitchToRegister_Click(object sender, RoutedEventArgs e)
        => _vm.IsRegisterMode = true;

    private void SwitchToLogin_Click(object sender, RoutedEventArgs e)
        => _vm.IsRegisterMode = false;

    private void OnEditProfileRequested(ServerProfile? existing)
    {
        var dialog = new ServerProfileDialog(existing)
        {
            Owner = Window.GetWindow(this)
        };

        if (dialog.ShowDialog() == true && dialog.ResultProfile is not null)
        {
            _vm.ApplyProfileFromDialog(dialog.ResultProfile, dialog.IsNewProfile);
        }
    }

    // ── TOTP digit box handlers ──────────────────────────────────────────

    private void TotpDigit_PreviewTextInput(object sender, TextCompositionEventArgs e)
    {
        // Only allow digits
        e.Handled = !char.IsDigit(e.Text, 0);
    }

    private void TotpDigit_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (sender is not TextBox current) return;

        // Auto-advance to next box
        if (current.Text.Length == 1)
        {
            var index = Array.IndexOf(_totpBoxes, current);
            if (index >= 0 && index < _totpBoxes.Length - 1)
            {
                _totpBoxes[index + 1].Focus();
            }
        }

        // Sync the combined code to the VM
        SyncTotpCode();
    }

    private void TotpDigit_KeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox current) return;

        if (e.Key == Key.Back && current.Text.Length == 0)
        {
            var index = Array.IndexOf(_totpBoxes, current);
            if (index > 0)
            {
                _totpBoxes[index - 1].Focus();
                _totpBoxes[index - 1].SelectAll();
            }
        }
    }

    private void SyncTotpCode()
    {
        var code = string.Concat(_totpBoxes.Select(b => b.Text));
        _vm.TotpCode = code;
    }

    private void VerifyTotp_Click(object sender, RoutedEventArgs e)
    {
        SyncTotpCode();
        _vm.VerifyTotpCommand.Execute(null);
    }
}

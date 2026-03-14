using System.Windows;
using System.Windows.Controls;
using OwnCord.Client.Models;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Views;

public partial class ConnectPage : Page
{
    private readonly ConnectViewModel _vm;

    public ConnectPage(ConnectViewModel vm)
    {
        InitializeComponent();
        _vm = vm;
        DataContext = vm;

        vm.PasswordLoaded += pwd => PasswordBox.Password = pwd ?? string.Empty;
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

    private void SwitchToRegister_Click(object sender, RoutedEventArgs e)
        => _vm.IsRegisterMode = true;

    private void SwitchToLogin_Click(object sender, RoutedEventArgs e)
        => _vm.IsRegisterMode = false;
}

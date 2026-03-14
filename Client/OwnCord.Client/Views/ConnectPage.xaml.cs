using System.Windows.Controls;
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
    }

    private void ConnectButton_Click(object sender, System.Windows.RoutedEventArgs e)
    {
        // PasswordBox doesn't support data binding for security — read it directly
        _vm.ConnectCommand.Execute(null);
    }
}

using System.Windows;
using OwnCord.Client.Services;
using OwnCord.Client.ViewModels;
using OwnCord.Client.Views;

namespace OwnCord.Client;

public partial class MainWindow : Window
{
    private readonly IWebSocketService _ws;

    public MainWindow(
        ConnectViewModel connectVm,
        MainViewModel mainVm,
        ICredentialService credentials,
        IWebSocketService ws)
    {
        InitializeComponent();
        _ws = ws;

        connectVm.ConnectRequested += (host, username, inviteCode, isRegister) =>
            RootFrame.Navigate(new MainPage(mainVm));

        RootFrame.Navigate(new ConnectPage(connectVm));
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        base.OnClosing(e);
        _ = _ws.DisconnectAsync();
    }
}
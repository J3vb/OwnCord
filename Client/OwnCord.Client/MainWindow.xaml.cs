using System.Windows;
using OwnCord.Client.Services;
using OwnCord.Client.ViewModels;
using OwnCord.Client.Views;

namespace OwnCord.Client;

public partial class MainWindow : Window
{
    private readonly IChatService _chat;
    private readonly ConnectViewModel _connectVm;
    private readonly MainViewModel _mainVm;

    public MainWindow(
        ConnectViewModel connectVm,
        MainViewModel mainVm,
        IChatService chat)
    {
        InitializeComponent();
        _chat = chat;
        _connectVm = connectVm;
        _mainVm = mainVm;

        connectVm.ConnectRequested += OnConnectRequested;
        RootFrame.Navigate(new ConnectPage(connectVm));
    }

    private async void OnConnectRequested(string host, string username, string password, string? inviteCode, bool isRegister)
    {
        _connectVm.ErrorMessage = null;
        _connectVm.IsLoading = true;

        try
        {
            if (isRegister)
                await _chat.RegisterAsync(host, username, password, inviteCode ?? "");
            else
                await _chat.LoginAsync(host, username, password);

            _connectVm.PersistPasswordIfRequested(host, username, password);

            _mainVm.Initialize(_chat);
            RootFrame.Navigate(new MainPage(_mainVm));

            await _chat.ConnectWebSocketAsync(host, _chat.CurrentToken!);
        }
        catch (ApiException ex)
        {
            _connectVm.ErrorMessage = ex.Message;
        }
        catch (Exception ex)
        {
            _connectVm.ErrorMessage = $"Connection failed: {ex.Message}";
        }
        finally
        {
            _connectVm.IsLoading = false;
        }
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        base.OnClosing(e);
        _ = _chat.DisconnectWebSocketAsync();
    }
}

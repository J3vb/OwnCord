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
        connectVm.TotpVerifyRequested += OnTotpVerifyRequested;
        RootFrame.Navigate(new ConnectPage(connectVm));
    }

    private async void OnConnectRequested(string host, string username, string password, string? inviteCode, bool isRegister)
    {
        _connectVm.ErrorMessage = null;
        _connectVm.IsLoading = true;

        try
        {
            Models.AuthResponse result;
            if (isRegister)
                result = await _chat.RegisterAsync(host, username, password, inviteCode ?? "");
            else
                result = await _chat.LoginAsync(host, username, password);

            if (result.Requires2FA)
            {
                _connectVm.Enter2FAMode(result.PartialToken ?? "");
                return;
            }

            _connectVm.PersistPasswordIfRequested(host, username, password);
            _connectVm.MarkProfileConnected(host);

            _mainVm.Initialize(_chat);
            RootFrame.Navigate(new MainPage(_mainVm));

            try
            {
                await _chat.ConnectWebSocketAsync(host, _chat.CurrentToken!);
            }
            catch (Exception wsEx)
            {
                // WebSocket errors after navigation should show on MainPage, not ConnectPage
                _mainVm.ConnectionStatus = $"WebSocket failed: {wsEx.Message}";
            }
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

    private async void OnTotpVerifyRequested(string host, string partialToken, string code)
    {
        _connectVm.ErrorMessage = null;
        _connectVm.IsLoading = true;

        try
        {
            var result = await _chat.VerifyTotpAsync(host, partialToken, code);

            _connectVm.PersistPasswordIfRequested(host, _connectVm.Username, _connectVm.Password);
            _connectVm.MarkProfileConnected(host);
            _connectVm.IsTotpRequired = false;

            _mainVm.Initialize(_chat);
            RootFrame.Navigate(new MainPage(_mainVm));

            try
            {
                await _chat.ConnectWebSocketAsync(host, _chat.CurrentToken!);
            }
            catch (Exception wsEx)
            {
                _mainVm.ConnectionStatus = $"WebSocket failed: {wsEx.Message}";
            }
        }
        catch (ApiException ex)
        {
            _connectVm.ErrorMessage = ex.Message;
        }
        catch (Exception ex)
        {
            _connectVm.ErrorMessage = $"Verification failed: {ex.Message}";
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

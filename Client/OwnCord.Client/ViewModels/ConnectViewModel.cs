using System.Collections.ObjectModel;
using System.Windows.Input;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.ViewModels;

public sealed class ConnectViewModel : ViewModelBase
{
    private readonly IProfileService _profiles;

    private string _host = string.Empty;
    private string _username = string.Empty;
    private string _inviteCode = string.Empty;
    private bool _isRegisterMode;
    private ServerProfile? _selectedProfile;

    public ConnectViewModel(IProfileService profiles)
    {
        _profiles = profiles;
        ConnectCommand = new RelayCommand(OnConnect, CanConnect);
        SaveProfileCommand = new RelayCommand(OnSaveProfile, CanSaveProfile);
        DeleteProfileCommand = new RelayCommand(OnDeleteProfile, () => SelectedProfile is not null);
        Profiles = new ObservableCollection<ServerProfile>(profiles.LoadProfiles());
    }

    public string Host
    {
        get => _host;
        set
        {
            if (SetField(ref _host, value))
                RaiseCanExecuteChanged();
        }
    }

    public string Username
    {
        get => _username;
        set
        {
            if (SetField(ref _username, value))
                RaiseCanExecuteChanged();
        }
    }

    public string InviteCode
    {
        get => _inviteCode;
        set => SetField(ref _inviteCode, value);
    }

    public bool IsRegisterMode
    {
        get => _isRegisterMode;
        set => SetField(ref _isRegisterMode, value);
    }

    public ServerProfile? SelectedProfile
    {
        get => _selectedProfile;
        set
        {
            if (SetField(ref _selectedProfile, value) && value is not null)
            {
                Host = value.Host;
                Username = value.LastUsername ?? string.Empty;
            }
            ((RelayCommand)DeleteProfileCommand).RaiseCanExecuteChanged();
        }
    }

    public ObservableCollection<ServerProfile> Profiles { get; }

    public ICommand ConnectCommand { get; }
    public ICommand SaveProfileCommand { get; }
    public ICommand DeleteProfileCommand { get; }

    public event Action<string, string, string?, bool>? ConnectRequested;

    private bool CanConnect() =>
        !string.IsNullOrWhiteSpace(Host) &&
        !string.IsNullOrWhiteSpace(Username);

    private void OnConnect() =>
        ConnectRequested?.Invoke(Host, Username, IsRegisterMode ? InviteCode : null, IsRegisterMode);

    private bool CanSaveProfile() =>
        !string.IsNullOrWhiteSpace(Host) && !string.IsNullOrWhiteSpace(Username);

    private void OnSaveProfile()
    {
        var profile = ServerProfile.Create(Host, Host, Username);
        var updated = _profiles.AddProfile([.. Profiles], profile);
        _profiles.SaveProfiles(updated);
        Profiles.Add(profile);
    }

    private void OnDeleteProfile()
    {
        if (SelectedProfile is null) return;
        var updated = _profiles.RemoveProfile([.. Profiles], SelectedProfile.Id);
        _profiles.SaveProfiles(updated);
        Profiles.Remove(SelectedProfile);
        SelectedProfile = null;
    }

    private void RaiseCanExecuteChanged()
    {
        ((RelayCommand)ConnectCommand).RaiseCanExecuteChanged();
        ((RelayCommand)SaveProfileCommand).RaiseCanExecuteChanged();
    }
}

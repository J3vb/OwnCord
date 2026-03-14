using System.Collections.ObjectModel;
using System.Windows.Input;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.ViewModels;

public sealed class ConnectViewModel : ViewModelBase
{
    private readonly IProfileService _profiles;
    private readonly ICredentialService _credentials;

    private string _host = string.Empty;
    private string _username = string.Empty;
    private string _password = string.Empty;
    private string _inviteCode = string.Empty;
    private bool _isRegisterMode;
    private bool _isLoading;
    private string? _errorMessage;
    private bool _savePassword;
    private ServerProfile? _selectedProfile;

    public ConnectViewModel(IProfileService profiles, ICredentialService credentials)
    {
        _profiles = profiles;
        _credentials = credentials;
        ConnectCommand = new RelayCommand(OnConnect, CanConnect);
        SaveProfileCommand = new RelayCommand(OnSaveProfile, CanSaveProfile);
        DeleteProfileCommand = new RelayCommand(OnDeleteProfile, () => SelectedProfile is not null);
        Profiles = new ObservableCollection<ServerProfile>(profiles.LoadProfiles());
        Profiles.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(HasProfiles));
            OnPropertyChanged(nameof(HasNoProfiles));
        };
    }

    public bool HasProfiles => Profiles.Count > 0;
    public bool HasNoProfiles => Profiles.Count == 0;

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

    public string Password
    {
        get => _password;
        set
        {
            if (SetField(ref _password, value))
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

    public bool IsLoading
    {
        get => _isLoading;
        set
        {
            if (SetField(ref _isLoading, value))
                RaiseCanExecuteChanged();
        }
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        set => SetField(ref _errorMessage, value);
    }

    public bool SavePassword
    {
        get => _savePassword;
        set => SetField(ref _savePassword, value);
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

                var saved = _credentials.LoadPassword(value.Host, value.LastUsername ?? "");
                if (saved is not null)
                {
                    Password = saved;
                    SavePassword = true;
                    PasswordLoaded?.Invoke(saved);
                }
                else
                {
                    Password = string.Empty;
                    SavePassword = false;
                    PasswordLoaded?.Invoke(null);
                }
            }
            ((RelayCommand)DeleteProfileCommand).RaiseCanExecuteChanged();
        }
    }

    /// <summary>Raised when a saved password is loaded so the view can set the PasswordBox.</summary>
    public event Action<string?>? PasswordLoaded;

    public ObservableCollection<ServerProfile> Profiles { get; }

    public ICommand ConnectCommand { get; }
    public ICommand SaveProfileCommand { get; }
    public ICommand DeleteProfileCommand { get; }

    /// <summary>Args: host, username, password, inviteCode?, isRegister</summary>
    public event Action<string, string, string, string?, bool>? ConnectRequested;

    private bool CanConnect() =>
        !_isLoading &&
        !string.IsNullOrWhiteSpace(Host) &&
        !string.IsNullOrWhiteSpace(Username);

    private void OnConnect() =>
        ConnectRequested?.Invoke(Host, Username, Password, IsRegisterMode ? InviteCode : null, IsRegisterMode);

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

    /// <summary>Persist or remove the saved password based on the checkbox state.</summary>
    public void PersistPasswordIfRequested(string host, string username, string password)
    {
        if (SavePassword)
            _credentials.SavePassword(host, username, password);
        else
            _credentials.DeletePassword(host, username);
    }

    private void RaiseCanExecuteChanged()
    {
        ((RelayCommand)ConnectCommand).RaiseCanExecuteChanged();
        ((RelayCommand)SaveProfileCommand).RaiseCanExecuteChanged();
    }
}

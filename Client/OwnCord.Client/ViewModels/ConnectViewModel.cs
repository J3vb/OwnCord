using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Windows.Input;
using Microsoft.Win32;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.ViewModels;

public sealed class ConnectViewModel : ViewModelBase
{
    private readonly IProfileService _profiles;
    private readonly ICredentialService _credentials;
    private readonly IApiClient _api;
    private readonly Dictionary<string, string> _healthStatuses = new();

    private string _host = string.Empty;
    private int _port = 8443;
    private string _username = string.Empty;
    private string _password = string.Empty;
    private string _inviteCode = string.Empty;
    private bool _isRegisterMode;
    private bool _isLoading;
    private string? _errorMessage;
    private bool _savePassword;
    private ServerProfile? _selectedProfile;
    private bool _isTotpRequired;
    private string _partialToken = string.Empty;
    private string _totpCode = string.Empty;

    public ConnectViewModel(IProfileService profiles, ICredentialService credentials, IApiClient api)
    {
        _profiles = profiles;
        _credentials = credentials;
        _api = api;
        ConnectCommand = new RelayCommand(OnConnect, CanConnect);
        SaveProfileCommand = new RelayCommand(OnSaveProfile, CanSaveProfile);
        DeleteProfileCommand = new RelayCommand(OnDeleteProfile, () => SelectedProfile is not null);
        AddProfileCommand = new RelayCommand(OnAddProfile);
        EditProfileCommand = new RelayCommand<ServerProfile>(OnEditProfile);
        VerifyTotpCommand = new RelayCommand(OnVerifyTotp, CanVerifyTotp);
        ImportProfilesCommand = new RelayCommand(OnImportProfiles);
        ExportProfilesCommand = new RelayCommand(OnExportProfiles, () => Profiles.Count > 0);
        CancelTotpCommand = new RelayCommand(OnCancelTotp);
        RefreshHealthCommand = new RelayCommand(OnRefreshHealth, () => Profiles.Count > 0);
        Profiles = new ObservableCollection<ServerProfile>(profiles.LoadProfiles());
        Profiles.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(HasProfiles));
            OnPropertyChanged(nameof(HasNoProfiles));
            ((RelayCommand)ExportProfilesCommand).RaiseCanExecuteChanged();
            ((RelayCommand)RefreshHealthCommand).RaiseCanExecuteChanged();
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

    public int Port
    {
        get => _port;
        set
        {
            if (SetField(ref _port, value))
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

    public bool IsTotpRequired
    {
        get => _isTotpRequired;
        set => SetField(ref _isTotpRequired, value);
    }

    public string PartialToken
    {
        get => _partialToken;
        set => SetField(ref _partialToken, value);
    }

    public string TotpCode
    {
        get => _totpCode;
        set
        {
            if (SetField(ref _totpCode, value))
                ((RelayCommand)VerifyTotpCommand).RaiseCanExecuteChanged();
        }
    }

    public ServerProfile? SelectedProfile
    {
        get => _selectedProfile;
        set
        {
            if (SetField(ref _selectedProfile, value) && value is not null)
            {
                Host = value.Host;
                Port = value.Port;
                Username = value.LastUsername ?? string.Empty;

                var saved = _credentials.LoadPassword(value.HostDisplay, value.LastUsername ?? "");
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
    public ICommand AddProfileCommand { get; }
    public ICommand EditProfileCommand { get; }
    public ICommand VerifyTotpCommand { get; }
    public ICommand ImportProfilesCommand { get; }
    public ICommand ExportProfilesCommand { get; }
    public ICommand CancelTotpCommand { get; }
    public ICommand RefreshHealthCommand { get; }

    /// <summary>Gets the health status string for a given profile ID.</summary>
    public string GetHealthStatus(string profileId)
        => _healthStatuses.TryGetValue(profileId, out var s) ? s : "unknown";

    /// <summary>Pings every saved server's health endpoint in parallel and updates statuses.</summary>
    public async Task RefreshHealthAsync()
    {
        if (Profiles.Count == 0) return;

        var tasks = Profiles.Select(async profile =>
        {
            _healthStatuses[profile.Id] = "checking";
            OnPropertyChanged(nameof(Profiles));

            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var health = await _api.HealthCheckAsync(profile.HostDisplay, cts.Token);
                _healthStatuses[profile.Id] = health.Status == "ok" ? "online" : "offline";
            }
            catch
            {
                _healthStatuses[profile.Id] = "offline";
            }
        });
        await Task.WhenAll(tasks);
        OnPropertyChanged(nameof(Profiles));
        HealthStatusChanged?.Invoke();
    }

    /// <summary>Raised when any health status changes so the view can refresh bindings.</summary>
    public event Action? HealthStatusChanged;

    /// <summary>Args: host, username, password, inviteCode?, isRegister</summary>
    public event Action<string, string, string, string?, bool>? ConnectRequested;

    /// <summary>Args: host, partialToken, totpCode</summary>
    public event Action<string, string, string>? TotpVerifyRequested;

    /// <summary>Raised to open the add/edit server profile dialog. Arg: profile to edit (null = add new).</summary>
    public event Action<ServerProfile?>? EditProfileRequested;

    /// <summary>
    /// Called when login returns requires_2fa. Sets up the TOTP entry UI state.
    /// </summary>
    public void Enter2FAMode(string partialToken)
    {
        PartialToken = partialToken;
        IsTotpRequired = true;
        TotpCode = string.Empty;
        ErrorMessage = null;
    }

    /// <summary>Applies a saved or new profile from the dialog.</summary>
    public void ApplyProfileFromDialog(ServerProfile profile, bool isNew)
    {
        if (isNew)
        {
            var updated = _profiles.AddProfile([.. Profiles], profile);
            _profiles.SaveProfiles(updated);
            Profiles.Add(profile);
        }
        else
        {
            var index = -1;
            for (var i = 0; i < Profiles.Count; i++)
            {
                if (Profiles[i].Id == profile.Id) { index = i; break; }
            }
            if (index >= 0)
            {
                Profiles[index] = profile;
                var updated = _profiles.UpdateProfile([.. Profiles], profile);
                _profiles.SaveProfiles(updated);
            }
        }
    }

    private bool CanConnect() =>
        !_isLoading &&
        !string.IsNullOrWhiteSpace(Host) &&
        !string.IsNullOrWhiteSpace(Username);

    private void OnConnect()
    {
        var hostWithPort = Port == 8443 ? Host : $"{Host}:{Port}";
        ConnectRequested?.Invoke(hostWithPort, Username, Password, IsRegisterMode ? InviteCode : null, IsRegisterMode);
    }

    private bool CanSaveProfile() =>
        !string.IsNullOrWhiteSpace(Host) && !string.IsNullOrWhiteSpace(Username);

    private void OnSaveProfile()
    {
        var profile = ServerProfile.Create(Host, Host, Username, port: Port);
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

    private void OnAddProfile() => EditProfileRequested?.Invoke(null);

    private void OnEditProfile(ServerProfile? profile)
    {
        if (profile is not null)
            EditProfileRequested?.Invoke(profile);
    }

    private bool CanVerifyTotp() =>
        !_isLoading && _totpCode.Length == 6;

    private void OnVerifyTotp()
    {
        var hostWithPort = Port == 8443 ? Host : $"{Host}:{Port}";
        TotpVerifyRequested?.Invoke(hostWithPort, PartialToken, TotpCode);
    }

    private void OnCancelTotp()
    {
        IsTotpRequired = false;
        PartialToken = string.Empty;
        TotpCode = string.Empty;
        ErrorMessage = null;
    }

    private void OnImportProfiles()
    {
        var dlg = new OpenFileDialog
        {
            Filter = "JSON files (*.json)|*.json",
            Title = "Import Server Profiles"
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            var fileInfo = new FileInfo(dlg.FileName);
            if (fileInfo.Length > 1_048_576) // 1 MB limit
            {
                ErrorMessage = "Import file is too large (max 1 MB).";
                return;
            }

            var json = File.ReadAllText(dlg.FileName);
            var imported = JsonSerializer.Deserialize<List<ServerProfile>>(json);
            if (imported is null || imported.Count == 0) return;

            var current = Profiles.ToList();
            var existingHosts = new HashSet<string>(current.Select(p => p.HostDisplay), StringComparer.OrdinalIgnoreCase);

            foreach (var profile in imported)
            {
                if (!existingHosts.Contains(profile.HostDisplay))
                {
                    current.Add(profile);
                    Profiles.Add(profile);
                    existingHosts.Add(profile.HostDisplay);
                }
            }

            _profiles.SaveProfiles(current);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Import failed: {ex.Message}";
        }
    }

    private void OnExportProfiles()
    {
        var dlg = new SaveFileDialog
        {
            Filter = "JSON files (*.json)|*.json",
            Title = "Export Server Profiles",
            FileName = "owncord-profiles.json"
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            var json = JsonSerializer.Serialize(Profiles.ToList(), new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(dlg.FileName, json);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Export failed: {ex.Message}";
        }
    }

    /// <summary>Persist or remove the saved password based on the checkbox state.</summary>
    public void PersistPasswordIfRequested(string host, string username, string password)
    {
        if (SavePassword)
            _credentials.SavePassword(host, username, password);
        else
            _credentials.DeletePassword(host, username);
    }

    /// <summary>Updates the LastConnected timestamp on the matching profile.</summary>
    public void MarkProfileConnected(string host)
    {
        for (var i = 0; i < Profiles.Count; i++)
        {
            if (string.Equals(Profiles[i].HostDisplay, host, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(Profiles[i].Host, host, StringComparison.OrdinalIgnoreCase))
            {
                var updated = Profiles[i] with { LastConnected = DateTime.UtcNow, LastUsername = Username };
                Profiles[i] = updated;
                _profiles.SaveProfiles([.. Profiles]);
                break;
            }
        }
    }

    private async void OnRefreshHealth()
    {
        await RefreshHealthAsync();
    }

    private void RaiseCanExecuteChanged()
    {
        ((RelayCommand)ConnectCommand).RaiseCanExecuteChanged();
        ((RelayCommand)SaveProfileCommand).RaiseCanExecuteChanged();
    }
}

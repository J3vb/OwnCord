using OwnCord.Client.Models;
using OwnCord.Client.Services;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Tests.ViewModels;

public sealed class ConnectViewModelTests
{
    private static ConnectViewModel MakeVm(IProfileService? svc = null, ICredentialService? creds = null, IApiClient? api = null)
        => new(svc ?? new FakeProfileService(), creds ?? new FakeCredentialService(), api ?? new StubApiClient());

    [Fact]
    public void DefaultMode_IsLogin()
    {
        var vm = MakeVm();
        Assert.False(vm.IsRegisterMode);
    }

    [Fact]
    public void ToggleRegisterMode_FlipsFlag()
    {
        var vm = MakeVm();
        vm.IsRegisterMode = true;
        Assert.True(vm.IsRegisterMode);
        vm.IsRegisterMode = false;
        Assert.False(vm.IsRegisterMode);
    }

    [Fact]
    public void ConnectCommand_DisabledWhenHostEmpty()
    {
        var vm = MakeVm();
        vm.Username = "alice";
        vm.Host = "";
        Assert.False(vm.ConnectCommand.CanExecute(null));
    }

    [Fact]
    public void ConnectCommand_DisabledWhenUsernameEmpty()
    {
        var vm = MakeVm();
        vm.Host = "localhost:8443";
        vm.Username = "";
        Assert.False(vm.ConnectCommand.CanExecute(null));
    }

    [Fact]
    public void ConnectCommand_EnabledWhenHostAndUsernameSet()
    {
        var vm = MakeVm();
        vm.Host = "localhost:8443";
        vm.Username = "alice";
        Assert.True(vm.ConnectCommand.CanExecute(null));
    }

    [Fact]
    public void ConnectCommand_RaisesConnectRequested()
    {
        var vm = MakeVm();
        vm.Host = "localhost:8443";
        vm.Username = "alice";
        vm.Password = "pass123";
        (string host, string user, string? invite, bool isReg) captured = default;
        vm.ConnectRequested += (h, u, _, i, r) => captured = (h, u, i, r);
        vm.ConnectCommand.Execute(null);
        Assert.Equal("localhost:8443", captured.host);
        Assert.Equal("alice", captured.user);
        Assert.Null(captured.invite);
        Assert.False(captured.isReg);
    }

    [Fact]
    public void ConnectCommand_RegisterMode_PassesInviteCode()
    {
        var vm = MakeVm();
        vm.Host = "localhost:8443";
        vm.Username = "alice";
        vm.Password = "pass123";
        vm.IsRegisterMode = true;
        vm.InviteCode = "abc123";
        string? capturedInvite = null;
        vm.ConnectRequested += (_, _, _, i, _) => capturedInvite = i;
        vm.ConnectCommand.Execute(null);
        Assert.Equal("abc123", capturedInvite);
    }

    [Fact]
    public void SaveProfileCommand_DisabledWhenHostEmpty()
    {
        var vm = MakeVm();
        vm.Username = "alice";
        Assert.False(vm.SaveProfileCommand.CanExecute(null));
    }

    [Fact]
    public void SaveProfile_AddsToCollection()
    {
        var svc = new FakeProfileService();
        var vm = MakeVm(svc);
        vm.Host = "localhost:8443";
        vm.Username = "alice";
        vm.SaveProfileCommand.Execute(null);
        Assert.Single(vm.Profiles);
        Assert.Equal("localhost:8443", vm.Profiles[0].Host);
    }

    [Fact]
    public void SelectProfile_PopulatesHostAndUsername()
    {
        var svc = new FakeProfileService();
        var profile = ServerProfile.Create("Home", "192.168.1.10:8443", "bob");
        svc.Saved = [profile];
        var vm = MakeVm(svc);
        vm.SelectedProfile = profile;
        Assert.Equal("192.168.1.10:8443", vm.Host);
        Assert.Equal("bob", vm.Username);
    }

    [Fact]
    public void DeleteProfile_RemovesFromCollection()
    {
        var svc = new FakeProfileService();
        var profile = ServerProfile.Create("Home", "192.168.1.10:8443", "bob");
        svc.Saved = [profile];
        var vm = MakeVm(svc);
        vm.SelectedProfile = profile;
        vm.DeleteProfileCommand.Execute(null);
        Assert.Empty(vm.Profiles);
    }

    [Fact]
    public void Password_PropertyNotifiesChange()
    {
        var vm = MakeVm();
        string? changed = null;
        vm.PropertyChanged += (_, e) => changed = e.PropertyName;
        vm.Password = "secret";
        Assert.Equal("Password", changed);
        Assert.Equal("secret", vm.Password);
    }

    [Fact]
    public void ErrorMessage_PropertyNotifiesChange()
    {
        var vm = MakeVm();
        string? changed = null;
        vm.PropertyChanged += (_, e) => changed = e.PropertyName;
        vm.ErrorMessage = "Login failed";
        Assert.Equal("ErrorMessage", changed);
        Assert.Equal("Login failed", vm.ErrorMessage);
    }

    [Fact]
    public void IsLoading_PropertyNotifiesChange()
    {
        var vm = MakeVm();
        string? changed = null;
        vm.PropertyChanged += (_, e) => changed = e.PropertyName;
        vm.IsLoading = true;
        Assert.Equal("IsLoading", changed);
        Assert.True(vm.IsLoading);
    }

    [Fact]
    public void ConnectCommand_IncludesPasswordInEvent()
    {
        var vm = MakeVm();
        vm.Host = "localhost:8443";
        vm.Username = "alice";
        vm.Password = "secret123";
        string? capturedPassword = null;
        vm.ConnectRequested += (_, _, password, _, _) => capturedPassword = password;
        vm.ConnectCommand.Execute(null);
        Assert.Equal("secret123", capturedPassword);
    }

    [Fact]
    public void ConnectCommand_DisabledWhenLoading()
    {
        var vm = MakeVm();
        vm.Host = "localhost:8443";
        vm.Username = "alice";
        vm.IsLoading = true;
        Assert.False(vm.ConnectCommand.CanExecute(null));
    }

    [Fact]
    public void PersistPassword_SavesWhenChecked()
    {
        var creds = new FakeCredentialService();
        var vm = MakeVm(creds: creds);
        vm.SavePassword = true;
        vm.PersistPasswordIfRequested("localhost:8443", "alice", "secret");
        Assert.Equal("secret", creds.LoadPassword("localhost:8443", "alice"));
    }

    [Fact]
    public void PersistPassword_DeletesWhenUnchecked()
    {
        var creds = new FakeCredentialService();
        creds.SavePassword("localhost:8443", "alice", "secret");
        var vm = MakeVm(creds: creds);
        vm.SavePassword = false;
        vm.PersistPasswordIfRequested("localhost:8443", "alice", "secret");
        Assert.Null(creds.LoadPassword("localhost:8443", "alice"));
    }

    [Fact]
    public void SelectProfile_LoadsSavedPassword()
    {
        var creds = new FakeCredentialService();
        creds.SavePassword("192.168.1.10:8443", "bob", "pass123");
        var svc = new FakeProfileService();
        var profile = ServerProfile.Create("Home", "192.168.1.10:8443", "bob");
        svc.Saved = [profile];
        var vm = MakeVm(svc, creds);
        vm.SelectedProfile = profile;
        Assert.Equal("pass123", vm.Password);
        Assert.True(vm.SavePassword);
    }

    [Fact]
    public void SelectProfile_ClearsPasswordWhenNoneSaved()
    {
        var creds = new FakeCredentialService();
        var svc = new FakeProfileService();
        var profile = ServerProfile.Create("Home", "192.168.1.10:8443", "bob");
        svc.Saved = [profile];
        var vm = MakeVm(svc, creds);
        vm.Password = "old";
        vm.SavePassword = true;
        vm.SelectedProfile = profile;
        Assert.Equal(string.Empty, vm.Password);
        Assert.False(vm.SavePassword);
    }
}

internal sealed class FakeCredentialService : ICredentialService
{
    private readonly Dictionary<string, string> _tokens = new();
    private readonly Dictionary<string, string> _passwords = new();

    private static string Key(string host, string username) => $"{host}:{username}";

    public void SaveToken(string host, string username, string token) => _tokens[Key(host, username)] = token;
    public string? LoadToken(string host, string username) => _tokens.GetValueOrDefault(Key(host, username));
    public void DeleteToken(string host, string username) => _tokens.Remove(Key(host, username));

    public void SavePassword(string host, string username, string password) => _passwords[Key(host, username)] = password;
    public string? LoadPassword(string host, string username) => _passwords.GetValueOrDefault(Key(host, username));
    public void DeletePassword(string host, string username) => _passwords.Remove(Key(host, username));
}

internal sealed class StubApiClient : IApiClient
{
    public HealthResponse? HealthResult { get; set; } = new("ok", "1.0.0");
    public bool HealthThrows { get; set; }

    public Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct = default)
        => throw new NotImplementedException();
    public Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct = default)
        => throw new NotImplementedException();
    public Task LogoutAsync(string host, string token, CancellationToken ct = default)
        => throw new NotImplementedException();
    public Task<ApiUser> GetMeAsync(string host, string token, CancellationToken ct = default)
        => throw new NotImplementedException();
    public Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(string host, string token, CancellationToken ct = default)
        => throw new NotImplementedException();
    public Task<MessagesResponse> GetMessagesAsync(string host, string token, long channelId, int limit = 50, long? before = null, CancellationToken ct = default)
        => throw new NotImplementedException();
    public Task<AuthResponse> VerifyTotpAsync(string host, string partialToken, string code, CancellationToken ct = default)
        => throw new NotImplementedException();

    public Task<HealthResponse> HealthCheckAsync(string host, CancellationToken ct = default)
    {
        if (HealthThrows) throw new Exception("Connection refused");
        return Task.FromResult(HealthResult ?? new HealthResponse("ok", "1.0.0"));
    }
}

internal sealed class FakeProfileService : IProfileService
{
    public List<ServerProfile> Saved = [];

    public IReadOnlyList<ServerProfile> LoadProfiles() => Saved;
    public IReadOnlyList<ServerProfile> AddProfile(IReadOnlyList<ServerProfile> p, ServerProfile profile)
        => [.. p, profile];
    public IReadOnlyList<ServerProfile> RemoveProfile(IReadOnlyList<ServerProfile> p, string id)
        => p.Where(x => x.Id != id).ToList();
    public IReadOnlyList<ServerProfile> UpdateProfile(IReadOnlyList<ServerProfile> p, ServerProfile updated)
        => p.Select(x => x.Id == updated.Id ? updated : x).ToList();
    public void SaveProfiles(IReadOnlyList<ServerProfile> profiles) => Saved = [.. profiles];
}

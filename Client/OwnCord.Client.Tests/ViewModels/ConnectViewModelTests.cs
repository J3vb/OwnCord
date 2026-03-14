using OwnCord.Client.Models;
using OwnCord.Client.Services;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Tests.ViewModels;

public sealed class ConnectViewModelTests
{
    private static ConnectViewModel MakeVm(IProfileService? svc = null)
        => new(svc ?? new FakeProfileService());

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
        (string host, string user, string? invite, bool isReg) captured = default;
        vm.ConnectRequested += (h, u, i, r) => captured = (h, u, i, r);
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
        vm.IsRegisterMode = true;
        vm.InviteCode = "abc123";
        string? capturedInvite = null;
        vm.ConnectRequested += (_, _, i, _) => capturedInvite = i;
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

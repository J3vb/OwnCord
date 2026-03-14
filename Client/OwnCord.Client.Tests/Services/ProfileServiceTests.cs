using System.IO;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.Tests.Services;

public sealed class ProfileServiceTests : IDisposable
{
    private readonly string _tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private ProfileService Svc => new(_tempDir);

    [Fact]
    public void LoadProfiles_ReturnsEmpty_WhenNoFile()
    {
        var profiles = Svc.LoadProfiles();
        Assert.Empty(profiles);
    }

    [Fact]
    public void SaveAndLoad_RoundTrips()
    {
        var svc = Svc;
        var profile = ServerProfile.Create("Home", "192.168.1.10:8443", "alice");
        svc.SaveProfiles([profile]);
        var loaded = svc.LoadProfiles();
        Assert.Single(loaded);
        Assert.Equal(profile.Name, loaded[0].Name);
        Assert.Equal(profile.Host, loaded[0].Host);
    }

    [Fact]
    public void AddProfile_DoesNotMutateOriginal()
    {
        var svc = Svc;
        IReadOnlyList<ServerProfile> original = [];
        var profile = ServerProfile.Create("Home", "localhost:8443");
        var updated = svc.AddProfile(original, profile);
        Assert.Empty(original);
        Assert.Single(updated);
    }

    [Fact]
    public void RemoveProfile_RemovesById()
    {
        var svc = Svc;
        var p1 = ServerProfile.Create("A", "a:8443");
        var p2 = ServerProfile.Create("B", "b:8443");
        var list = svc.AddProfile(svc.AddProfile([], p1), p2);
        var result = svc.RemoveProfile(list, p1.Id);
        Assert.Single(result);
        Assert.Equal(p2.Id, result[0].Id);
    }

    [Fact]
    public void UpdateProfile_ReplacesMatchingId()
    {
        var svc = Svc;
        var p = ServerProfile.Create("Old", "old:8443");
        var list = svc.AddProfile([], p);
        var updated = p with { Name = "New" };
        var result = svc.UpdateProfile(list, updated);
        Assert.Equal("New", result[0].Name);
    }

    [Fact]
    public void SaveProfiles_CreatesDirectory()
    {
        Assert.False(Directory.Exists(_tempDir));
        Svc.SaveProfiles([]);
        Assert.True(Directory.Exists(_tempDir));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }
}

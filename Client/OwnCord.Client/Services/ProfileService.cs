using System.IO;
using System.Text.Json;
using OwnCord.Client.Models;

namespace OwnCord.Client.Services;

public sealed class ProfileService(string dataDir) : IProfileService
{
    private readonly string _path = Path.Combine(dataDir, "profiles.json");

    public IReadOnlyList<ServerProfile> LoadProfiles()
    {
        if (!File.Exists(_path)) return [];
        var json = File.ReadAllText(_path);
        return JsonSerializer.Deserialize<List<ServerProfile>>(json) ?? [];
    }

    public IReadOnlyList<ServerProfile> AddProfile(IReadOnlyList<ServerProfile> profiles, ServerProfile profile)
        => [.. profiles, profile];

    public IReadOnlyList<ServerProfile> RemoveProfile(IReadOnlyList<ServerProfile> profiles, string id)
        => profiles.Where(p => p.Id != id).ToList();

    public IReadOnlyList<ServerProfile> UpdateProfile(IReadOnlyList<ServerProfile> profiles, ServerProfile updated)
        => profiles.Select(p => p.Id == updated.Id ? updated : p).ToList();

    public void SaveProfiles(IReadOnlyList<ServerProfile> profiles)
    {
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(_path, JsonSerializer.Serialize(profiles));
    }
}

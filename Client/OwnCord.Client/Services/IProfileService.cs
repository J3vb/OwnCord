using OwnCord.Client.Models;

namespace OwnCord.Client.Services;

public interface IProfileService
{
    IReadOnlyList<ServerProfile> LoadProfiles();
    IReadOnlyList<ServerProfile> AddProfile(IReadOnlyList<ServerProfile> profiles, ServerProfile profile);
    IReadOnlyList<ServerProfile> RemoveProfile(IReadOnlyList<ServerProfile> profiles, string id);
    IReadOnlyList<ServerProfile> UpdateProfile(IReadOnlyList<ServerProfile> profiles, ServerProfile updated);
    void SaveProfiles(IReadOnlyList<ServerProfile> profiles);
}

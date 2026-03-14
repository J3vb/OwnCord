namespace OwnCord.Client.Models;

public record ServerProfile(
    string Id,
    string Name,
    string Host,
    string? LastUsername,
    bool AutoConnect
)
{
    public static ServerProfile Create(string name, string host, string? lastUsername = null, bool autoConnect = false)
        => new(Guid.NewGuid().ToString(), name, host, lastUsername, autoConnect);
}

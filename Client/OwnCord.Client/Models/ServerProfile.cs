using System.Text.Json.Serialization;

namespace OwnCord.Client.Models;

public record ServerProfile(
    string Id,
    string Name,
    string Host,
    string? LastUsername,
    bool AutoConnect,
    [property: JsonPropertyName("port")] int Port = 8443,
    [property: JsonPropertyName("color")] string Color = "#5865f2",
    [property: JsonPropertyName("last_connected")] DateTime? LastConnected = null
)
{
    public static ServerProfile Create(
        string name,
        string host,
        string? lastUsername = null,
        bool autoConnect = false,
        int port = 8443,
        string color = "#5865f2")
        => new(Guid.NewGuid().ToString(), name, host, lastUsername, autoConnect, port, color, null);

    /// <summary>Returns host:port for display, omitting port if it is the default 8443.</summary>
    public string HostDisplay => Port == 8443 ? Host : $"{Host}:{Port}";
}

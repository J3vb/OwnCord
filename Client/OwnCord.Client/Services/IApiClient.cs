using OwnCord.Client.Models;

namespace OwnCord.Client.Services;

/// <summary>REST API client for the OwnCord server.</summary>
public interface IApiClient
{
    Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct = default);
    Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct = default);
    Task LogoutAsync(string host, string token, CancellationToken ct = default);
    Task<ApiUser> GetMeAsync(string host, string token, CancellationToken ct = default);
    Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(string host, string token, CancellationToken ct = default);
    Task<MessagesResponse> GetMessagesAsync(string host, string token, long channelId, int limit = 50, long? before = null, CancellationToken ct = default);
    Task<HealthResponse> HealthCheckAsync(string host, CancellationToken ct = default);
    Task<AuthResponse> VerifyTotpAsync(string host, string partialToken, string code, CancellationToken ct = default);
}

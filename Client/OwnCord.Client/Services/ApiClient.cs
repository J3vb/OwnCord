using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OwnCord.Client.Models;

namespace OwnCord.Client.Services;

/// <summary>
/// HTTP REST client for the OwnCord server API.
/// </summary>
public sealed class ApiClient : IApiClient
{
    private readonly HttpClient _http;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true
    };

    public ApiClient(HttpClient http)
    {
        _http = http;
    }

    /// <summary>
    /// Creates an ApiClient that uses Trust-On-First-Use (TOFU) certificate pinning.
    /// On first connection to a host, the server's self-signed certificate SHA-256 fingerprint
    /// is stored. Subsequent connections must present the same fingerprint.
    /// </summary>
    public static ApiClient CreateWithTofuTls(ICertificateTrustService trustService)
    {
        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (_, cert, _, _) =>
            {
                if (cert == null) return false;
                var fingerprint = cert.GetCertHashString(HashAlgorithmName.SHA256);
                // Extract host:port from the request — the cert object has no request URL,
                // but the HttpClient passes the request URI via the first argument (HttpRequestMessage).
                // Unfortunately the standard callback signature does not expose it directly,
                // so we store it as an ambient value set before each request.
                // Fail closed: if the host context is missing, reject the connection.
                // Never fall back to cert.Subject — an attacker controls that value.
                var host = TofuHostContext.CurrentHost;
                if (host == null) return false;
                return trustService.IsTrusted(host, fingerprint);
            }
        };
        var http = new HttpClient(handler);
        http.DefaultRequestHeaders.Add("User-Agent", "OwnCord-Client/0.1.0");
        return new ApiClient(http);
    }

    public async Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct = default)
    {
        var body = new { username, password };
        var response = await PostJsonAsync(host, "/api/v1/auth/login", body, ct);
        return await ReadOrThrowAsync<AuthResponse>(response, ct);
    }

    public async Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct = default)
    {
        var body = new { username, password, invite_code = inviteCode };
        var response = await PostJsonAsync(host, "/api/v1/auth/register", body, ct);
        return await ReadOrThrowAsync<AuthResponse>(response, ct);
    }

    public async Task LogoutAsync(string host, string token, CancellationToken ct = default)
    {
        TofuHostContext.CurrentHost = NormalizeHost(host);
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Post, BuildUrl(host, "/api/v1/auth/logout"));
            request.Headers.Add("Authorization", $"Bearer {token}");
            var response = await _http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
                await ThrowApiExceptionAsync(response, ct);
        }
        finally
        {
            TofuHostContext.CurrentHost = null;
        }
    }

    public async Task<ApiUser> GetMeAsync(string host, string token, CancellationToken ct = default)
    {
        var response = await GetAuthenticatedAsync(host, "/api/v1/auth/me", token, ct);
        return await ReadOrThrowAsync<ApiUser>(response, ct);
    }

    public async Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(string host, string token, CancellationToken ct = default)
    {
        var response = await GetAuthenticatedAsync(host, "/api/v1/channels", token, ct);
        return await ReadOrThrowAsync<List<ApiChannel>>(response, ct);
    }

    public async Task<MessagesResponse> GetMessagesAsync(string host, string token, long channelId, int limit = 50, long? before = null, CancellationToken ct = default)
    {
        var path = $"/api/v1/channels/{channelId}/messages?limit={limit}";
        if (before.HasValue)
            path += $"&before={before.Value}";

        var response = await GetAuthenticatedAsync(host, path, token, ct);
        return await ReadOrThrowAsync<MessagesResponse>(response, ct);
    }

    public async Task<HealthResponse> HealthCheckAsync(string host, CancellationToken ct = default)
    {
        TofuHostContext.CurrentHost = NormalizeHost(host);
        try
        {
            var response = await _http.GetAsync(BuildUrl(host, "/health"), ct);
            return await ReadOrThrowAsync<HealthResponse>(response, ct);
        }
        finally
        {
            TofuHostContext.CurrentHost = null;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static string BuildUrl(string host, string path)
        => $"https://{NormalizeHost(host)}{path}";

    /// <summary>
    /// Strips any scheme prefix and trailing slashes so both ApiClient and
    /// ChatService can build correct URLs from the raw user input.
    /// e.g. "https://example.com:8443/" → "example.com:8443"
    ///      "http://example.com"        → "example.com"
    ///      "example.com:8443"          → "example.com:8443"
    /// </summary>
    internal static string NormalizeHost(string host)
    {
        host = host.Trim();
        if (host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            host = host["https://".Length..];
        else if (host.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            host = host["http://".Length..];
        return host.TrimEnd('/');
    }

    private async Task<HttpResponseMessage> PostJsonAsync(string host, string path, object body, CancellationToken ct)
    {
        TofuHostContext.CurrentHost = NormalizeHost(host);
        try
        {
            var json = JsonSerializer.Serialize(body, JsonOpts);
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            return await _http.PostAsync(BuildUrl(host, path), content, ct);
        }
        finally
        {
            TofuHostContext.CurrentHost = null;
        }
    }

    private async Task<HttpResponseMessage> GetAuthenticatedAsync(string host, string path, string token, CancellationToken ct)
    {
        TofuHostContext.CurrentHost = NormalizeHost(host);
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, BuildUrl(host, path));
            request.Headers.Add("Authorization", $"Bearer {token}");
            return await _http.SendAsync(request, ct);
        }
        finally
        {
            TofuHostContext.CurrentHost = null;
        }
    }

    private static async Task<T> ReadOrThrowAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        var body = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            try
            {
                var error = JsonSerializer.Deserialize<ApiError>(body, JsonOpts);
                throw new ApiException(
                    error?.Error ?? "UNKNOWN",
                    error?.Message ?? response.ReasonPhrase ?? "Request failed",
                    (int)response.StatusCode);
            }
            catch (JsonException)
            {
                throw new ApiException("UNKNOWN", body, (int)response.StatusCode);
            }
        }

        return JsonSerializer.Deserialize<T>(body, JsonOpts)
            ?? throw new ApiException("PARSE_ERROR", "Failed to deserialize response", (int)response.StatusCode);
    }

    private static async Task ThrowApiExceptionAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var body = await response.Content.ReadAsStringAsync(ct);
        try
        {
            var error = JsonSerializer.Deserialize<ApiError>(body, JsonOpts);
            throw new ApiException(
                error?.Error ?? "UNKNOWN",
                error?.Message ?? "Request failed",
                (int)response.StatusCode);
        }
        catch (JsonException)
        {
            throw new ApiException("UNKNOWN", body, (int)response.StatusCode);
        }
    }
}

using System.Net;
using System.Net.Http;
using System.Text.Json;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.Tests.Services;

public class ApiClientTests
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private static ApiClient CreateClient(HttpMessageHandler handler)
    {
        var http = new HttpClient(handler);
        return new ApiClient(http);
    }

    private static FakeHandler Ok(object body) =>
        new(HttpStatusCode.OK, JsonSerializer.Serialize(body, JsonOpts));

    private static FakeHandler Created(object body) =>
        new(HttpStatusCode.Created, JsonSerializer.Serialize(body, JsonOpts));

    private static FakeHandler Error(HttpStatusCode code, string errorCode, string message) =>
        new(code, JsonSerializer.Serialize(new { error = errorCode, message }, JsonOpts));

    // ── Login ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task LoginAsync_Success_ReturnsTokenAndUser()
    {
        var handler = Ok(new
        {
            token = "abc123",
            user = new { id = 1, username = "alice", avatar = (string?)null, status = "online", role_id = 1, created_at = "2026-01-01T00:00:00Z" }
        });
        var client = CreateClient(handler);

        var result = await client.LoginAsync("localhost:8443", "alice", "password");

        Assert.Equal("abc123", result.Token);
        Assert.Equal("alice", result.User.Username);
        Assert.Equal(1, result.User.Id);
        Assert.Equal(1, result.User.RoleId);
        Assert.Contains("/api/v1/auth/login", handler.LastRequestUri!);
        Assert.Equal(HttpMethod.Post, handler.LastMethod);
    }

    [Fact]
    public async Task LoginAsync_InvalidCredentials_ThrowsApiException()
    {
        var handler = Error(HttpStatusCode.Unauthorized, "UNAUTHORIZED", "invalid credentials");
        var client = CreateClient(handler);

        var ex = await Assert.ThrowsAsync<ApiException>(
            () => client.LoginAsync("localhost:8443", "alice", "wrong"));

        Assert.Equal("UNAUTHORIZED", ex.ErrorCode);
        Assert.Equal(401, ex.StatusCode);
    }

    // ── Register ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task RegisterAsync_Success_ReturnsTokenAndUser()
    {
        var handler = Created(new
        {
            token = "newtoken",
            user = new { id = 2, username = "bob", avatar = (string?)null, status = "online", role_id = 4, created_at = "2026-01-01T00:00:00Z" }
        });
        var client = CreateClient(handler);

        var result = await client.RegisterAsync("localhost:8443", "bob", "password", "invite123");

        Assert.Equal("newtoken", result.Token);
        Assert.Equal("bob", result.User.Username);
        Assert.Contains("/api/v1/auth/register", handler.LastRequestUri!);
    }

    [Fact]
    public async Task RegisterAsync_BadInvite_ThrowsApiException()
    {
        var handler = Error(HttpStatusCode.BadRequest, "INVALID_CREDENTIALS", "invalid invite or credentials");
        var client = CreateClient(handler);

        var ex = await Assert.ThrowsAsync<ApiException>(
            () => client.RegisterAsync("localhost:8443", "bob", "pass", "badinvite"));

        Assert.Equal("INVALID_CREDENTIALS", ex.ErrorCode);
        Assert.Equal(400, ex.StatusCode);
    }

    // ── GetChannels ──────────────────────────────────────────────────────────

    [Fact]
    public async Task GetChannelsAsync_ReturnsChannelList()
    {
        var handler = Ok(new[]
        {
            new { id = 1, name = "general", type = "text", category = "Chat", topic = "", position = 0, slow_mode = 0, archived = false, created_at = "2026-01-01T00:00:00Z" },
            new { id = 2, name = "voice", type = "voice", category = "Voice", topic = "", position = 1, slow_mode = 0, archived = false, created_at = "2026-01-01T00:00:00Z" }
        });
        var client = CreateClient(handler);

        var channels = await client.GetChannelsAsync("localhost:8443", "token123");

        Assert.Equal(2, channels.Count);
        Assert.Equal("general", channels[0].Name);
        Assert.Equal("voice", channels[1].Name);
        Assert.Contains("Bearer token123", handler.LastAuthHeader!);
    }

    // ── GetMessages ──────────────────────────────────────────────────────────

    [Fact]
    public async Task GetMessagesAsync_ReturnsMessagesWithHasMore()
    {
        var handler = Ok(new
        {
            messages = new[]
            {
                new { id = 10, channel_id = 1, user_id = 1, content = "hello", reply_to = (long?)null, edited_at = (string?)null, deleted = false, pinned = false, timestamp = "2026-01-01T00:00:00Z", username = "alice", avatar = (string?)null }
            },
            has_more = true
        });
        var client = CreateClient(handler);

        var result = await client.GetMessagesAsync("localhost:8443", "token", 1);

        Assert.Single(result.Messages);
        Assert.Equal("hello", result.Messages[0].Content);
        Assert.True(result.HasMore);
    }

    [Fact]
    public async Task GetMessagesAsync_WithBeforeParam_IncludesInUrl()
    {
        var handler = Ok(new { messages = Array.Empty<object>(), has_more = false });
        var client = CreateClient(handler);

        await client.GetMessagesAsync("localhost:8443", "token", 1, limit: 25, before: 100);

        Assert.Contains("before=100", handler.LastRequestUri!);
        Assert.Contains("limit=25", handler.LastRequestUri!);
    }

    // ── Health ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task HealthCheckAsync_ReturnsStatusAndVersion()
    {
        var handler = Ok(new { status = "ok", version = "1.0.0" });
        var client = CreateClient(handler);

        var result = await client.HealthCheckAsync("localhost:8443");

        Assert.Equal("ok", result.Status);
        Assert.Equal("1.0.0", result.Version);
    }

    // ── Network error ────────────────────────────────────────────────────────

    [Fact]
    public async Task LoginAsync_NetworkError_ThrowsHttpRequestException()
    {
        var handler = new FakeHandler(new HttpRequestException("Connection refused"));
        var client = CreateClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(
            () => client.LoginAsync("unreachable:8443", "alice", "pass"));
    }

    // ── Fake handler ─────────────────────────────────────────────────────────

    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _code;
        private readonly string? _body;
        private readonly Exception? _exception;

        public string? LastRequestUri { get; private set; }
        public string? LastAuthHeader { get; private set; }
        public HttpMethod? LastMethod { get; private set; }
        public string? LastRequestBody { get; private set; }

        public FakeHandler(HttpStatusCode code, string body)
        {
            _code = code;
            _body = body;
        }

        public FakeHandler(Exception exception)
        {
            _exception = exception;
            _code = default;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (_exception is not null) throw _exception;

            LastRequestUri = request.RequestUri?.ToString();
            LastMethod = request.Method;
            LastAuthHeader = request.Headers.Authorization?.ToString();
            if (request.Content is not null)
                LastRequestBody = await request.Content.ReadAsStringAsync(ct);

            return new HttpResponseMessage(_code)
            {
                Content = new StringContent(_body!, System.Text.Encoding.UTF8, "application/json")
            };
        }
    }
}

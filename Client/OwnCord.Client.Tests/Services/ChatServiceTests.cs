using System.Net.WebSockets;
using System.Text.Json;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.Tests.Services;

// ── Fakes ────────────────────────────────────────────────────────────────────

public class FakeApiClient : IApiClient
{
    public AuthResponse? LoginResult { get; set; }
    public AuthResponse? RegisterResult { get; set; }
    public IReadOnlyList<ApiChannel>? ChannelsResult { get; set; }
    public MessagesResponse? MessagesResult { get; set; }
    public HealthResponse? HealthResult { get; set; }
    public ApiUser? MeResult { get; set; }

    public string? LastLoginHost { get; private set; }
    public string? LastLoginUsername { get; private set; }
    public bool LogoutCalled { get; private set; }
    public int LoginCallCount { get; private set; }

    public Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct)
    {
        LastLoginHost = host;
        LastLoginUsername = username;
        LoginCallCount++;
        return Task.FromResult(LoginResult ?? throw new InvalidOperationException("LoginResult not set"));
    }

    public Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct)
        => Task.FromResult(RegisterResult ?? throw new InvalidOperationException("RegisterResult not set"));

    public Task LogoutAsync(string host, string token, CancellationToken ct)
    {
        LogoutCalled = true;
        return Task.CompletedTask;
    }

    public Task<ApiUser> GetMeAsync(string host, string token, CancellationToken ct)
        => Task.FromResult(MeResult ?? throw new InvalidOperationException("MeResult not set"));

    public Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(string host, string token, CancellationToken ct)
        => Task.FromResult(ChannelsResult ?? throw new InvalidOperationException("ChannelsResult not set"));

    public Task<MessagesResponse> GetMessagesAsync(string host, string token, long channelId, int limit, long? before, CancellationToken ct)
        => Task.FromResult(MessagesResult ?? throw new InvalidOperationException("MessagesResult not set"));

    public Task<HealthResponse> HealthCheckAsync(string host, CancellationToken ct)
        => Task.FromResult(HealthResult ?? throw new InvalidOperationException("HealthResult not set"));
}

public class FakeWebSocketService : IWebSocketService
{
    public bool IsConnected { get; set; }
    public WebSocketState State { get; set; } = WebSocketState.None;

    public event Action<string>? MessageReceived;
    public event Action? Disconnected;

    public string? LastConnectUri { get; private set; }
    public string? LastConnectToken { get; private set; }
    public bool DisconnectCalled { get; private set; }
    public List<string> SentMessages { get; } = new();
    public bool RunReceiveLoopStarted { get; private set; }

    public Task ConnectAsync(string uri, string token, CancellationToken ct)
    {
        LastConnectUri = uri;
        LastConnectToken = token;
        IsConnected = true;
        State = WebSocketState.Open;
        return Task.CompletedTask;
    }

    public Task SendAsync(object message, CancellationToken ct)
    {
        SentMessages.Add(JsonSerializer.Serialize(message));
        return Task.CompletedTask;
    }

    public Task RunReceiveLoopAsync(CancellationToken ct)
    {
        RunReceiveLoopStarted = true;
        // Don't block — just record that it was called
        return Task.CompletedTask;
    }

    public IAsyncEnumerable<string> ReceiveAsync(CancellationToken ct) => throw new NotImplementedException();

    public Task DisconnectAsync()
    {
        DisconnectCalled = true;
        IsConnected = false;
        State = WebSocketState.Closed;
        return Task.CompletedTask;
    }

    // Test helpers to simulate server messages
    public void SimulateMessage(string json) => MessageReceived?.Invoke(json);
    public void SimulateDisconnect()
    {
        IsConnected = false;
        State = WebSocketState.Closed;
        Disconnected?.Invoke();
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

public class ChatServiceTests
{
    private static readonly ApiUser TestUser = new(1, "alice", null, "online", 1, "2026-01-01T00:00:00Z");
    private static readonly AuthResponse TestAuthResponse = new("tok_abc", TestUser);

    private readonly FakeApiClient _api = new();
    private readonly FakeWebSocketService _ws = new();

    private ChatService CreateService() => new(_api, _ws);

    // ── Login ────────────────────────────────────────────────────────────

    [Fact]
    public async Task LoginAsync_CallsApiAndStoresState()
    {
        _api.LoginResult = TestAuthResponse;
        var svc = CreateService();

        var result = await svc.LoginAsync("localhost:8443", "alice", "password");

        Assert.Equal("tok_abc", result.Token);
        Assert.Equal("alice", result.User.Username);
        Assert.Equal("tok_abc", svc.CurrentToken);
        Assert.Equal("alice", svc.CurrentUser?.Username);
        Assert.Equal("localhost:8443", _api.LastLoginHost);
    }

    [Fact]
    public async Task LoginAsync_PropagatesApiException()
    {
        _api.LoginResult = null; // will throw
        var svc = CreateService();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => svc.LoginAsync("host", "user", "pass"));
    }

    // ── Logout ───────────────────────────────────────────────────────────

    [Fact]
    public async Task LogoutAsync_DisconnectsAndClearsState()
    {
        _api.LoginResult = TestAuthResponse;
        var svc = CreateService();
        await svc.LoginAsync("localhost:8443", "alice", "pass");

        await svc.LogoutAsync();

        Assert.True(_api.LogoutCalled);
        Assert.True(_ws.DisconnectCalled);
        Assert.Null(svc.CurrentToken);
        Assert.Null(svc.CurrentUser);
    }

    // ── WebSocket connect ────────────────────────────────────────────────

    [Fact]
    public async Task ConnectWebSocketAsync_ConnectsWithCorrectUri()
    {
        var svc = CreateService();

        await svc.ConnectWebSocketAsync("localhost:8443", "tok_abc");

        Assert.Equal("wss://localhost:8443/api/v1/ws", _ws.LastConnectUri);
        Assert.Equal("tok_abc", _ws.LastConnectToken);
        Assert.True(svc.IsConnected);
    }

    // ── Message dispatch (server → client events) ────────────────────────

    [Fact]
    public async Task Dispatches_AuthOk_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        AuthOkPayload? received = null;
        svc.AuthOk += p => received = p;

        var json = """
        { "type": "auth_ok", "payload": { "user": { "id": 1, "username": "alice", "avatar": null, "status": "online" }, "server_name": "Test", "motd": "Hi" } }
        """;
        _ws.SimulateMessage(json);

        Assert.NotNull(received);
        Assert.Equal("alice", received!.User.Username);
        Assert.Equal("Test", received.ServerName);
    }

    [Fact]
    public async Task Dispatches_Ready_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        ReadyPayload? received = null;
        svc.Ready += p => received = p;

        var json = """
        { "type": "ready", "payload": { "channels": [], "members": [], "voice_states": [], "roles": [] } }
        """;
        _ws.SimulateMessage(json);

        Assert.NotNull(received);
        Assert.Empty(received!.Channels);
    }

    [Fact]
    public async Task Dispatches_ChatMessage_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        ChatMessagePayload? received = null;
        svc.ChatMessageReceived += p => received = p;

        var json = """
        { "type": "chat_message", "payload": { "id": 42, "channel_id": 1, "user": { "id": 1, "username": "alice", "avatar": null }, "content": "Hello!", "reply_to": null, "timestamp": "2026-01-01T00:00:00Z" } }
        """;
        _ws.SimulateMessage(json);

        Assert.NotNull(received);
        Assert.Equal(42, received!.Id);
        Assert.Equal("Hello!", received.Content);
    }

    [Fact]
    public async Task Dispatches_Typing_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        TypingPayload? received = null;
        svc.TypingReceived += p => received = p;

        _ws.SimulateMessage("""{ "type": "typing", "payload": { "channel_id": 1, "user_id": 2, "username": "bob" } }""");

        Assert.NotNull(received);
        Assert.Equal("bob", received!.Username);
    }

    [Fact]
    public async Task Dispatches_Presence_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        PresencePayload? received = null;
        svc.PresenceChanged += p => received = p;

        _ws.SimulateMessage("""{ "type": "presence", "payload": { "user_id": 3, "status": "idle" } }""");

        Assert.NotNull(received);
        Assert.Equal("idle", received!.Status);
    }

    [Fact]
    public async Task Dispatches_Error_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        WsErrorPayload? received = null;
        svc.ErrorReceived += p => received = p;

        _ws.SimulateMessage("""{ "type": "error", "id": "req-1", "payload": { "code": "RATE_LIMITED", "message": "slow down" } }""");

        Assert.NotNull(received);
        Assert.Equal("RATE_LIMITED", received!.Code);
    }

    [Fact]
    public async Task Dispatches_ChatEdited_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        ChatEditedPayload? received = null;
        svc.ChatEdited += p => received = p;

        _ws.SimulateMessage("""{ "type": "chat_edited", "payload": { "message_id": 10, "channel_id": 1, "content": "edited", "edited_at": "2026-01-01T00:00:00Z" } }""");

        Assert.NotNull(received);
        Assert.Equal("edited", received!.Content);
    }

    [Fact]
    public async Task Dispatches_ChatDeleted_Event()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        ChatDeletedPayload? received = null;
        svc.ChatDeleted += p => received = p;

        _ws.SimulateMessage("""{ "type": "chat_deleted", "payload": { "message_id": 10, "channel_id": 1 } }""");

        Assert.NotNull(received);
        Assert.Equal(10, received!.MessageId);
    }

    // ── Send message ─────────────────────────────────────────────────────

    [Fact]
    public async Task SendMessageAsync_SendsCorrectEnvelope()
    {
        _api.LoginResult = TestAuthResponse;
        var svc = CreateService();
        await svc.LoginAsync("host:8443", "alice", "pass");
        await svc.ConnectWebSocketAsync("host:8443", "tok_abc");

        await svc.SendMessageAsync(1, "Hello!", replyTo: 5);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("chat_send", sent.RootElement.GetProperty("type").GetString());
        Assert.Equal(1, sent.RootElement.GetProperty("payload").GetProperty("channel_id").GetInt64());
        Assert.Equal("Hello!", sent.RootElement.GetProperty("payload").GetProperty("content").GetString());
        Assert.Equal(5, sent.RootElement.GetProperty("payload").GetProperty("reply_to").GetInt64());
    }

    [Fact]
    public async Task SendTypingAsync_SendsCorrectEnvelope()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        await svc.SendTypingAsync(1);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("typing_start", sent.RootElement.GetProperty("type").GetString());
        Assert.Equal(1, sent.RootElement.GetProperty("payload").GetProperty("channel_id").GetInt64());
    }

    // ── REST data fetches ────────────────────────────────────────────────

    [Fact]
    public async Task GetChannelsAsync_UsesStoredHostAndToken()
    {
        _api.LoginResult = TestAuthResponse;
        _api.ChannelsResult = new List<ApiChannel>
        {
            new(1, "general", "text", "Chat", "", 0, 0, false, "2026-01-01T00:00:00Z")
        };

        var svc = CreateService();
        await svc.LoginAsync("localhost:8443", "alice", "pass");

        var channels = await svc.GetChannelsAsync();

        Assert.Single(channels);
        Assert.Equal("general", channels[0].Name);
    }

    [Fact]
    public async Task GetMessagesAsync_PassesParameters()
    {
        _api.LoginResult = TestAuthResponse;
        _api.MessagesResult = new MessagesResponse(
            new List<ApiMessage> { new(1, 1, 1, "hi", null, null, false, false, "2026-01-01T00:00:00Z", "alice", null) },
            false
        );

        var svc = CreateService();
        await svc.LoginAsync("localhost:8443", "alice", "pass");

        var result = await svc.GetMessagesAsync(1, limit: 25, before: 100);

        Assert.Single(result.Messages);
        Assert.False(result.HasMore);
    }

    // ── Disconnection event ──────────────────────────────────────────────

    [Fact]
    public async Task ConnectionLost_FiresOnDisconnect()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        string? reason = null;
        svc.ConnectionLost += r => reason = r;

        _ws.SimulateDisconnect();

        Assert.NotNull(reason);
        Assert.False(svc.IsConnected);
    }

    // ── Unknown message type is silently ignored ─────────────────────────

    [Fact]
    public async Task UnknownMessageType_DoesNotThrow()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");

        var exception = Record.Exception(() =>
            _ws.SimulateMessage("""{ "type": "unknown_future_type", "payload": {} }"""));

        Assert.Null(exception);
    }
}

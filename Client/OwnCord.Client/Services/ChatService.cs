using System.Text.Json;
using OwnCord.Client.Models;

namespace OwnCord.Client.Services;

/// <summary>
/// Orchestrates REST API calls and WebSocket lifecycle.
/// ViewModels depend on this — never on IApiClient or IWebSocketService directly.
/// </summary>
public sealed class ChatService : IChatService
{
    private readonly IApiClient _api;
    private readonly IWebSocketService _ws;

    private string? _host;
    private CancellationTokenSource? _reconnectCts;
    private bool _intentionalDisconnect;

    public bool IsConnected => _ws.IsConnected;
    public string? CurrentToken { get; private set; }
    public ApiUser? CurrentUser { get; private set; }

    // ── Events ──────────────────────────────────────────────────────────────

    public event Action<AuthOkPayload>? AuthOk;
    public event Action<ReadyPayload>? Ready;
    public event Action<ChatMessagePayload>? ChatMessageReceived;
    public event Action<ChatSendOkPayload>? ChatSendOk;
    public event Action<ChatEditedPayload>? ChatEdited;
    public event Action<ChatDeletedPayload>? ChatDeleted;
    public event Action<TypingPayload>? TypingReceived;
    public event Action<PresencePayload>? PresenceChanged;
    public event Action<ReactionUpdatePayload>? ReactionUpdated;
    public event Action<WsErrorPayload>? ErrorReceived;
    public event Action<ServerRestartPayload>? ServerRestarting;
    public event Action<WsMember>? MemberJoined;
    public event Action<ChannelEventPayload>? ChannelCreated;
    public event Action<ChannelEventPayload>? ChannelUpdated;
    public event Action<long>? ChannelDeleted;
    public event Action<string>? ConnectionLost;

    public ChatService(IApiClient api, IWebSocketService ws)
    {
        _api = api;
        _ws = ws;

        _ws.MessageReceived += OnMessageReceived;
        _ws.Disconnected += OnDisconnected;
    }

    // ── Auth ────────────────────────────────────────────────────────────────

    public async Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct = default)
    {
        var result = await _api.LoginAsync(host, username, password, ct);
        _host = ApiClient.NormalizeHost(host);
        CurrentToken = result.Token;
        CurrentUser = result.User;
        return result;
    }

    public async Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct = default)
    {
        var result = await _api.RegisterAsync(host, username, password, inviteCode, ct);
        _host = ApiClient.NormalizeHost(host);
        CurrentToken = result.Token;
        CurrentUser = result.User;
        return result;
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        _intentionalDisconnect = true;
        _reconnectCts?.Cancel();

        if (_host is not null && CurrentToken is not null)
            await _api.LogoutAsync(_host, CurrentToken, ct);

        await _ws.DisconnectAsync();
        CurrentToken = null;
        CurrentUser = null;
        _host = null;
    }

    // ── WebSocket lifecycle ─────────────────────────────────────────────────

    public async Task ConnectWebSocketAsync(string host, string token, CancellationToken ct = default)
    {
        _intentionalDisconnect = false;
        _reconnectCts?.Cancel();
        _reconnectCts = new CancellationTokenSource();

        var wsUri = $"wss://{ApiClient.NormalizeHost(host)}/api/v1/ws";
        await _ws.ConnectAsync(wsUri, token, ct);
        _ = RunReceiveLoopWithErrorHandlingAsync(ct);
    }

    private async Task RunReceiveLoopWithErrorHandlingAsync(CancellationToken ct)
    {
        try
        {
            await _ws.RunReceiveLoopAsync(ct);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown — ignore
        }
        catch (Exception ex)
        {
            ConnectionLost?.Invoke($"Receive loop error: {ex.Message}");
        }
    }

    public Task DisconnectWebSocketAsync()
    {
        _intentionalDisconnect = true;
        _reconnectCts?.Cancel();
        return _ws.DisconnectAsync();
    }

    // ── REST data fetches ───────────────────────────────────────────────────

    public Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(CancellationToken ct = default)
        => _api.GetChannelsAsync(_host!, CurrentToken!, ct);

    public Task<MessagesResponse> GetMessagesAsync(long channelId, int limit = 50, long? before = null, CancellationToken ct = default)
        => _api.GetMessagesAsync(_host!, CurrentToken!, channelId, limit, before, ct);

    // ── Outbound actions ────────────────────────────────────────────────────

    public Task SendMessageAsync(long channelId, string content, long? replyTo = null, CancellationToken ct = default)
    {
        var envelope = new
        {
            type = "chat_send",
            id = Guid.NewGuid().ToString(),
            payload = new { channel_id = channelId, content, reply_to = replyTo }
        };
        return _ws.SendAsync(envelope, ct);
    }

    public Task SendTypingAsync(long channelId, CancellationToken ct = default)
    {
        var envelope = new
        {
            type = "typing_start",
            payload = new { channel_id = channelId }
        };
        return _ws.SendAsync(envelope, ct);
    }

    public Task SendChannelFocusAsync(long channelId, CancellationToken ct = default)
    {
        var envelope = new
        {
            type = "channel_focus",
            payload = new { channel_id = channelId }
        };
        return _ws.SendAsync(envelope, ct);
    }

    // ── Inbound message dispatch ────────────────────────────────────────────

    private void OnMessageReceived(string json)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<WsEnvelope>(json);
            if (envelope is null) return;

            switch (envelope.Type)
            {
                case "auth_ok":
                    AuthOk?.Invoke(Deserialize<AuthOkPayload>(envelope));
                    break;
                case "ready":
                    Ready?.Invoke(Deserialize<ReadyPayload>(envelope));
                    break;
                case "chat_message":
                    ChatMessageReceived?.Invoke(Deserialize<ChatMessagePayload>(envelope));
                    break;
                case "chat_send_ok":
                    ChatSendOk?.Invoke(Deserialize<ChatSendOkPayload>(envelope));
                    break;
                case "chat_edited":
                    ChatEdited?.Invoke(Deserialize<ChatEditedPayload>(envelope));
                    break;
                case "chat_deleted":
                    ChatDeleted?.Invoke(Deserialize<ChatDeletedPayload>(envelope));
                    break;
                case "typing":
                    TypingReceived?.Invoke(Deserialize<TypingPayload>(envelope));
                    break;
                case "presence":
                    PresenceChanged?.Invoke(Deserialize<PresencePayload>(envelope));
                    break;
                case "reaction_update":
                    ReactionUpdated?.Invoke(Deserialize<ReactionUpdatePayload>(envelope));
                    break;
                case "error":
                    ErrorReceived?.Invoke(Deserialize<WsErrorPayload>(envelope));
                    break;
                case "server_restart":
                    ServerRestarting?.Invoke(Deserialize<ServerRestartPayload>(envelope));
                    break;
                case "member_join":
                    MemberJoined?.Invoke(Deserialize<WsMember>(envelope));
                    break;
                case "channel_create":
                    ChannelCreated?.Invoke(Deserialize<ChannelEventPayload>(envelope));
                    break;
                case "channel_update":
                    ChannelUpdated?.Invoke(Deserialize<ChannelEventPayload>(envelope));
                    break;
                case "channel_delete":
                    var delPayload = envelope.Payload?.Deserialize<JsonElement>();
                    if (delPayload?.TryGetProperty("id", out var idEl) == true)
                        ChannelDeleted?.Invoke(idEl.GetInt64());
                    break;
                // Unknown types silently ignored — forward compatibility
            }
        }
        catch (JsonException)
        {
            // Malformed message — don't crash the receive loop
        }
    }

    private void OnDisconnected()
    {
        ConnectionLost?.Invoke("WebSocket connection lost");

        if (!_intentionalDisconnect && _host is not null && CurrentToken is not null)
            _ = ReconnectAsync();
    }

    private async Task ReconnectAsync()
    {
        var ct = _reconnectCts?.Token ?? default;
        var delays = new[] { 1000, 2000, 4000, 8000, 15000, 30000 };

        for (var attempt = 0; attempt < delays.Length; attempt++)
        {
            if (ct.IsCancellationRequested || _host is null || CurrentToken is null)
                return;

            try
            {
                await Task.Delay(delays[attempt], ct);
                await ConnectWebSocketAsync(_host, CurrentToken, ct);
                return; // Success
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                ConnectionLost?.Invoke($"Reconnection attempt {attempt + 1} failed");
            }
        }

        ConnectionLost?.Invoke("Could not reconnect after multiple attempts");
    }

    private static T Deserialize<T>(WsEnvelope envelope)
        => envelope.Payload!.Value.Deserialize<T>()
           ?? throw new JsonException($"Failed to deserialize {typeof(T).Name} payload");
}

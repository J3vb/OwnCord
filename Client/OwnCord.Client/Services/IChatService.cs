using OwnCord.Client.Models;

namespace OwnCord.Client.Services;

/// <summary>
/// High-level orchestrator: login/logout, WebSocket lifecycle, message dispatch.
/// ViewModels subscribe to events; they never touch IApiClient or IWebSocketService directly.
/// </summary>
public interface IChatService
{
    // ── State ───────────────────────────────────────────────────────────────

    bool IsConnected { get; }
    string? CurrentToken { get; }
    ApiUser? CurrentUser { get; }

    // ── Auth ────────────────────────────────────────────────────────────────

    Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct = default);
    Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct = default);
    Task LogoutAsync(CancellationToken ct = default);

    // ── WebSocket lifecycle ─────────────────────────────────────────────────

    Task ConnectWebSocketAsync(string host, string token, CancellationToken ct = default);
    Task DisconnectWebSocketAsync();

    // ── REST data fetches ───────────────────────────────────────────────────

    Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(CancellationToken ct = default);
    Task<MessagesResponse> GetMessagesAsync(long channelId, int limit = 50, long? before = null, CancellationToken ct = default);

    // ── Outbound actions (sent over WebSocket) ──────────────────────────────

    Task SendMessageAsync(long channelId, string content, long? replyTo = null, CancellationToken ct = default);
    Task SendTypingAsync(long channelId, CancellationToken ct = default);
    Task SendChannelFocusAsync(long channelId, CancellationToken ct = default);

    // ── Events (server → client) ────────────────────────────────────────────

    event Action<AuthOkPayload>? AuthOk;
    event Action<ReadyPayload>? Ready;
    event Action<ChatMessagePayload>? ChatMessageReceived;
    event Action<ChatSendOkPayload>? ChatSendOk;
    event Action<ChatEditedPayload>? ChatEdited;
    event Action<ChatDeletedPayload>? ChatDeleted;
    event Action<TypingPayload>? TypingReceived;
    event Action<PresencePayload>? PresenceChanged;
    event Action<ReactionUpdatePayload>? ReactionUpdated;
    event Action<WsErrorPayload>? ErrorReceived;
    event Action<ServerRestartPayload>? ServerRestarting;
    event Action<WsMember>? MemberJoined;
    event Action<ChannelEventPayload>? ChannelCreated;
    event Action<ChannelEventPayload>? ChannelUpdated;
    event Action<long>? ChannelDeleted;
    event Action<string>? ConnectionLost;
}

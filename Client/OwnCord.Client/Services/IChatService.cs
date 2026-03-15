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
    string? CurrentHost { get; }
    ApiUser? CurrentUser { get; }

    // ── Auth ────────────────────────────────────────────────────────────────

    Task<AuthResponse> LoginAsync(string host, string username, string password, CancellationToken ct = default);
    Task<AuthResponse> RegisterAsync(string host, string username, string password, string inviteCode, CancellationToken ct = default);
    Task LogoutAsync(CancellationToken ct = default);
    Task<AuthResponse> VerifyTotpAsync(string host, string partialToken, string code, CancellationToken ct = default);

    // ── WebSocket lifecycle ─────────────────────────────────────────────────

    Task ConnectWebSocketAsync(string host, string token, CancellationToken ct = default);
    Task DisconnectWebSocketAsync();

    // ── REST data fetches ───────────────────────────────────────────────────

    Task<IReadOnlyList<ApiChannel>> GetChannelsAsync(CancellationToken ct = default);
    Task<MessagesResponse> GetMessagesAsync(long channelId, int limit = 50, long? before = null, CancellationToken ct = default);

    // ── Outbound actions (sent over WebSocket) ──────────────────────────────

    Task SendMessageAsync(long channelId, string content, long? replyTo = null, CancellationToken ct = default);
    Task EditMessageAsync(long messageId, string content, CancellationToken ct = default);
    Task DeleteMessageAsync(long messageId, CancellationToken ct = default);
    Task SendTypingAsync(long channelId, CancellationToken ct = default);
    Task SendChannelFocusAsync(long channelId, CancellationToken ct = default);
    Task SendStatusChangeAsync(string status, CancellationToken ct = default);

    // ── Voice outbound actions ──────────────────────────────────────────────

    Task JoinVoiceAsync(long channelId, CancellationToken ct = default);
    Task LeaveVoiceAsync(CancellationToken ct = default);
    Task SendVoiceMuteAsync(bool muted, CancellationToken ct = default);
    Task SendVoiceDeafenAsync(bool deafened, CancellationToken ct = default);

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

    // ── Voice events ────────────────────────────────────────────────────────

    event Action<VoiceStatePayload>? VoiceStateReceived;
    event Action<VoiceLeavePayload>? VoiceLeaveReceived;
    event Action<VoiceConfigPayload>? VoiceConfigReceived;
    event Action<VoiceSpeakersPayload>? VoiceSpeakersReceived;
}

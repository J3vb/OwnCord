using System.Text.Json;
using System.Text.Json.Serialization;

namespace OwnCord.Client.Models;

/// <summary>Top-level WebSocket message envelope.</summary>
public record WsEnvelope(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("id")] string? Id,
    [property: JsonPropertyName("payload")] JsonElement? Payload
);

// ── Inbound payloads (server → client) ──────────────────────────────────────

public record AuthOkPayload(
    [property: JsonPropertyName("user")] WsUser User,
    [property: JsonPropertyName("server_name")] string ServerName,
    [property: JsonPropertyName("motd")] string? Motd
);

public record ReadyPayload(
    [property: JsonPropertyName("channels")] IReadOnlyList<ApiChannel> Channels,
    [property: JsonPropertyName("members")] IReadOnlyList<WsMember> Members,
    [property: JsonPropertyName("voice_states")] IReadOnlyList<WsVoiceState> VoiceStates,
    [property: JsonPropertyName("roles")] IReadOnlyList<WsRole> Roles
);

public record WsMember(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("avatar")] string? Avatar,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("role_id")] long RoleId
);

/// <summary>User shape in WebSocket messages (subset of ApiUser).</summary>
public record WsUser(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("avatar")] string? Avatar,
    [property: JsonPropertyName("status")] string? Status
);

public record WsRole(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("color")] string? Color,
    [property: JsonPropertyName("permissions")] long Permissions,
    [property: JsonPropertyName("position")] int Position,
    [property: JsonPropertyName("is_default")] bool IsDefault
);

public record WsVoiceState(
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("muted")] bool Muted,
    [property: JsonPropertyName("deafened")] bool Deafened,
    [property: JsonPropertyName("speaking")] bool Speaking
);

public record ChatMessagePayload(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("user")] WsUser User,
    [property: JsonPropertyName("content")] string Content,
    [property: JsonPropertyName("reply_to")] long? ReplyTo,
    [property: JsonPropertyName("timestamp")] string Timestamp,
    [property: JsonPropertyName("attachments")] IReadOnlyList<ApiAttachment>? Attachments = null
);

public record ChatSendOkPayload(
    [property: JsonPropertyName("message_id")] long MessageId,
    [property: JsonPropertyName("timestamp")] string Timestamp
);

public record ChatEditedPayload(
    [property: JsonPropertyName("message_id")] long MessageId,
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("content")] string Content,
    [property: JsonPropertyName("edited_at")] string EditedAt
);

public record ChatDeletedPayload(
    [property: JsonPropertyName("message_id")] long MessageId,
    [property: JsonPropertyName("channel_id")] long ChannelId
);

public record TypingPayload(
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("username")] string Username
);

public record PresencePayload(
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("status")] string Status
);

public record ReactionUpdatePayload(
    [property: JsonPropertyName("message_id")] long MessageId,
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("emoji")] string Emoji,
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("action")] string Action
);

public record WsErrorPayload(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message
);

public record ServerRestartPayload(
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("delay_seconds")] int DelaySeconds
);

public record ChannelEventPayload(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("category")] string? Category,
    [property: JsonPropertyName("topic")] string? Topic,
    [property: JsonPropertyName("position")] int Position
);

// ── Voice payloads ───────────────────────────────────────────────────────────

public record VoiceStatePayload(
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("muted")] bool Muted,
    [property: JsonPropertyName("deafened")] bool Deafened
);

public record VoiceLeavePayload(
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("channel_id")] long ChannelId
);

public record VoiceConfigPayload(
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("quality")] string Quality,
    [property: JsonPropertyName("bitrate")] int Bitrate,
    [property: JsonPropertyName("mode")] string Mode
);

public record VoiceSpeakersPayload(
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("speakers")] IReadOnlyList<long> Speakers,
    [property: JsonPropertyName("mode")] string Mode
);

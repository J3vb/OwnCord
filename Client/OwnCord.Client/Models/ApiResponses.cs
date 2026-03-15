using System.Text.Json.Serialization;

namespace OwnCord.Client.Models;

/// <summary>REST API response for login and register endpoints.</summary>
public record AuthResponse(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("user")] ApiUser? User,
    [property: JsonPropertyName("requires_2fa")] bool Requires2FA = false,
    [property: JsonPropertyName("partial_token")] string? PartialToken = null
);

/// <summary>User shape returned by auth endpoints.</summary>
public record ApiUser(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("avatar")] string? Avatar,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("role_id")] long RoleId,
    [property: JsonPropertyName("created_at")] string CreatedAt
);

/// <summary>Single channel from GET /api/v1/channels or ready payload.</summary>
public record ApiChannel(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("category")] string? Category,
    [property: JsonPropertyName("topic")] string? Topic,
    [property: JsonPropertyName("position")] int Position,
    [property: JsonPropertyName("slow_mode")] int SlowMode,
    [property: JsonPropertyName("archived")] bool Archived,
    [property: JsonPropertyName("created_at")] string CreatedAt
);

/// <summary>Response from GET /api/v1/channels/{id}/messages.</summary>
public record MessagesResponse(
    [property: JsonPropertyName("messages")] IReadOnlyList<ApiMessage> Messages,
    [property: JsonPropertyName("has_more")] bool HasMore
);

/// <summary>Single message from the REST API (includes flattened user fields).</summary>
public record ApiMessage(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("channel_id")] long ChannelId,
    [property: JsonPropertyName("user_id")] long UserId,
    [property: JsonPropertyName("content")] string Content,
    [property: JsonPropertyName("reply_to")] long? ReplyTo,
    [property: JsonPropertyName("edited_at")] string? EditedAt,
    [property: JsonPropertyName("deleted")] bool Deleted,
    [property: JsonPropertyName("pinned")] bool Pinned,
    [property: JsonPropertyName("timestamp")] string Timestamp,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("avatar")] string? Avatar,
    [property: JsonPropertyName("attachments")] IReadOnlyList<ApiAttachment>? Attachments = null
);

/// <summary>Single attachment from the REST API.</summary>
public record ApiAttachment(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("filename")] string Filename,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("mime")] string Mime,
    [property: JsonPropertyName("url")] string Url
);

/// <summary>Error response shape from all REST endpoints.</summary>
public record ApiError(
    [property: JsonPropertyName("error")] string Error,
    [property: JsonPropertyName("message")] string Message
);

/// <summary>Response from GET /health.</summary>
public record HealthResponse(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("version")] string Version
);

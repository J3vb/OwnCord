using System.Text.Json;
using OwnCord.Client.Models;

namespace OwnCord.Client.Tests.Models;

public class WsEnvelopeTests
{
    [Fact]
    public void Deserialize_AuthOk()
    {
        var json = """
        {
            "type": "auth_ok",
            "payload": {
                "user": { "id": 1, "username": "alice", "avatar": null, "status": "online" },
                "server_name": "My Server",
                "motd": "Welcome!"
            }
        }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        Assert.Equal("auth_ok", env.Type);
        Assert.Null(env.Id);

        var payload = env.Payload!.Value.Deserialize<AuthOkPayload>()!;
        Assert.Equal("alice", payload.User.Username);
        Assert.Equal(1, payload.User.Id);
        Assert.Equal("My Server", payload.ServerName);
        Assert.Equal("Welcome!", payload.Motd);
    }

    [Fact]
    public void Deserialize_Ready()
    {
        var json = """
        {
            "type": "ready",
            "payload": {
                "channels": [
                    { "id": 1, "name": "general", "type": "text", "category": "Chat", "topic": "", "position": 0, "slow_mode": 0, "archived": false, "created_at": "2026-01-01T00:00:00Z" }
                ],
                "members": [{ "id": 1, "username": "alice", "avatar": null, "status": "online", "role_id": 1 }],
                "voice_states": [],
                "roles": [
                    { "id": 1, "name": "Owner", "color": "#E74C3C", "permissions": 2147483647, "position": 100, "is_default": false }
                ]
            }
        }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        Assert.Equal("ready", env.Type);

        var payload = env.Payload!.Value.Deserialize<ReadyPayload>()!;
        Assert.Single(payload.Channels);
        Assert.Equal("general", payload.Channels[0].Name);
        Assert.Equal("text", payload.Channels[0].Type);
        Assert.Single(payload.Members);
        Assert.Equal("alice", payload.Members[0].Username);
        Assert.Empty(payload.VoiceStates);
        Assert.Single(payload.Roles);
        Assert.Equal("Owner", payload.Roles[0].Name);
    }

    [Fact]
    public void Deserialize_ChatMessage()
    {
        var json = """
        {
            "type": "chat_message",
            "payload": {
                "id": 42,
                "channel_id": 1,
                "user": { "id": 1, "username": "alice", "avatar": null },
                "content": "Hello world!",
                "reply_to": null,
                "timestamp": "2026-03-14T22:30:00Z"
            }
        }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        Assert.Equal("chat_message", env.Type);

        var payload = env.Payload!.Value.Deserialize<ChatMessagePayload>()!;
        Assert.Equal(42, payload.Id);
        Assert.Equal(1, payload.ChannelId);
        Assert.Equal("alice", payload.User.Username);
        Assert.Equal("Hello world!", payload.Content);
        Assert.Null(payload.ReplyTo);
    }

    [Fact]
    public void Deserialize_ChatSendOk()
    {
        var json = """
        {
            "type": "chat_send_ok",
            "id": "req-123",
            "payload": { "message_id": 42, "timestamp": "2026-03-14T22:30:00Z" }
        }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        Assert.Equal("chat_send_ok", env.Type);
        Assert.Equal("req-123", env.Id);

        var payload = env.Payload!.Value.Deserialize<ChatSendOkPayload>()!;
        Assert.Equal(42, payload.MessageId);
    }

    [Fact]
    public void Deserialize_Typing()
    {
        var json = """
        { "type": "typing", "payload": { "channel_id": 1, "user_id": 2, "username": "bob" } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        var payload = env.Payload!.Value.Deserialize<TypingPayload>()!;
        Assert.Equal(1, payload.ChannelId);
        Assert.Equal("bob", payload.Username);
    }

    [Fact]
    public void Deserialize_Presence()
    {
        var json = """
        { "type": "presence", "payload": { "user_id": 3, "status": "idle" } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        var payload = env.Payload!.Value.Deserialize<PresencePayload>()!;
        Assert.Equal(3, payload.UserId);
        Assert.Equal("idle", payload.Status);
    }

    [Fact]
    public void Deserialize_ChatEdited()
    {
        var json = """
        { "type": "chat_edited", "payload": { "message_id": 10, "channel_id": 1, "content": "edited content", "edited_at": "2026-03-14T23:00:00Z" } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        var payload = env.Payload!.Value.Deserialize<ChatEditedPayload>()!;
        Assert.Equal(10, payload.MessageId);
        Assert.Equal("edited content", payload.Content);
    }

    [Fact]
    public void Deserialize_ChatDeleted()
    {
        var json = """
        { "type": "chat_deleted", "payload": { "message_id": 10, "channel_id": 1 } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        var payload = env.Payload!.Value.Deserialize<ChatDeletedPayload>()!;
        Assert.Equal(10, payload.MessageId);
        Assert.Equal(1, payload.ChannelId);
    }

    [Fact]
    public void Deserialize_ServerRestart()
    {
        var json = """
        { "type": "server_restart", "payload": { "reason": "Update applied", "delay_seconds": 5 } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        var payload = env.Payload!.Value.Deserialize<ServerRestartPayload>()!;
        Assert.Equal("Update applied", payload.Reason);
        Assert.Equal(5, payload.DelaySeconds);
    }

    [Fact]
    public void Deserialize_Error()
    {
        var json = """
        { "type": "error", "id": "req-456", "payload": { "code": "RATE_LIMITED", "message": "slow down" } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        Assert.Equal("error", env.Type);
        Assert.Equal("req-456", env.Id);

        var payload = env.Payload!.Value.Deserialize<WsErrorPayload>()!;
        Assert.Equal("RATE_LIMITED", payload.Code);
    }

    [Fact]
    public void Deserialize_ReactionUpdate()
    {
        var json = """
        { "type": "reaction_update", "payload": { "message_id": 5, "channel_id": 1, "emoji": "👍", "user_id": 2, "action": "add" } }
        """;

        var env = JsonSerializer.Deserialize<WsEnvelope>(json)!;
        var payload = env.Payload!.Value.Deserialize<ReactionUpdatePayload>()!;
        Assert.Equal(5, payload.MessageId);
        Assert.Equal("👍", payload.Emoji);
        Assert.Equal("add", payload.Action);
    }
}

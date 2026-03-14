using System.Text.Json;
using OwnCord.Client.Models;

namespace OwnCord.Client.Tests.Models;

public class ApiResponseTests
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true
    };

    [Fact]
    public void Deserialize_AuthResponse()
    {
        var json = """
        {
            "token": "abc123",
            "user": {
                "id": 1,
                "username": "alice",
                "avatar": "",
                "status": "online",
                "role_id": 1,
                "created_at": "2026-01-01T00:00:00Z"
            }
        }
        """;

        var result = JsonSerializer.Deserialize<AuthResponse>(json, JsonOpts)!;
        Assert.Equal("abc123", result.Token);
        Assert.Equal("alice", result.User.Username);
        Assert.Equal(1, result.User.RoleId);
    }

    [Fact]
    public void Deserialize_MessagesResponse()
    {
        var json = """
        {
            "messages": [
                {
                    "id": 10,
                    "channel_id": 1,
                    "user_id": 1,
                    "content": "hello",
                    "reply_to": null,
                    "edited_at": null,
                    "deleted": false,
                    "pinned": false,
                    "timestamp": "2026-01-01T00:00:00Z",
                    "username": "alice",
                    "avatar": null
                }
            ],
            "has_more": true
        }
        """;

        var result = JsonSerializer.Deserialize<MessagesResponse>(json, JsonOpts)!;
        Assert.Single(result.Messages);
        Assert.Equal("hello", result.Messages[0].Content);
        Assert.Equal("alice", result.Messages[0].Username);
        Assert.True(result.HasMore);
    }

    [Fact]
    public void Deserialize_ChannelArray()
    {
        var json = """
        [
            { "id": 1, "name": "general", "type": "text", "category": "Chat", "topic": "Welcome", "position": 0, "slow_mode": 0, "archived": false, "created_at": "2026-01-01T00:00:00Z" },
            { "id": 2, "name": "voice-lobby", "type": "voice", "category": "Voice", "topic": "", "position": 1, "slow_mode": 0, "archived": false, "created_at": "2026-01-01T00:00:00Z" }
        ]
        """;

        var channels = JsonSerializer.Deserialize<List<ApiChannel>>(json, JsonOpts)!;
        Assert.Equal(2, channels.Count);
        Assert.Equal("general", channels[0].Name);
        Assert.Equal("text", channels[0].Type);
        Assert.Equal("voice", channels[1].Type);
    }

    [Fact]
    public void Deserialize_HealthResponse()
    {
        var json = """{ "status": "ok", "version": "1.0.0" }""";

        var result = JsonSerializer.Deserialize<HealthResponse>(json, JsonOpts)!;
        Assert.Equal("ok", result.Status);
        Assert.Equal("1.0.0", result.Version);
    }

    [Fact]
    public void Deserialize_ApiError()
    {
        var json = """{ "error": "UNAUTHORIZED", "message": "invalid credentials" }""";

        var result = JsonSerializer.Deserialize<ApiError>(json, JsonOpts)!;
        Assert.Equal("UNAUTHORIZED", result.Error);
        Assert.Equal("invalid credentials", result.Message);
    }
}

using System.Text.Json;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.Tests.Services;

/// <summary>Tests for ChatService voice commands and additional dispatch events.</summary>
public class ChatServiceVoiceTests
{
    private static readonly ApiUser TestUser = new(1, "alice", null, "online", 1, "2026-01-01T00:00:00Z");
    private static readonly AuthResponse TestAuthResponse = new("tok_abc", TestUser);

    private readonly FakeApiClient _api = new();
    private readonly FakeWebSocketService _ws = new();

    private ChatService CreateService() => new(_api, _ws);

    private async Task<ChatService> CreateConnectedService()
    {
        var svc = CreateService();
        await svc.ConnectWebSocketAsync("host:8443", "tok");
        return svc;
    }

    // ── Voice outbound commands ──────────────────────────────────────────

    [Fact]
    public async Task JoinVoiceAsync_SendsCorrectEnvelope()
    {
        var svc = await CreateConnectedService();

        await svc.JoinVoiceAsync(42);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("voice_join", sent.RootElement.GetProperty("type").GetString());
        Assert.Equal(42, sent.RootElement.GetProperty("payload").GetProperty("channel_id").GetInt64());
    }

    [Fact]
    public async Task LeaveVoiceAsync_SendsCorrectEnvelope()
    {
        var svc = await CreateConnectedService();

        await svc.LeaveVoiceAsync();

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("voice_leave", sent.RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public async Task SendVoiceMuteAsync_SendsCorrectEnvelope()
    {
        var svc = await CreateConnectedService();

        await svc.SendVoiceMuteAsync(true);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("voice_mute", sent.RootElement.GetProperty("type").GetString());
        Assert.True(sent.RootElement.GetProperty("payload").GetProperty("muted").GetBoolean());
    }

    [Fact]
    public async Task SendVoiceDeafenAsync_SendsCorrectEnvelope()
    {
        var svc = await CreateConnectedService();

        await svc.SendVoiceDeafenAsync(true);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("voice_deafen", sent.RootElement.GetProperty("type").GetString());
        Assert.True(sent.RootElement.GetProperty("payload").GetProperty("deafened").GetBoolean());
    }

    [Fact]
    public async Task SendChannelFocusAsync_SendsCorrectEnvelope()
    {
        var svc = await CreateConnectedService();

        await svc.SendChannelFocusAsync(7);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("channel_focus", sent.RootElement.GetProperty("type").GetString());
        Assert.Equal(7, sent.RootElement.GetProperty("payload").GetProperty("channel_id").GetInt64());
    }

    // ── Voice inbound events ─────────────────────────────────────────────

    [Fact]
    public async Task Dispatches_VoiceState_Event()
    {
        var svc = await CreateConnectedService();
        VoiceStatePayload? received = null;
        svc.VoiceStateReceived += p => received = p;

        _ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 1, "channel_id": 5, "username": "alice", "muted": true, "deafened": false } }""");

        Assert.NotNull(received);
        Assert.Equal(1, received!.UserId);
        Assert.Equal(5, received.ChannelId);
        Assert.True(received.Muted);
        Assert.False(received.Deafened);
    }

    [Fact]
    public async Task Dispatches_VoiceLeave_Event()
    {
        var svc = await CreateConnectedService();
        VoiceLeavePayload? received = null;
        svc.VoiceLeaveReceived += p => received = p;

        _ws.SimulateMessage("""{ "type": "voice_leave", "payload": { "user_id": 2, "channel_id": 5 } }""");

        Assert.NotNull(received);
        Assert.Equal(2, received!.UserId);
        Assert.Equal(5, received.ChannelId);
    }

    [Fact]
    public async Task Dispatches_VoiceConfig_Event()
    {
        var svc = await CreateConnectedService();
        VoiceConfigPayload? received = null;
        svc.VoiceConfigReceived += p => received = p;

        _ws.SimulateMessage("""{ "type": "voice_config", "payload": { "channel_id": 5, "quality": "high", "bitrate": 128000, "mode": "sfu" } }""");

        Assert.NotNull(received);
        Assert.Equal("high", received!.Quality);
        Assert.Equal(128000, received.Bitrate);
    }

    [Fact]
    public async Task Dispatches_VoiceSpeakers_Event()
    {
        var svc = await CreateConnectedService();
        VoiceSpeakersPayload? received = null;
        svc.VoiceSpeakersReceived += p => received = p;

        _ws.SimulateMessage("""{ "type": "voice_speakers", "payload": { "channel_id": 5, "speakers": [1, 3], "mode": "sfu" } }""");

        Assert.NotNull(received);
        Assert.Equal(5, received!.ChannelId);
        Assert.Equal(new long[] { 1, 3 }, received.Speakers);
    }

    // ── Additional dispatch events ───────────────────────────────────────

    [Fact]
    public async Task Dispatches_ChatSendOk_Event()
    {
        var svc = await CreateConnectedService();
        ChatSendOkPayload? received = null;
        svc.ChatSendOk += p => received = p;

        _ws.SimulateMessage("""{ "type": "chat_send_ok", "payload": { "message_id": 99, "timestamp": "2026-01-01T00:00:00Z" } }""");

        Assert.NotNull(received);
        Assert.Equal(99, received!.MessageId);
    }

    [Fact]
    public async Task Dispatches_ReactionUpdate_Event()
    {
        var svc = await CreateConnectedService();
        ReactionUpdatePayload? received = null;
        svc.ReactionUpdated += p => received = p;

        _ws.SimulateMessage("""{ "type": "reaction_update", "payload": { "message_id": 10, "channel_id": 1, "emoji": "👍", "user_id": 2, "action": "add" } }""");

        Assert.NotNull(received);
        Assert.Equal("add", received!.Action);
        Assert.Equal(10, received.MessageId);
    }

    [Fact]
    public async Task Dispatches_ServerRestart_Event()
    {
        var svc = await CreateConnectedService();
        ServerRestartPayload? received = null;
        svc.ServerRestarting += p => received = p;

        _ws.SimulateMessage("""{ "type": "server_restart", "payload": { "reason": "update", "delay_seconds": 30 } }""");

        Assert.NotNull(received);
        Assert.Equal("update", received!.Reason);
        Assert.Equal(30, received.DelaySeconds);
    }

    [Fact]
    public async Task Dispatches_MemberJoin_Event()
    {
        var svc = await CreateConnectedService();
        WsMember? received = null;
        svc.MemberJoined += p => received = p;

        _ws.SimulateMessage("""{ "type": "member_join", "payload": { "id": 10, "username": "newuser", "avatar": null, "status": "online", "role_id": 1 } }""");

        Assert.NotNull(received);
        Assert.Equal("newuser", received!.Username);
    }

    [Fact]
    public async Task Dispatches_ChannelCreate_Event()
    {
        var svc = await CreateConnectedService();
        ChannelEventPayload? received = null;
        svc.ChannelCreated += p => received = p;

        _ws.SimulateMessage("""{ "type": "channel_create", "payload": { "id": 5, "name": "new-channel", "type": "text", "category": "Chat", "topic": "Hello", "position": 3 } }""");

        Assert.NotNull(received);
        Assert.Equal("new-channel", received!.Name);
    }

    [Fact]
    public async Task Dispatches_ChannelUpdate_Event()
    {
        var svc = await CreateConnectedService();
        ChannelEventPayload? received = null;
        svc.ChannelUpdated += p => received = p;

        _ws.SimulateMessage("""{ "type": "channel_update", "payload": { "id": 5, "name": "renamed-channel", "type": "text", "category": "Chat", "topic": null, "position": 3 } }""");

        Assert.NotNull(received);
        Assert.Equal("renamed-channel", received!.Name);
    }

    [Fact]
    public async Task Dispatches_ChannelDelete_Event()
    {
        var svc = await CreateConnectedService();
        long? received = null;
        svc.ChannelDeleted += id => received = id;

        _ws.SimulateMessage("""{ "type": "channel_delete", "payload": { "id": 5 } }""");

        Assert.NotNull(received);
        Assert.Equal(5, received);
    }

    // ── TOTP ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task VerifyTotpAsync_CallsApiAndStoresState()
    {
        _api.VerifyTotpResult = TestAuthResponse;
        var svc = CreateService();

        var result = await svc.VerifyTotpAsync("localhost:8443", "partial_tok", "123456");

        Assert.Equal("tok_abc", result.Token);
        Assert.Equal("alice", result.User!.Username);
        Assert.Equal("tok_abc", svc.CurrentToken);
    }

    // ── Register ─────────────────────────────────────────────────────────

    [Fact]
    public async Task RegisterAsync_CallsApiAndStoresState()
    {
        _api.RegisterResult = TestAuthResponse;
        var svc = CreateService();

        var result = await svc.RegisterAsync("localhost:8443", "alice", "pass", "invite123");

        Assert.Equal("tok_abc", result.Token);
        Assert.Equal("alice", svc.CurrentUser?.Username);
    }

    // ── Edge cases ───────────────────────────────────────────────────────

    [Fact]
    public async Task MalformedJson_DoesNotThrow()
    {
        var svc = await CreateConnectedService();

        var exception = Record.Exception(() => _ws.SimulateMessage("not json at all"));

        Assert.Null(exception);
    }

    [Fact]
    public async Task KnownType_NullPayload_DoesNotThrow()
    {
        var svc = await CreateConnectedService();

        // A known type like "chat_message" with null payload should not crash
        var exception = Record.Exception(() =>
            _ws.SimulateMessage("""{ "type": "chat_message", "payload": null }"""));

        Assert.Null(exception);
    }

    [Fact]
    public async Task KnownType_MissingPayload_DoesNotThrow()
    {
        var svc = await CreateConnectedService();

        // A known type with no payload key at all
        var exception = Record.Exception(() =>
            _ws.SimulateMessage("""{ "type": "chat_message" }"""));

        Assert.Null(exception);
    }

    [Fact]
    public async Task DisconnectWebSocketAsync_SetsIntentionalFlag()
    {
        var svc = await CreateConnectedService();

        await svc.DisconnectWebSocketAsync();

        Assert.True(_ws.DisconnectCalled);
    }

    [Fact]
    public async Task VoiceMute_False_SendsCorrectPayload()
    {
        var svc = await CreateConnectedService();

        await svc.SendVoiceMuteAsync(false);

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.False(sent.RootElement.GetProperty("payload").GetProperty("muted").GetBoolean());
    }

    // ── Edit / Delete message outbound commands ──────────────────────────

    [Fact]
    public async Task EditMessageAsync_SendsCorrectType()
    {
        var svc = await CreateConnectedService();

        await svc.EditMessageAsync(77, "updated content");

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("chat_edit", sent.RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public async Task EditMessageAsync_SendsCorrectMessageId()
    {
        var svc = await CreateConnectedService();

        await svc.EditMessageAsync(77, "updated content");

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal(77, sent.RootElement.GetProperty("payload").GetProperty("message_id").GetInt64());
    }

    [Fact]
    public async Task EditMessageAsync_SendsCorrectContent()
    {
        var svc = await CreateConnectedService();

        await svc.EditMessageAsync(77, "updated content");

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("updated content", sent.RootElement.GetProperty("payload").GetProperty("content").GetString());
    }

    [Fact]
    public async Task EditMessageAsync_IncludesNonEmptyId()
    {
        var svc = await CreateConnectedService();

        await svc.EditMessageAsync(77, "updated content");

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        var id = sent.RootElement.GetProperty("id").GetString();
        Assert.NotNull(id);
        Assert.NotEmpty(id);
    }

    [Fact]
    public async Task DeleteMessageAsync_SendsCorrectType()
    {
        var svc = await CreateConnectedService();

        await svc.DeleteMessageAsync(55);

        Assert.Single(_ws.SentMessages);
        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal("chat_delete", sent.RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public async Task DeleteMessageAsync_SendsCorrectMessageId()
    {
        var svc = await CreateConnectedService();

        await svc.DeleteMessageAsync(55);

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        Assert.Equal(55, sent.RootElement.GetProperty("payload").GetProperty("message_id").GetInt64());
    }

    [Fact]
    public async Task DeleteMessageAsync_IncludesNonEmptyId()
    {
        var svc = await CreateConnectedService();

        await svc.DeleteMessageAsync(55);

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        var id = sent.RootElement.GetProperty("id").GetString();
        Assert.NotNull(id);
        Assert.NotEmpty(id);
    }

    [Fact]
    public async Task EditMessageAsync_EachCallProducesUniqueId()
    {
        var svc = await CreateConnectedService();

        await svc.EditMessageAsync(1, "first");
        await svc.EditMessageAsync(2, "second");

        var id1 = JsonDocument.Parse(_ws.SentMessages[0]).RootElement.GetProperty("id").GetString();
        var id2 = JsonDocument.Parse(_ws.SentMessages[1]).RootElement.GetProperty("id").GetString();
        Assert.NotEqual(id1, id2);
    }

    [Fact]
    public async Task DeleteMessageAsync_DoesNotIncludeContentField()
    {
        var svc = await CreateConnectedService();

        await svc.DeleteMessageAsync(55);

        var sent = JsonDocument.Parse(_ws.SentMessages[0]);
        var payload = sent.RootElement.GetProperty("payload");
        Assert.False(payload.TryGetProperty("content", out _));
    }
}

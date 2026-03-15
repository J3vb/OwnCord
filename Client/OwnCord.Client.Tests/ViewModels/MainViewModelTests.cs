using OwnCord.Client.Models;
using OwnCord.Client.Services;
using OwnCord.Client.Tests.Services;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Tests.ViewModels;

public sealed class MainViewModelTests
{
    private static MainViewModel MakeVm() => new();

    private static MainViewModel MakeVmWithChat(out FakeApiClient api, out FakeWebSocketService ws)
    {
        api = new FakeApiClient();
        ws = new FakeWebSocketService();
        var chat = new ChatService(api, ws);
        var vm = new MainViewModel();
        vm.Initialize(chat);
        return vm;
    }

    private static Channel MakeChannel(long id, string name, int unread = 0)
        => new(id, name, ChannelType.Text, null, 0, unread, null);

    private static User MakeUser(long id, string name)
        => new(id, name, null, 4, UserStatus.Online);

    private static Message MakeMessage(long id, long channelId, string content)
        => new(id, channelId, MakeUser(1, "alice"), content, DateTime.UtcNow, null, null, false, [], []);

    [Fact]
    public void SendCommand_DisabledWhenInputEmpty()
    {
        var vm = MakeVm();
        vm.SelectedChannel = MakeChannel(1, "general");
        vm.MessageInput = "";
        Assert.False(vm.SendMessageCommand.CanExecute(null));
    }

    [Fact]
    public void SendCommand_DisabledWhenNoChannelSelected()
    {
        var vm = MakeVm();
        vm.MessageInput = "hello";
        Assert.False(vm.SendMessageCommand.CanExecute(null));
    }

    [Fact]
    public void SendCommand_EnabledWhenInputAndChannelSet()
    {
        var vm = MakeVm();
        vm.SelectedChannel = MakeChannel(1, "general");
        vm.MessageInput = "hello";
        Assert.True(vm.SendMessageCommand.CanExecute(null));
    }

    [Fact]
    public void SendCommand_SendsViaChatServiceAndClearsInput()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.SelectedChannel = MakeChannel(1, "general");
        vm.MessageInput = "hello";
        ws.IsConnected = true;
        ws.State = System.Net.WebSockets.WebSocketState.Open;
        vm.SendMessageCommand.Execute(null);
        Assert.Equal(string.Empty, vm.MessageInput);
        Assert.Contains(ws.SentMessages, m => m.Contains("chat_send"));
    }

    [Fact]
    public void SelectChannel_ClearsMessages()
    {
        var vm = MakeVm();
        vm.AddMessage(MakeMessage(1, 1, "hi"));
        vm.SelectedChannel = MakeChannel(2, "random");
        Assert.Empty(vm.Messages);
    }

    [Fact]
    public void LoadChannels_PopulatesCollection()
    {
        var vm = MakeVm();
        vm.LoadChannels([MakeChannel(1, "general"), MakeChannel(2, "random")]);
        Assert.Equal(2, vm.Channels.Count);
    }

    [Fact]
    public void LoadMembers_PopulatesCollection()
    {
        var vm = MakeVm();
        vm.LoadMembers([MakeUser(1, "alice"), MakeUser(2, "bob")]);
        Assert.Equal(2, vm.Members.Count);
    }

    [Fact]
    public void AddMessage_AppendsToCollection()
    {
        var vm = MakeVm();
        vm.AddMessage(MakeMessage(1, 1, "hello"));
        Assert.Single(vm.Messages);
    }

    [Fact]
    public void ShowTyping_SetsIsTypingAndText()
    {
        var vm = MakeVm();
        vm.ShowTyping("alice");
        Assert.True(vm.IsTyping);
        Assert.Contains("alice", vm.TypingText);
    }

    [Fact]
    public void HideTyping_ClearsIsTyping()
    {
        var vm = MakeVm();
        vm.ShowTyping("alice");
        vm.HideTyping();
        Assert.False(vm.IsTyping);
        Assert.Null(vm.TypingText);
    }

    [Fact]
    public void UpdateUnreadCount_UpdatesChannel()
    {
        var vm = MakeVm();
        vm.LoadChannels([MakeChannel(1, "general", 0)]);
        vm.UpdateUnreadCount(1, 5);
        Assert.Equal(5, vm.Channels[0].UnreadCount);
    }

    [Fact]
    public void Initialize_ReadyEvent_PopulatesChannels()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        var json = """
        { "type": "ready", "payload": { "channels": [
            { "id": 1, "name": "general", "type": "text", "category": "Chat", "topic": "", "position": 0, "slow_mode": 0, "archived": false, "created_at": "2026-01-01T00:00:00Z" }
        ], "members": [], "voice_states": [], "roles": [] } }
        """;
        ws.SimulateMessage(json);

        Assert.Single(vm.Channels);
        Assert.Equal("general", vm.Channels[0].Name);
        Assert.Equal(ChannelType.Text, vm.Channels[0].Type);
        Assert.Equal(vm.Channels[0], vm.SelectedChannel);
    }

    [Fact]
    public void Initialize_ChatMessage_AddsToMessages()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);
        vm.SelectedChannel = vm.Channels[0];

        var json = """
        { "type": "chat_message", "payload": { "id": 42, "channel_id": 1, "user": { "id": 1, "username": "alice", "avatar": null }, "content": "Hello!", "reply_to": null, "timestamp": "2026-01-01T00:00:00Z" } }
        """;
        ws.SimulateMessage(json);

        Assert.Single(vm.Messages);
        Assert.Equal("Hello!", vm.Messages[0].Content);
        Assert.Equal("alice", vm.Messages[0].Author.Username);
    }

    [Fact]
    public void Initialize_Typing_ShowsTypingIndicator()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);
        vm.SelectedChannel = vm.Channels[0];

        ws.SimulateMessage("""{ "type": "typing", "payload": { "channel_id": 1, "user_id": 2, "username": "bob" } }""");

        Assert.True(vm.IsTyping);
        Assert.Contains("bob", vm.TypingText);
    }

    [Fact]
    public void Initialize_ChatEdited_UpdatesMessage()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);
        vm.SelectedChannel = vm.Channels[0];
        vm.AddMessage(MakeMessage(10, 1, "original"));

        ws.SimulateMessage("""{ "type": "chat_edited", "payload": { "message_id": 10, "channel_id": 1, "content": "edited", "edited_at": "2026-01-01T00:00:00Z" } }""");

        Assert.Equal("edited", vm.Messages[0].Content);
        Assert.NotNull(vm.Messages[0].EditedAt);
    }

    [Fact]
    public void Initialize_ChatDeleted_MarksMessageDeleted()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);
        vm.SelectedChannel = vm.Channels[0];
        vm.AddMessage(MakeMessage(10, 1, "to delete"));

        ws.SimulateMessage("""{ "type": "chat_deleted", "payload": { "message_id": 10, "channel_id": 1 } }""");

        Assert.True(vm.Messages[0].Deleted);
        Assert.Equal("[deleted]", vm.Messages[0].Content);
    }

    [Fact]
    public void Initialize_ConnectionLost_SetsStatus()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateDisconnect();

        Assert.Contains("Disconnected", vm.ConnectionStatus);
    }
}

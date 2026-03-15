using OwnCord.Client.Models;
using OwnCord.Client.Services;
using OwnCord.Client.Tests.Services;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Tests.ViewModels;

/// <summary>Tests for MainViewModel voice events, channel CRUD, member events, and grouping.</summary>
public sealed class MainViewModelVoiceTests
{
    private static readonly ApiUser TestUser = new(1, "alice", null, "online", 1, "2026-01-01T00:00:00Z");
    private static readonly AuthResponse TestAuth = new("tok_abc", TestUser);

    private static MainViewModel MakeVmWithChat(out FakeApiClient api, out FakeWebSocketService ws)
    {
        api = new FakeApiClient();
        ws = new FakeWebSocketService();
        var chat = new ChatService(api, ws);
        var vm = new MainViewModel();
        vm.Initialize(chat);
        return vm;
    }

    private static async Task<(MainViewModel vm, FakeApiClient api, FakeWebSocketService ws)> MakeLoggedInVm()
    {
        var api = new FakeApiClient { LoginResult = TestAuth };
        var ws = new FakeWebSocketService();
        var chat = new ChatService(api, ws);
        var vm = new MainViewModel();
        vm.Initialize(chat);
        await chat.LoginAsync("host:8443", "alice", "pass");
        await chat.ConnectWebSocketAsync("host:8443", "tok_abc");
        return (vm, api, ws);
    }

    private static Channel MakeChannel(long id, string name, ChannelType type = ChannelType.Text, string? category = null, int position = 0)
        => new(id, name, type, category, position, 0, null);

    private static User MakeUser(long id, string name, long roleId = 1)
        => new(id, name, null, roleId, UserStatus.Online);

    private static Message MakeMessage(long id, long channelId, string content, long authorId = 1, string authorName = "alice")
        => new(id, channelId, MakeUser(authorId, authorName), content, DateTime.UtcNow, null, null, false, [], []);

    private static string ReadyJson(string channels = "[]", string members = "[]", string voiceStates = "[]", string roles = "[]")
        => $@"{{ ""type"": ""ready"", ""payload"": {{ ""channels"": {channels}, ""members"": {members}, ""voice_states"": {voiceStates}, ""roles"": {roles} }} }}";

    // ── Voice state event ────────────────────────────────────────────────

    [Fact]
    public void VoiceState_AddsNewVoiceUser()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(5, "voice-room", ChannelType.Voice)]);

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 5, "username": "bob", "muted": false, "deafened": false } }""");

        Assert.Single(vm.VoiceStates);
        Assert.Equal("bob", vm.VoiceStates[0].Username);
        Assert.Equal(5, vm.VoiceStates[0].ChannelId);
    }

    [Fact]
    public void VoiceState_UpdatesExistingUser()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(5, "voice-room", ChannelType.Voice)]);

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 5, "username": "bob", "muted": false, "deafened": false } }""");
        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 5, "username": "bob", "muted": true, "deafened": false } }""");

        Assert.Single(vm.VoiceStates);
        Assert.True(vm.VoiceStates[0].Muted);
    }

    [Fact]
    public async Task VoiceState_LocalUser_SetsVoiceWidgetState()
    {
        var (vm, _, ws) = await MakeLoggedInVm();

        // Fire ready to populate channels and set CurrentUser on ChatService
        ws.SimulateMessage(ReadyJson(
            channels: @"[{ ""id"": 5, ""name"": ""voice-room"", ""type"": ""voice"", ""category"": ""Voice"", ""topic"": """", ""position"": 0, ""slow_mode"": 0, ""archived"": false, ""created_at"": ""2026-01-01T00:00:00Z"" }]",
            members: @"[{ ""id"": 1, ""username"": ""alice"", ""avatar"": null, ""status"": ""online"", ""role_id"": 1 }]"
        ));

        // Simulate local user (id=1) joining voice
        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 1, "channel_id": 5, "username": "alice", "muted": false, "deafened": false } }""");

        Assert.True(vm.IsInVoice);
        Assert.Equal("voice-room", vm.VoiceChannelName);
        Assert.False(vm.IsMuted);
    }

    // ── Voice leave event ────────────────────────────────────────────────

    [Fact]
    public void VoiceLeave_RemovesVoiceUser()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 5, "username": "bob", "muted": false, "deafened": false } }""");
        Assert.Single(vm.VoiceStates);

        ws.SimulateMessage("""{ "type": "voice_leave", "payload": { "user_id": 2, "channel_id": 5 } }""");
        Assert.Empty(vm.VoiceStates);
    }

    [Fact]
    public async Task VoiceLeave_LocalUser_ClearsVoiceWidget()
    {
        var (vm, _, ws) = await MakeLoggedInVm();

        ws.SimulateMessage(ReadyJson(
            channels: @"[{ ""id"": 5, ""name"": ""voice-room"", ""type"": ""voice"", ""category"": null, ""topic"": """", ""position"": 0, ""slow_mode"": 0, ""archived"": false, ""created_at"": ""2026-01-01T00:00:00Z"" }]",
            members: @"[{ ""id"": 1, ""username"": ""alice"", ""avatar"": null, ""status"": ""online"", ""role_id"": 1 }]"
        ));

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 1, "channel_id": 5, "username": "alice", "muted": false, "deafened": false } }""");
        Assert.True(vm.IsInVoice);

        ws.SimulateMessage("""{ "type": "voice_leave", "payload": { "user_id": 1, "channel_id": 5 } }""");
        Assert.False(vm.IsInVoice);
        Assert.Null(vm.VoiceChannelName);
        Assert.False(vm.IsMuted);
        Assert.False(vm.IsDeafened);
    }

    // ── Voice speakers event ─────────────────────────────────────────────

    [Fact]
    public void VoiceSpeakers_UpdatesSpeakingState()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 5, "username": "bob", "muted": false, "deafened": false } }""");
        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 3, "channel_id": 5, "username": "carol", "muted": false, "deafened": false } }""");

        ws.SimulateMessage("""{ "type": "voice_speakers", "payload": { "channel_id": 5, "speakers": [2], "mode": "sfu" } }""");

        var bob = vm.VoiceStates.First(vs => vs.UserId == 2);
        var carol = vm.VoiceStates.First(vs => vs.UserId == 3);
        Assert.True(bob.Speaking);
        Assert.False(carol.Speaking);
    }

    // ── Channel CRUD events ──────────────────────────────────────────────

    [Fact]
    public void ChannelCreated_AddsNewChannel()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);

        ws.SimulateMessage("""{ "type": "channel_create", "payload": { "id": 2, "name": "random", "type": "text", "category": "Chat", "topic": null, "position": 1 } }""");

        Assert.Equal(2, vm.Channels.Count);
        Assert.Contains(vm.Channels, c => c.Name == "random");
    }

    [Fact]
    public void ChannelCreated_DuplicateId_DoesNotAdd()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);

        ws.SimulateMessage("""{ "type": "channel_create", "payload": { "id": 1, "name": "general-dup", "type": "text", "category": null, "topic": null, "position": 0 } }""");

        Assert.Single(vm.Channels);
    }

    [Fact]
    public void ChannelUpdated_UpdatesExistingChannel()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);

        ws.SimulateMessage("""{ "type": "channel_update", "payload": { "id": 1, "name": "general-renamed", "type": "text", "category": "Chat", "topic": "New topic", "position": 0 } }""");

        Assert.Equal("general-renamed", vm.Channels[0].Name);
        Assert.Equal("New topic", vm.Channels[0].Topic);
    }

    [Fact]
    public void ChannelUpdated_SelectedChannel_NotifiesTopicChanged()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general")]);
        vm.SelectedChannel = vm.Channels[0];

        bool topicNotified = false;
        vm.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(vm.SelectedChannelTopic))
                topicNotified = true;
        };

        ws.SimulateMessage("""{ "type": "channel_update", "payload": { "id": 1, "name": "general", "type": "text", "category": null, "topic": "Updated!", "position": 0 } }""");

        Assert.True(topicNotified);
        // The channel in Channels collection has the updated topic
        Assert.Equal("Updated!", vm.Channels[0].Topic);
    }

    [Fact]
    public void ChannelDeleted_RemovesChannel()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general"), MakeChannel(2, "random")]);

        ws.SimulateMessage("""{ "type": "channel_delete", "payload": { "id": 2 } }""");

        Assert.Single(vm.Channels);
        Assert.Equal("general", vm.Channels[0].Name);
    }

    [Fact]
    public void ChannelDeleted_SelectedChannel_SelectsAnother()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general"), MakeChannel(2, "random")]);
        vm.SelectedChannel = vm.Channels.First(c => c.Id == 2);

        ws.SimulateMessage("""{ "type": "channel_delete", "payload": { "id": 2 } }""");

        Assert.NotNull(vm.SelectedChannel);
        Assert.Equal(1, vm.SelectedChannel!.Id);
    }

    // ── Member events ────────────────────────────────────────────────────

    [Fact]
    public void MemberJoined_AddsNewMember()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadMembers([MakeUser(1, "alice")]);

        ws.SimulateMessage("""{ "type": "member_join", "payload": { "id": 10, "username": "newuser", "avatar": null, "status": "online", "role_id": 1 } }""");

        Assert.Equal(2, vm.Members.Count);
        Assert.Contains(vm.Members, m => m.Username == "newuser");
    }

    [Fact]
    public void MemberJoined_DuplicateId_DoesNotAdd()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadMembers([MakeUser(1, "alice")]);

        ws.SimulateMessage("""{ "type": "member_join", "payload": { "id": 1, "username": "alice-dup", "avatar": null, "status": "online", "role_id": 1 } }""");

        Assert.Single(vm.Members);
    }

    [Fact]
    public void Presence_UpdatesMemberStatus()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadMembers([MakeUser(1, "alice")]);

        ws.SimulateMessage("""{ "type": "presence", "payload": { "user_id": 1, "status": "idle" } }""");

        Assert.Equal(UserStatus.Idle, vm.Members[0].Status);
    }

    // ── Channel grouping ─────────────────────────────────────────────────

    [Fact]
    public void ChannelGroups_GroupedByCategory()
    {
        var vm = new MainViewModel();
        vm.LoadChannels([
            MakeChannel(1, "general", ChannelType.Text, "Chat", 0),
            MakeChannel(2, "random", ChannelType.Text, "Chat", 1),
            MakeChannel(3, "voice", ChannelType.Voice, "Voice", 0),
        ]);

        Assert.Equal(2, vm.ChannelGroups.Count);
        Assert.Contains(vm.ChannelGroups, g => g.CategoryName == "Chat" && g.Items.Count == 2);
        Assert.Contains(vm.ChannelGroups, g => g.CategoryName == "Voice" && g.Items.Count == 1);
    }

    [Fact]
    public void ChannelGroups_PreservesExpandedState()
    {
        var vm = new MainViewModel();
        vm.LoadChannels([
            MakeChannel(1, "general", ChannelType.Text, "Chat", 0),
            MakeChannel(2, "voice", ChannelType.Voice, "Voice", 0),
        ]);

        // Collapse the Chat group
        var chatGroup = vm.ChannelGroups.First(g => g.CategoryName == "Chat");
        chatGroup.IsExpanded = false;

        // Reload channels — should preserve collapsed state
        vm.LoadChannels([
            MakeChannel(1, "general", ChannelType.Text, "Chat", 0),
            MakeChannel(2, "voice", ChannelType.Voice, "Voice", 0),
            MakeChannel(3, "random", ChannelType.Text, "Chat", 1),
        ]);

        var chatGroupAfter = vm.ChannelGroups.First(g => g.CategoryName == "Chat");
        Assert.False(chatGroupAfter.IsExpanded);
    }

    [Fact]
    public void ChannelGroups_VoiceChannelsIncludeVoiceUsers()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(5, "voice-room", ChannelType.Voice, "Voice")]);

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 5, "username": "bob", "muted": false, "deafened": false } }""");

        var voiceGroup = vm.ChannelGroups.First(g => g.CategoryName == "Voice");
        var voiceItem = voiceGroup.Items[0];
        Assert.Single(voiceItem.VoiceUsers);
        Assert.Equal("bob", voiceItem.VoiceUsers[0].Username);
    }

    [Fact]
    public void ChannelGroups_NullCategory_SortedFirst()
    {
        var vm = new MainViewModel();
        vm.LoadChannels([
            MakeChannel(1, "general", ChannelType.Text, null, 0),
            MakeChannel(2, "chat", ChannelType.Text, "Chat", 0),
        ]);

        Assert.Null(vm.ChannelGroups[0].CategoryName);
        Assert.Equal("Chat", vm.ChannelGroups[1].CategoryName);
    }

    // ── Member grouping ──────────────────────────────────────────────────

    [Fact]
    public void MemberGroups_GroupedByRole()
    {
        var vm = new MainViewModel();
        vm.Roles.Add(new WsRole(1, "Admin", "#ff0000", 0, 0, false));
        vm.Roles.Add(new WsRole(2, "Member", null, 0, 1, true));
        vm.LoadMembers([
            MakeUser(1, "alice", 1),
            MakeUser(2, "bob", 2),
            MakeUser(3, "carol", 2),
        ]);

        Assert.Equal(2, vm.MemberGroups.Count);
        var adminGroup = vm.MemberGroups.First(g => g.RoleName == "Admin");
        Assert.Single(adminGroup.Members);
        var memberGroup = vm.MemberGroups.First(g => g.RoleName == "Member");
        Assert.Equal(2, memberGroup.Members.Count);
    }

    [Fact]
    public void MemberGroups_UnknownRole_DefaultsToMembers()
    {
        var vm = new MainViewModel();
        vm.LoadMembers([MakeUser(1, "alice", 99)]);

        Assert.Single(vm.MemberGroups);
        Assert.Equal("Members", vm.MemberGroups[0].RoleName);
    }

    // ── Connection status ────────────────────────────────────────────────

    [Fact]
    public void ConnectionStatus_SetsHasConnectionIssue()
    {
        var vm = new MainViewModel();
        Assert.False(vm.HasConnectionIssue);

        vm.ConnectionStatus = "Disconnected";
        Assert.True(vm.HasConnectionIssue);

        vm.ConnectionStatus = null;
        Assert.False(vm.HasConnectionIssue);
    }

    // ── Ready event with voice states ────────────────────────────────────

    [Fact]
    public void Ready_LoadsVoiceStates()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateMessage(ReadyJson(
            channels: @"[{ ""id"": 5, ""name"": ""voice"", ""type"": ""voice"", ""category"": null, ""topic"": """", ""position"": 0, ""slow_mode"": 0, ""archived"": false, ""created_at"": ""2026-01-01T00:00:00Z"" }]",
            voiceStates: @"[{ ""user_id"": 2, ""channel_id"": 5, ""username"": ""bob"", ""muted"": true, ""deafened"": false, ""speaking"": false }]"
        ));

        Assert.Single(vm.VoiceStates);
        Assert.Equal("bob", vm.VoiceStates[0].Username);
        Assert.True(vm.VoiceStates[0].Muted);
    }

    [Fact]
    public void Ready_LoadsRoles()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateMessage(ReadyJson(
            roles: @"[{ ""id"": 1, ""name"": ""Admin"", ""color"": ""#ff0000"", ""permissions"": 255, ""position"": 0, ""is_default"": false }, { ""id"": 2, ""name"": ""Member"", ""color"": null, ""permissions"": 1, ""position"": 1, ""is_default"": true }]"
        ));

        Assert.Equal(2, vm.Roles.Count);
        Assert.Equal("Admin", vm.Roles[0].Name);
    }

    [Fact]
    public void Ready_SelectsFirstTextChannel()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateMessage(ReadyJson(
            channels: @"[{ ""id"": 5, ""name"": ""voice"", ""type"": ""voice"", ""category"": null, ""topic"": """", ""position"": 0, ""slow_mode"": 0, ""archived"": false, ""created_at"": ""2026-01-01T00:00:00Z"" }, { ""id"": 1, ""name"": ""general"", ""type"": ""text"", ""category"": null, ""topic"": """", ""position"": 1, ""slow_mode"": 0, ""archived"": false, ""created_at"": ""2026-01-01T00:00:00Z"" }]"
        ));

        Assert.NotNull(vm.SelectedChannel);
        Assert.Equal("general", vm.SelectedChannel!.Name);
    }

    // ── Chat message to non-selected channel increments unread ──────────

    [Fact]
    public void ChatMessage_OtherChannel_IncrementsUnread()
    {
        var vm = MakeVmWithChat(out _, out var ws);
        vm.LoadChannels([MakeChannel(1, "general"), MakeChannel(2, "random")]);
        vm.SelectedChannel = vm.Channels[0]; // selected = general (id 1)

        ws.SimulateMessage("""{ "type": "chat_message", "payload": { "id": 50, "channel_id": 2, "user": { "id": 2, "username": "bob", "avatar": null }, "content": "hi", "reply_to": null, "timestamp": "2026-01-01T00:00:00Z" } }""");

        Assert.Equal(1, vm.Channels.First(c => c.Id == 2).UnreadCount);
    }

    // ── Display messages ─────────────────────────────────────────────────

    [Fact]
    public void AddMessage_CreatesDisplayMessage()
    {
        var vm = new MainViewModel();
        vm.AddMessage(MakeMessage(1, 1, "hello"));

        Assert.Single(vm.DisplayMessages);
        Assert.Equal("hello", vm.DisplayMessages[0].Content);
    }

    [Fact]
    public void AddMessage_SecondBySameAuthor_GroupedTogether()
    {
        var vm = new MainViewModel();
        vm.AddMessage(MakeMessage(1, 1, "hello", 1, "alice"));
        vm.AddMessage(MakeMessage(2, 1, "world", 1, "alice"));

        Assert.Equal(2, vm.DisplayMessages.Count);
        Assert.False(vm.DisplayMessages[0].IsGrouped);  // First message shows header
        Assert.True(vm.DisplayMessages[1].IsGrouped);   // Second is grouped (no header)
    }

    // ── Toggle commands ──────────────────────────────────────────────────

    [Fact]
    public void ToggleMemberList_TogglesVisibility()
    {
        var vm = new MainViewModel();
        Assert.True(vm.IsMemberListVisible);

        vm.ToggleMemberListCommand.Execute(null);
        Assert.False(vm.IsMemberListVisible);

        vm.ToggleMemberListCommand.Execute(null);
        Assert.True(vm.IsMemberListVisible);
    }

    [Fact]
    public void ToggleCategory_TogglesExpandedState()
    {
        var vm = new MainViewModel();
        vm.LoadChannels([MakeChannel(1, "general", ChannelType.Text, "Chat")]);

        var group = vm.ChannelGroups[0];
        Assert.True(group.IsExpanded);

        vm.ToggleCategoryCommand.Execute(group);
        Assert.False(group.IsExpanded);

        vm.ToggleCategoryCommand.Execute(group);
        Assert.True(group.IsExpanded);
    }

    // ── GetVoiceUsersForChannel ──────────────────────────────────────────

    [Fact]
    public void GetVoiceUsersForChannel_FiltersCorrectly()
    {
        var vm = MakeVmWithChat(out _, out var ws);

        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 1, "channel_id": 5, "username": "alice", "muted": false, "deafened": false } }""");
        ws.SimulateMessage("""{ "type": "voice_state", "payload": { "user_id": 2, "channel_id": 6, "username": "bob", "muted": false, "deafened": false } }""");

        var users5 = vm.GetVoiceUsersForChannel(5).ToList();
        var users6 = vm.GetVoiceUsersForChannel(6).ToList();
        var users7 = vm.GetVoiceUsersForChannel(7).ToList();

        Assert.Single(users5);
        Assert.Single(users6);
        Assert.Empty(users7);
    }

    // ── CurrentUser properties ───────────────────────────────────────────

    [Fact]
    public void CurrentUsername_DefaultsToUnknown()
    {
        var vm = new MainViewModel();
        Assert.Equal("Unknown", vm.CurrentUsername);
    }

    [Fact]
    public void CurrentUserStatusEnum_DefaultsToOffline()
    {
        var vm = new MainViewModel();
        Assert.Equal(UserStatus.Offline, vm.CurrentUserStatusEnum);
    }

    // ── SelectChannelCommand ─────────────────────────────────────────────

    [Fact]
    public void SelectChannelCommand_WithChannelItem_SelectsChannel()
    {
        var vm = new MainViewModel();
        var ch = MakeChannel(1, "general");
        vm.LoadChannels([ch]);

        var item = vm.ChannelGroups[0].Items[0];
        vm.SelectChannelCommand.Execute(item);

        Assert.Equal(ch.Id, vm.SelectedChannel?.Id);
    }

    [Fact]
    public void SelectChannelCommand_WithNull_DoesNothing()
    {
        var vm = new MainViewModel();
        vm.SelectChannelCommand.Execute(null);
        Assert.Null(vm.SelectedChannel);
    }
}

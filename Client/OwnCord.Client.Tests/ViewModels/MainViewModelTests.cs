using OwnCord.Client.Models;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Tests.ViewModels;

public sealed class MainViewModelTests
{
    private static MainViewModel MakeVm() => new();

    private static Channel MakeChannel(long id, string name, int unread = 0)
        => new(id, name, ChannelType.Text, null, 0, unread, null);

    private static User MakeUser(long id, string name)
        => new(id, name, null, 4, UserStatus.Online);

    private static Message MakeMessage(long id, long channelId, string content)
        => new(id, channelId, MakeUser(1, "alice"), content, DateTime.UtcNow, null, null, false, []);

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
    public void SendCommand_RaisesEventAndClearsInput()
    {
        var vm = MakeVm();
        vm.SelectedChannel = MakeChannel(1, "general");
        vm.MessageInput = "hello";
        (long channelId, string content) captured = default;
        vm.MessageSendRequested += (ch, msg) => captured = (ch, msg);
        vm.SendMessageCommand.Execute(null);
        Assert.Equal(1L, captured.channelId);
        Assert.Equal("hello", captured.content);
        Assert.Equal(string.Empty, vm.MessageInput);
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
}

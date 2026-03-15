using OwnCord.Client.Models;

namespace OwnCord.Client.Tests.Models;

// ── ServerProfile Tests ─────────────────────────────────────────────────────

public class ServerProfileTests
{
    [Fact]
    public void Create_GeneratesUniqueId()
    {
        var p = ServerProfile.Create("Home", "localhost");
        Assert.False(string.IsNullOrEmpty(p.Id));
    }

    [Fact]
    public void Create_TwoCallsProduceDifferentIds()
    {
        var a = ServerProfile.Create("A", "a.local");
        var b = ServerProfile.Create("B", "b.local");
        Assert.NotEqual(a.Id, b.Id);
    }

    [Fact]
    public void Create_StoresNameHostUsername()
    {
        var p = ServerProfile.Create("Home", "192.168.1.1", "alice");
        Assert.Equal("Home", p.Name);
        Assert.Equal("192.168.1.1", p.Host);
        Assert.Equal("alice", p.LastUsername);
    }

    [Fact]
    public void Create_DefaultsPortTo8443()
    {
        var p = ServerProfile.Create("Home", "localhost");
        Assert.Equal(8443, p.Port);
    }

    [Fact]
    public void Create_DefaultsColorToAccent()
    {
        var p = ServerProfile.Create("Home", "localhost");
        Assert.Equal("#5865f2", p.Color);
    }

    [Fact]
    public void Create_CustomPortAndColor()
    {
        var p = ServerProfile.Create("Home", "localhost", port: 9443, color: "#ff0000");
        Assert.Equal(9443, p.Port);
        Assert.Equal("#ff0000", p.Color);
    }

    [Fact]
    public void Create_AutoConnectDefaultsFalse()
    {
        var p = ServerProfile.Create("Home", "localhost");
        Assert.False(p.AutoConnect);
    }

    [Fact]
    public void Create_LastConnectedIsNull()
    {
        var p = ServerProfile.Create("Home", "localhost");
        Assert.Null(p.LastConnected);
    }

    [Fact]
    public void HostDisplay_OmitsDefaultPort()
    {
        var p = ServerProfile.Create("Home", "192.168.1.1", port: 8443);
        Assert.Equal("192.168.1.1", p.HostDisplay);
    }

    [Fact]
    public void HostDisplay_IncludesNonDefaultPort()
    {
        var p = ServerProfile.Create("Home", "192.168.1.1", port: 9443);
        Assert.Equal("192.168.1.1:9443", p.HostDisplay);
    }

    [Fact]
    public void WithExpression_CreatesNewInstance()
    {
        var original = ServerProfile.Create("Old", "old.local");
        var updated = original with { Name = "New" };
        Assert.Equal("New", updated.Name);
        Assert.Equal("Old", original.Name);
        Assert.Equal(original.Id, updated.Id);
    }
}

// ── MessageDisplayItem Tests ────────────────────────────────────────────────

public class MessageDisplayItemTests
{
    private static User Alice => new(1, "alice", null, 1, UserStatus.Online);
    private static User Bob => new(2, "bob", null, 1, UserStatus.Online);

    private static Message Msg(long id, User author, DateTime ts, long? replyTo = null)
        => new(id, 1, author, "hello", ts, replyTo, null, false, [], []);

    [Fact]
    public void FirstMessage_NotGrouped()
    {
        var item = new MessageDisplayItem(Msg(1, Alice, DateTime.Today.AddHours(10)), null);
        Assert.False(item.IsGrouped);
    }

    [Fact]
    public void FirstMessage_ShowsDayDivider()
    {
        var item = new MessageDisplayItem(Msg(1, Alice, DateTime.Today.AddHours(10)), null);
        Assert.True(item.ShowDayDivider);
    }

    [Fact]
    public void SameAuthor_Within7Min_IsGrouped()
    {
        var ts = DateTime.Today.AddHours(10);
        var prev = Msg(1, Alice, ts);
        var curr = Msg(2, Alice, ts.AddMinutes(3));
        var item = new MessageDisplayItem(curr, prev);
        Assert.True(item.IsGrouped);
    }

    [Fact]
    public void SameAuthor_Over7Min_NotGrouped()
    {
        var ts = DateTime.Today.AddHours(10);
        var prev = Msg(1, Alice, ts);
        var curr = Msg(2, Alice, ts.AddMinutes(8));
        var item = new MessageDisplayItem(curr, prev);
        Assert.False(item.IsGrouped);
    }

    [Fact]
    public void DifferentAuthor_NotGrouped()
    {
        var ts = DateTime.Today.AddHours(10);
        var prev = Msg(1, Alice, ts);
        var curr = Msg(2, Bob, ts.AddMinutes(1));
        var item = new MessageDisplayItem(curr, prev);
        Assert.False(item.IsGrouped);
    }

    [Fact]
    public void Reply_BreaksGrouping()
    {
        var ts = DateTime.Today.AddHours(10);
        var prev = Msg(1, Alice, ts);
        var curr = Msg(2, Alice, ts.AddMinutes(1), replyTo: 99);
        var item = new MessageDisplayItem(curr, prev);
        Assert.False(item.IsGrouped);
    }

    [Fact]
    public void DifferentDay_ShowsDayDivider()
    {
        var prev = Msg(1, Alice, DateTime.Today.AddDays(-1).AddHours(23));
        var curr = Msg(2, Alice, DateTime.Today.AddHours(0));
        var item = new MessageDisplayItem(curr, prev);
        Assert.True(item.ShowDayDivider);
        Assert.False(item.IsGrouped);
    }

    [Fact]
    public void Today_DayDividerText_SaysToday()
    {
        var item = new MessageDisplayItem(Msg(1, Alice, DateTime.Today.AddHours(10)), null);
        Assert.Equal("Today", item.DayDividerText);
    }

    [Fact]
    public void Yesterday_DayDividerText_SaysYesterday()
    {
        var item = new MessageDisplayItem(Msg(1, Alice, DateTime.Today.AddDays(-1).AddHours(10)), null);
        Assert.Equal("Yesterday", item.DayDividerText);
    }

    [Fact]
    public void OlderDate_DayDividerText_FormatsDate()
    {
        var date = new DateTime(2026, 1, 15, 10, 0, 0);
        var item = new MessageDisplayItem(Msg(1, Alice, date), null);
        Assert.Contains("January", item.DayDividerText);
        Assert.Contains("15", item.DayDividerText);
        Assert.Contains("2026", item.DayDividerText);
    }

    [Fact]
    public void SameDay_NoDayDivider()
    {
        var ts = DateTime.Today.AddHours(10);
        var prev = Msg(1, Alice, ts);
        var curr = Msg(2, Bob, ts.AddHours(1));
        var item = new MessageDisplayItem(curr, prev);
        Assert.False(item.ShowDayDivider);
        Assert.Null(item.DayDividerText);
    }

    [Fact]
    public void PassThroughProperties_MatchMessage()
    {
        var msg = new Message(42, 1, Alice, "test content", DateTime.UtcNow, 10, "2026-01-01", false, [new Reaction("\ud83d\udc4d", 3, true)], []);
        var item = new MessageDisplayItem(msg, null);
        Assert.Equal(42, item.Id);
        Assert.Equal(Alice, item.Author);
        Assert.Equal("test content", item.Content);
        Assert.Equal(10, item.ReplyToId);
        Assert.Equal("2026-01-01", item.EditedAt);
        Assert.True(item.IsEdited);
        Assert.True(item.HasReactions);
        Assert.Single(item.Reactions);
    }

    [Fact]
    public void IsReply_TrueWhenBothIdAndMessageSet()
    {
        var reply = Msg(2, Alice, DateTime.Today.AddHours(10), replyTo: 1);
        var replyTarget = Msg(1, Bob, DateTime.Today.AddHours(9));
        var item = new MessageDisplayItem(reply, null) { ReplyToMessage = replyTarget };
        Assert.True(item.IsReply);
    }

    [Fact]
    public void IsReply_FalseWhenNoReplyTo()
    {
        var item = new MessageDisplayItem(Msg(1, Alice, DateTime.Today.AddHours(10)), null);
        Assert.False(item.IsReply);
    }

    [Fact]
    public void IsReply_FalseWhenReplyToIdButNoMessage()
    {
        var reply = Msg(2, Alice, DateTime.Today.AddHours(10), replyTo: 1);
        var item = new MessageDisplayItem(reply, null);
        Assert.False(item.IsReply);
    }
}

// ── ChannelGroup Tests ──────────────────────────────────────────────────────

public class ChannelGroupTests
{
    [Fact]
    public void HasCategory_TrueWhenSet()
    {
        var group = new ChannelGroup { CategoryName = "Text Channels" };
        Assert.True(group.HasCategory);
    }

    [Fact]
    public void HasCategory_FalseWhenNull()
    {
        var group = new ChannelGroup { CategoryName = null };
        Assert.False(group.HasCategory);
    }

    [Fact]
    public void DisplayName_UppercaseCategory()
    {
        var group = new ChannelGroup { CategoryName = "Text Channels" };
        Assert.Equal("TEXT CHANNELS", group.DisplayName);
    }

    [Fact]
    public void DisplayName_EmptyWhenNoCategory()
    {
        var group = new ChannelGroup { CategoryName = null };
        Assert.Equal(string.Empty, group.DisplayName);
    }

    [Fact]
    public void IsExpanded_DefaultsTrue()
    {
        var group = new ChannelGroup();
        Assert.True(group.IsExpanded);
    }

    [Fact]
    public void IsExpanded_RaisesPropertyChanged()
    {
        var group = new ChannelGroup();
        string? changed = null;
        group.PropertyChanged += (_, e) => changed = e.PropertyName;
        group.IsExpanded = false;
        Assert.Equal("IsExpanded", changed);
    }

    [Fact]
    public void IsExpanded_SameValue_NoEvent()
    {
        var group = new ChannelGroup();
        string? changed = null;
        group.PropertyChanged += (_, e) => changed = e.PropertyName;
        group.IsExpanded = true; // same as default
        Assert.Null(changed);
    }

    [Fact]
    public void Items_InitializedEmpty()
    {
        var group = new ChannelGroup();
        Assert.Empty(group.Items);
    }
}

// ── ChannelItem Tests ───────────────────────────────────────────────────────

public class ChannelItemTests
{
    private static Channel TextChannel => new(1, "general", ChannelType.Text, "Chat", 0, 3, null, "Welcome");
    private static Channel VoiceChannel => new(2, "Lounge", ChannelType.Voice, "Voice", 1, 0, null);

    [Fact]
    public void PassThrough_Id() => Assert.Equal(1, new ChannelItem { Channel = TextChannel }.Id);

    [Fact]
    public void PassThrough_Name() => Assert.Equal("general", new ChannelItem { Channel = TextChannel }.Name);

    [Fact]
    public void PassThrough_Type() => Assert.Equal(ChannelType.Text, new ChannelItem { Channel = TextChannel }.Type);

    [Fact]
    public void PassThrough_UnreadCount() => Assert.Equal(3, new ChannelItem { Channel = TextChannel }.UnreadCount);

    [Fact]
    public void PassThrough_Topic() => Assert.Equal("Welcome", new ChannelItem { Channel = TextChannel }.Topic);

    [Fact]
    public void VoiceUsers_InitializedEmpty()
    {
        var item = new ChannelItem { Channel = VoiceChannel };
        Assert.Empty(item.VoiceUsers);
    }

    [Fact]
    public void VoiceUsers_CanAddState()
    {
        var item = new ChannelItem { Channel = VoiceChannel };
        item.VoiceUsers.Add(new VoiceStateInfo { UserId = 1, ChannelId = 2, Username = "alice" });
        Assert.Single(item.VoiceUsers);
    }
}

// ── MemberGroup Tests ───────────────────────────────────────────────────────

public class MemberGroupTests
{
    [Fact]
    public void Members_InitializedEmpty()
    {
        var mg = new MemberGroup();
        Assert.Empty(mg.Members);
    }

    [Fact]
    public void MemberCount_ReflectsCollection()
    {
        var mg = new MemberGroup { RoleName = "Admin" };
        mg.Members.Add(new User(1, "alice", null, 1, UserStatus.Online));
        mg.Members.Add(new User(2, "bob", null, 1, UserStatus.Online));
        Assert.Equal(2, mg.MemberCount);
    }

    [Fact]
    public void Properties_StoreValues()
    {
        var mg = new MemberGroup { RoleName = "Owner", RoleColor = "#e74c3c", Position = 100 };
        Assert.Equal("Owner", mg.RoleName);
        Assert.Equal("#e74c3c", mg.RoleColor);
        Assert.Equal(100, mg.Position);
    }
}

// ── VoiceStateInfo Tests ────────────────────────────────────────────────────

public class VoiceStateInfoTests
{
    [Fact]
    public void Muted_RaisesPropertyChanged()
    {
        var vs = new VoiceStateInfo { UserId = 1 };
        string? changed = null;
        vs.PropertyChanged += (_, e) => changed = e.PropertyName;
        vs.Muted = true;
        Assert.Equal("Muted", changed);
    }

    [Fact]
    public void Deafened_RaisesPropertyChanged()
    {
        var vs = new VoiceStateInfo { UserId = 1 };
        string? changed = null;
        vs.PropertyChanged += (_, e) => changed = e.PropertyName;
        vs.Deafened = true;
        Assert.Equal("Deafened", changed);
    }

    [Fact]
    public void Speaking_RaisesPropertyChanged()
    {
        var vs = new VoiceStateInfo { UserId = 1 };
        string? changed = null;
        vs.PropertyChanged += (_, e) => changed = e.PropertyName;
        vs.Speaking = true;
        Assert.Equal("Speaking", changed);
    }

    [Fact]
    public void SameValue_NoEvent()
    {
        var vs = new VoiceStateInfo { UserId = 1 };
        string? changed = null;
        vs.PropertyChanged += (_, e) => changed = e.PropertyName;
        vs.Muted = false; // default is false
        Assert.Null(changed);
    }

    [Fact]
    public void ChannelId_IsMutable()
    {
        var vs = new VoiceStateInfo { UserId = 1, ChannelId = 10 };
        vs.ChannelId = 20;
        Assert.Equal(20, vs.ChannelId);
    }
}

// ── Channel Record Tests ────────────────────────────────────────────────────

public class ChannelRecordTests
{
    [Fact]
    public void WithExpression_CreatesNewInstance()
    {
        var original = new Channel(1, "general", ChannelType.Text, "Chat", 0, 0, null);
        var updated = original with { UnreadCount = 5 };
        Assert.Equal(5, updated.UnreadCount);
        Assert.Equal(0, original.UnreadCount);
    }

    [Fact]
    public void Topic_DefaultsToNull()
    {
        var ch = new Channel(1, "general", ChannelType.Text, "Chat", 0, 0, null);
        Assert.Null(ch.Topic);
    }

    [Fact]
    public void ChannelType_EnumValues()
    {
        Assert.Equal(ChannelType.Text, new Channel(1, "g", ChannelType.Text, null, 0, 0, null).Type);
        Assert.Equal(ChannelType.Voice, new Channel(2, "v", ChannelType.Voice, null, 0, 0, null).Type);
        Assert.Equal(ChannelType.Announcement, new Channel(3, "a", ChannelType.Announcement, null, 0, 0, null).Type);
    }
}

// ── User Record Tests ───────────────────────────────────────────────────────

public class UserRecordTests
{
    [Fact]
    public void WithExpression_CreatesNewInstance()
    {
        var original = new User(1, "alice", null, 1, UserStatus.Online);
        var updated = original with { Status = UserStatus.Dnd };
        Assert.Equal(UserStatus.Dnd, updated.Status);
        Assert.Equal(UserStatus.Online, original.Status);
    }

    [Fact]
    public void UserStatus_AllValues()
    {
        Assert.Equal(4, Enum.GetValues<UserStatus>().Length);
    }
}

// ── Message Record Tests ────────────────────────────────────────────────────

public class MessageRecordTests
{
    [Fact]
    public void WithExpression_EditedAt()
    {
        var msg = new Message(1, 1, new User(1, "alice", null, 1, UserStatus.Online), "hi", DateTime.UtcNow, null, null, false, [], []);
        var edited = msg with { Content = "edited", EditedAt = "2026-01-01T00:00:00Z" };
        Assert.Equal("edited", edited.Content);
        Assert.NotNull(edited.EditedAt);
        Assert.Null(msg.EditedAt);
    }

    [Fact]
    public void WithExpression_Deleted()
    {
        var msg = new Message(1, 1, new User(1, "alice", null, 1, UserStatus.Online), "hi", DateTime.UtcNow, null, null, false, [], []);
        var deleted = msg with { Deleted = true, Content = "[deleted]" };
        Assert.True(deleted.Deleted);
        Assert.Equal("[deleted]", deleted.Content);
        Assert.False(msg.Deleted);
    }

    [Fact]
    public void Reactions_EmptyByDefault()
    {
        var msg = new Message(1, 1, new User(1, "a", null, 1, UserStatus.Online), "hi", DateTime.UtcNow, null, null, false, [], []);
        Assert.Empty(msg.Reactions);
    }
}

// ── Reaction Record Tests ───────────────────────────────────────────────────

public class ReactionRecordTests
{
    [Fact]
    public void Stores_Values()
    {
        var r = new Reaction("👍", 3, true);
        Assert.Equal("👍", r.Emoji);
        Assert.Equal(3, r.Count);
        Assert.True(r.Me);
    }
}

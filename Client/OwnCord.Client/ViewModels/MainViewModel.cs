using System.Collections.ObjectModel;
using System.Threading;
using System.Windows;
using System.Windows.Input;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.ViewModels;

public sealed class MainViewModel : ViewModelBase
{
    private IChatService? _chat;
    private Channel? _selectedChannel;
    private string _messageInput = string.Empty;
    private bool _isTyping;
    private string? _connectionStatus;
    private Timer? _typingTimer;

    public MainViewModel()
    {
        Channels = [];
        Members = [];
        Messages = [];
        SendMessageCommand = new RelayCommand(OnSendMessage, () => !string.IsNullOrWhiteSpace(MessageInput) && SelectedChannel is not null);
    }

    /// <summary>Wire up ChatService events. Called once after login succeeds.</summary>
    public void Initialize(IChatService chat)
    {
        _chat = chat;

        chat.Ready += p => RunOnUI(() => OnReady(p));
        chat.ChatMessageReceived += p => RunOnUI(() => OnChatMessage(p));
        chat.TypingReceived += p => RunOnUI(() => OnTyping(p));
        chat.PresenceChanged += p => RunOnUI(() => OnPresence(p));
        chat.ChatEdited += p => RunOnUI(() => OnChatEdited(p));
        chat.ChatDeleted += p => RunOnUI(() => OnChatDeleted(p));
        chat.MemberJoined += p => RunOnUI(() => OnMemberJoined(p));
        chat.ChannelCreated += p => RunOnUI(() => OnChannelCreated(p));
        chat.ChannelUpdated += p => RunOnUI(() => OnChannelUpdated(p));
        chat.ChannelDeleted += id => RunOnUI(() => OnChannelDeleted(id));
        chat.ConnectionLost += r => RunOnUI(() => OnConnectionLost(r));
    }

    private static void RunOnUI(Action action)
    {
        if (Application.Current?.Dispatcher is { } dispatcher && !dispatcher.CheckAccess())
            dispatcher.Invoke(action);
        else
            action();
    }

    public string? ConnectionStatus
    {
        get => _connectionStatus;
        set
        {
            if (SetField(ref _connectionStatus, value))
                OnPropertyChanged(nameof(HasConnectionIssue));
        }
    }

    public bool HasConnectionIssue => _connectionStatus is not null;

    public ObservableCollection<Channel> Channels { get; }
    public ObservableCollection<User> Members { get; }
    public ObservableCollection<Message> Messages { get; }

    public Channel? SelectedChannel
    {
        get => _selectedChannel;
        set
        {
            if (SetField(ref _selectedChannel, value))
            {
                Messages.Clear();
                ((RelayCommand)SendMessageCommand).RaiseCanExecuteChanged();
                if (value is not null)
                {
                    _ = _chat?.SendChannelFocusAsync(value.Id);
                    _ = LoadMessagesForChannelAsync(value.Id);
                }
            }
        }
    }

    public string MessageInput
    {
        get => _messageInput;
        set
        {
            if (SetField(ref _messageInput, value))
                ((RelayCommand)SendMessageCommand).RaiseCanExecuteChanged();
        }
    }

    public bool IsTyping
    {
        get => _isTyping;
        set => SetField(ref _isTyping, value);
    }

    public string? TypingText { get; private set; }

    public ICommand SendMessageCommand { get; }

    public void LoadChannels(IEnumerable<Channel> channels)
    {
        Channels.Clear();
        foreach (var ch in channels) Channels.Add(ch);
    }

    public void LoadMembers(IEnumerable<User> members)
    {
        Members.Clear();
        foreach (var m in members) Members.Add(m);
    }

    public void AddMessage(Message message)
    {
        Messages.Add(message);
    }

    public void UpdateUnreadCount(long channelId, int count)
    {
        var idx = Channels.ToList().FindIndex(c => c.Id == channelId);
        if (idx < 0) return;
        var updated = Channels[idx] with { UnreadCount = count };
        Channels[idx] = updated;
    }

    public void ShowTyping(string username)
    {
        TypingText = $"{username} is typing...";
        IsTyping = true;
        OnPropertyChanged(nameof(TypingText));
    }

    public void HideTyping()
    {
        IsTyping = false;
        TypingText = null;
        OnPropertyChanged(nameof(TypingText));
    }

    private void OnSendMessage()
    {
        if (_chat is null || SelectedChannel is null || string.IsNullOrWhiteSpace(MessageInput)) return;
        var channelId = SelectedChannel.Id;
        var content = MessageInput;
        MessageInput = string.Empty;
        _ = _chat.SendMessageAsync(channelId, content);
    }

    private async Task LoadMessagesForChannelAsync(long channelId)
    {
        if (_chat is null) return;
        try
        {
            var response = await _chat.GetMessagesAsync(channelId);
            Messages.Clear();
            foreach (var msg in response.Messages)
            {
                Messages.Add(new Message(
                    msg.Id,
                    msg.ChannelId,
                    new User(msg.UserId, msg.Username ?? "Unknown", msg.Avatar, 0, UserStatus.Online),
                    msg.Content,
                    DateTime.TryParse(msg.Timestamp, out var ts) ? ts : DateTime.UtcNow,
                    msg.ReplyTo,
                    msg.EditedAt,
                    msg.Deleted,
                    []
                ));
            }
        }
        catch
        {
            // Channel message load failed — don't crash
        }
    }

    // ── ChatService event handlers ──────────────────────────────────────────

    private void OnReady(ReadyPayload payload)
    {
        ConnectionStatus = null;
        Channels.Clear();
        foreach (var ch in payload.Channels)
        {
            var type = ch.Type switch
            {
                "voice" => ChannelType.Voice,
                "announcement" => ChannelType.Announcement,
                _ => ChannelType.Text
            };
            Channels.Add(new Channel(ch.Id, ch.Name, type, ch.Category, ch.Position, 0, null));
        }

        Members.Clear();
        foreach (var m in payload.Members)
        {
            var status = m.Status switch
            {
                "online" => UserStatus.Online,
                "idle" => UserStatus.Idle,
                "dnd" => UserStatus.Dnd,
                _ => UserStatus.Offline
            };
            Members.Add(new User(m.Id, m.Username, m.Avatar, m.RoleId, status));
        }

        if (Channels.Count > 0)
            SelectedChannel = Channels[0];
    }

    private void OnChatMessage(ChatMessagePayload payload)
    {
        if (SelectedChannel is not null && payload.ChannelId == SelectedChannel.Id)
        {
            var msg = new Message(
                payload.Id,
                payload.ChannelId,
                new User(payload.User.Id, payload.User.Username, payload.User.Avatar, 0, UserStatus.Online),
                payload.Content,
                DateTime.TryParse(payload.Timestamp, out var ts) ? ts : DateTime.UtcNow,
                payload.ReplyTo,
                null,
                false,
                []
            );
            Messages.Add(msg);
        }
        else
        {
            // Increment unread for non-active channel
            UpdateUnreadCount(payload.ChannelId, GetUnreadCount(payload.ChannelId) + 1);
        }
    }

    private void OnTyping(TypingPayload payload)
    {
        if (SelectedChannel is not null && payload.ChannelId == SelectedChannel.Id)
        {
            ShowTyping(payload.Username);
            _typingTimer?.Dispose();
            _typingTimer = new Timer(_ => RunOnUI(HideTyping), null, 5000, Timeout.Infinite);
        }
    }

    private void OnPresence(PresencePayload payload)
    {
        // Update member status in the member list
        var idx = Members.ToList().FindIndex(m => m.Id == payload.UserId);
        if (idx < 0) return;
        var status = payload.Status switch
        {
            "online" => UserStatus.Online,
            "idle" => UserStatus.Idle,
            "dnd" => UserStatus.Dnd,
            _ => UserStatus.Offline
        };
        Members[idx] = Members[idx] with { Status = status };
    }

    private void OnChatEdited(ChatEditedPayload payload)
    {
        var idx = Messages.ToList().FindIndex(m => m.Id == payload.MessageId);
        if (idx < 0) return;
        Messages[idx] = Messages[idx] with { Content = payload.Content, EditedAt = payload.EditedAt };
    }

    private void OnChatDeleted(ChatDeletedPayload payload)
    {
        var idx = Messages.ToList().FindIndex(m => m.Id == payload.MessageId);
        if (idx < 0) return;
        Messages[idx] = Messages[idx] with { Deleted = true, Content = "[deleted]" };
    }

    private void OnMemberJoined(WsMember payload)
    {
        // Don't add duplicates
        if (Members.Any(m => m.Id == payload.Id))
            return;

        var status = payload.Status switch
        {
            "online" => UserStatus.Online,
            "idle" => UserStatus.Idle,
            "dnd" => UserStatus.Dnd,
            _ => UserStatus.Offline
        };
        Members.Add(new User(payload.Id, payload.Username, payload.Avatar, payload.RoleId, status));
    }

    private void OnChannelCreated(ChannelEventPayload payload)
    {
        if (Channels.Any(c => c.Id == payload.Id)) return;
        var type = payload.Type switch
        {
            "voice" => ChannelType.Voice,
            "announcement" => ChannelType.Announcement,
            _ => ChannelType.Text
        };
        Channels.Add(new Channel(payload.Id, payload.Name, type, payload.Category, payload.Position, 0, null));
    }

    private void OnChannelUpdated(ChannelEventPayload payload)
    {
        var idx = Channels.ToList().FindIndex(c => c.Id == payload.Id);
        if (idx < 0) return;
        var type = payload.Type switch
        {
            "voice" => ChannelType.Voice,
            "announcement" => ChannelType.Announcement,
            _ => ChannelType.Text
        };
        Channels[idx] = new Channel(payload.Id, payload.Name, type, payload.Category, payload.Position, Channels[idx].UnreadCount, Channels[idx].LastMessageId);
    }

    private void OnChannelDeleted(long channelId)
    {
        var ch = Channels.FirstOrDefault(c => c.Id == channelId);
        if (ch is not null)
        {
            Channels.Remove(ch);
            if (SelectedChannel?.Id == channelId)
                SelectedChannel = Channels.FirstOrDefault();
        }
    }

    private void OnConnectionLost(string reason)
    {
        ConnectionStatus = "Disconnected — reconnecting...";
    }

    private int GetUnreadCount(long channelId)
    {
        var ch = Channels.FirstOrDefault(c => c.Id == channelId);
        return ch?.UnreadCount ?? 0;
    }
}

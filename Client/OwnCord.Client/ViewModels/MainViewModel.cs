using System.Collections.ObjectModel;
using System.Threading;
using System.Windows;
using System.Windows.Input;
using OwnCord.Client.Models;
using OwnCord.Client.Services;

namespace OwnCord.Client.ViewModels;

public sealed class MainViewModel : ViewModelBase, IDisposable
{
    private IChatService? _chat;
    private Channel? _selectedChannel;
    private string _messageInput = string.Empty;
    private bool _isTyping;
    private string? _connectionStatus;
    private Timer? _typingTimer;
    private bool _isMemberListVisible = true;
    private bool _isInVoice;
    private string? _voiceChannelName;
    private long _voiceChannelId;
    private bool _isMuted;
    private bool _isDeafened;
    private Message? _replyingToMessage;
    private long? _editingMessageId;
    private ObservableCollection<ServerProfile> _serverProfiles = [];
    private ServerProfile? _activeServer;
    private bool _showStatusPicker;
    private bool _showSettings;
    private bool _showEmojiPicker;
    private string _toastMessage = string.Empty;
    private bool _showToast;
    private User? _popupUser;
    private bool _showUserPopup;
    private double _userPopupX;
    private double _userPopupY;
    private bool _isHomeView;
    private string _selectedFriendsTab = "online";
    private string _friendSearchText = string.Empty;

    public MainViewModel()
    {
        Channels = [];
        Members = [];
        Messages = [];
        DisplayMessages = [];
        Roles = [];
        ChannelGroups = [];
        MemberGroups = [];
        VoiceStates = [];

        SendMessageCommand = new RelayCommand(OnSendMessage, () => !string.IsNullOrWhiteSpace(MessageInput) && SelectedChannel is not null);
        ToggleMemberListCommand = new RelayCommand(() => IsMemberListVisible = !IsMemberListVisible);
        JoinVoiceCommand = new RelayCommand<Channel>(OnJoinVoice);
        LeaveVoiceCommand = new RelayCommand(OnLeaveVoice);
        ToggleMuteCommand = new RelayCommand(OnToggleMute);
        ToggleDeafenCommand = new RelayCommand(OnToggleDeafen);
        ToggleCategoryCommand = new RelayCommand<ChannelGroup>(OnToggleCategory);
        SelectChannelCommand = new RelayCommand<object>(OnSelectChannel);
        StartReplyCommand = new RelayCommand<Message>(OnStartReply);
        CancelReplyCommand = new RelayCommand(OnCancelReply);
        DeleteMessageCommand = new RelayCommand<Message>(OnDeleteMessage);
        StartEditCommand = new RelayCommand<Message>(OnStartEdit);
        SelectServerCommand = new RelayCommand<ServerProfile>(p => { ActiveServer = p; IsHomeView = false; });
        AddServerCommand = new RelayCommand(() => { /* placeholder for future dialog */ });
        ToggleStatusPickerCommand = new RelayCommand(() => ShowStatusPicker = !ShowStatusPicker);
        ChangeStatusCommand = new RelayCommand<string>(OnChangeStatus);
        OpenSettingsCommand = new RelayCommand(() => ShowSettings = true);
        CloseSettingsCommand = new RelayCommand(() => ShowSettings = false);
        ToggleEmojiPickerCommand = new RelayCommand(() => ShowEmojiPicker = !ShowEmojiPicker);
        InsertEmojiCommand = new RelayCommand<string>(OnInsertEmoji);
        ShowUserPopupCommand = new RelayCommand<object>(OnShowUserPopup);
        CloseUserPopupCommand = new RelayCommand(OnCloseUserPopup);
        HomeCommand = new RelayCommand(OnHome);
        SelectFriendsTabCommand = new RelayCommand<string>(OnSelectFriendsTab);
        MessageFriendCommand = new RelayCommand<object>(OnMessageFriend);
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
        chat.ErrorReceived += p => RunOnUI(() => OnWsError(p));
        chat.VoiceStateReceived += p => RunOnUI(() => OnVoiceState(p));
        chat.VoiceLeaveReceived += p => RunOnUI(() => OnVoiceLeave(p));
        chat.VoiceSpeakersReceived += p => RunOnUI(() => OnVoiceSpeakers(p));
    }

    private static void RunOnUI(Action action)
    {
        if (Application.Current?.Dispatcher is { } dispatcher && !dispatcher.CheckAccess())
            dispatcher.Invoke(action);
        else
            action();
    }

    // ── Connection status ────────────────────────────────────────────────────

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

    // ── Collections ──────────────────────────────────────────────────────────

    public ObservableCollection<Channel> Channels { get; }
    public ObservableCollection<User> Members { get; }
    public ObservableCollection<Message> Messages { get; }
    public ObservableCollection<MessageDisplayItem> DisplayMessages { get; }
    public ObservableCollection<WsRole> Roles { get; }
    public ObservableCollection<ChannelGroup> ChannelGroups { get; }
    public ObservableCollection<MemberGroup> MemberGroups { get; }
    public ObservableCollection<VoiceStateInfo> VoiceStates { get; }

    // ── Selected channel ─────────────────────────────────────────────────────

    public Channel? SelectedChannel
    {
        get => _selectedChannel;
        set
        {
            if (SetField(ref _selectedChannel, value))
            {
                OnPropertyChanged(nameof(SelectedChannelTopic));
                Messages.Clear();
                DisplayMessages.Clear();
                ((RelayCommand)SendMessageCommand).RaiseCanExecuteChanged();
                if (value is not null)
                {
                    // Voice channels join voice instead of loading messages
                    if (value.Type == ChannelType.Voice)
                    {
                        _ = _chat?.JoinVoiceAsync(value.Id);
                        return;
                    }

                    _ = _chat?.SendChannelFocusAsync(value.Id);
                    _ = LoadMessagesForChannelAsync(value.Id);
                }
            }
        }
    }

    public string? SelectedChannelTopic => _selectedChannel?.Topic;

    // ── Message input ────────────────────────────────────────────────────────

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

    // ── Member list visibility ───────────────────────────────────────────────

    public bool IsMemberListVisible
    {
        get => _isMemberListVisible;
        set => SetField(ref _isMemberListVisible, value);
    }

    // ── Voice state (local user) ─────────────────────────────────────────────

    public bool IsInVoice
    {
        get => _isInVoice;
        set => SetField(ref _isInVoice, value);
    }

    public string? VoiceChannelName
    {
        get => _voiceChannelName;
        set => SetField(ref _voiceChannelName, value);
    }

    public bool IsMuted
    {
        get => _isMuted;
        set => SetField(ref _isMuted, value);
    }

    public bool IsDeafened
    {
        get => _isDeafened;
        set => SetField(ref _isDeafened, value);
    }

    // ── Current user info (for user bar) ─────────────────────────────────────

    public string CurrentUsername => _chat?.CurrentUser?.Username ?? "Unknown";
    public string CurrentUserStatus => _chat?.CurrentUser?.Status ?? "offline";

    public UserStatus CurrentUserStatusEnum => CurrentUserStatus switch
    {
        "online" => UserStatus.Online,
        "idle" => UserStatus.Idle,
        "dnd" => UserStatus.Dnd,
        _ => UserStatus.Offline
    };

    // ── Home / Friends view ────────────────────────────────────────────────

    public bool IsHomeView
    {
        get => _isHomeView;
        set => SetField(ref _isHomeView, value);
    }

    public string SelectedFriendsTab
    {
        get => _selectedFriendsTab;
        set => SetField(ref _selectedFriendsTab, value);
    }

    public string FriendSearchText
    {
        get => _friendSearchText;
        set => SetField(ref _friendSearchText, value);
    }

    // ── Settings overlay ──────────────────────────────────────────────────

    public bool ShowSettings
    {
        get => _showSettings;
        set => SetField(ref _showSettings, value);
    }

    // ── Status picker ─────────────────────────────────────────────────────

    public bool ShowStatusPicker
    {
        get => _showStatusPicker;
        set => SetField(ref _showStatusPicker, value);
    }

    // ── Emoji picker ──────────────────────────────────────────────────────

    public bool ShowEmojiPicker
    {
        get => _showEmojiPicker;
        set => SetField(ref _showEmojiPicker, value);
    }

    // ── Toast notification ──────────────────────────────────────────────────

    public string ToastMessage
    {
        get => _toastMessage;
        set => SetField(ref _toastMessage, value);
    }

    public bool ShowToast
    {
        get => _showToast;
        set => SetField(ref _showToast, value);
    }

    public void ShowToastMessage(string message)
    {
        ToastMessage = message;
        ShowToast = true;
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    public ICommand SendMessageCommand { get; }
    public ICommand ToggleMemberListCommand { get; }
    public ICommand JoinVoiceCommand { get; }
    public ICommand LeaveVoiceCommand { get; }
    public ICommand ToggleMuteCommand { get; }
    public ICommand ToggleDeafenCommand { get; }
    public ICommand ToggleCategoryCommand { get; }
    public ICommand SelectChannelCommand { get; }
    public ICommand StartReplyCommand { get; }
    public ICommand CancelReplyCommand { get; }
    public ICommand DeleteMessageCommand { get; }
    public ICommand StartEditCommand { get; }
    public ICommand SelectServerCommand { get; }
    public ICommand AddServerCommand { get; }
    public ICommand ToggleStatusPickerCommand { get; }
    public ICommand ChangeStatusCommand { get; }
    public ICommand OpenSettingsCommand { get; }
    public ICommand CloseSettingsCommand { get; }
    public ICommand ToggleEmojiPickerCommand { get; }
    public ICommand InsertEmojiCommand { get; }
    public ICommand ShowUserPopupCommand { get; }
    public ICommand CloseUserPopupCommand { get; }
    public ICommand HomeCommand { get; }
    public ICommand SelectFriendsTabCommand { get; }
    public ICommand MessageFriendCommand { get; }

    // ── User popup state ────────────────────────────────────────────────────

    public User? PopupUser
    {
        get => _popupUser;
        set => SetField(ref _popupUser, value);
    }

    public bool ShowUserPopup
    {
        get => _showUserPopup;
        set => SetField(ref _showUserPopup, value);
    }

    public double UserPopupX
    {
        get => _userPopupX;
        set => SetField(ref _userPopupX, value);
    }

    public double UserPopupY
    {
        get => _userPopupY;
        set => SetField(ref _userPopupY, value);
    }

    /// <summary>Resolved role name for the popup user.</summary>
    public string PopupUserRoleName
    {
        get
        {
            if (_popupUser is null) return "Member";
            var role = Roles.FirstOrDefault(r => r.Id == _popupUser.RoleId);
            return role?.Name ?? "Member";
        }
    }

    /// <summary>Resolved role color for the popup user.</summary>
    public string PopupUserRoleColor
    {
        get
        {
            if (_popupUser is null) return "#949ba4";
            var role = Roles.FirstOrDefault(r => r.Id == _popupUser.RoleId);
            return role?.Color ?? "#949ba4";
        }
    }

    /// <summary>Status text for the popup user.</summary>
    public string PopupUserStatusText => _popupUser?.Status switch
    {
        UserStatus.Online => "Online",
        UserStatus.Idle => "Idle",
        UserStatus.Dnd => "Do Not Disturb",
        _ => "Offline"
    };

    // ── Reply state ───────────────────────────────────────────────────────

    public Message? ReplyingToMessage
    {
        get => _replyingToMessage;
        set
        {
            if (SetField(ref _replyingToMessage, value))
                OnPropertyChanged(nameof(IsReplying));
        }
    }

    public bool IsReplying => _replyingToMessage is not null;

    // ── Edit state ────────────────────────────────────────────────────────

    public long? EditingMessageId
    {
        get => _editingMessageId;
        set => SetField(ref _editingMessageId, value);
    }

    // ── Server strip ──────────────────────────────────────────────────────────

    public ObservableCollection<ServerProfile> ServerProfiles
    {
        get => _serverProfiles;
        set => SetField(ref _serverProfiles, value);
    }

    public ServerProfile? ActiveServer
    {
        get => _activeServer;
        set => SetField(ref _activeServer, value);
    }

    // ── Public helpers ───────────────────────────────────────────────────────

    public void LoadServerProfiles(IReadOnlyList<ServerProfile> profiles)
    {
        ServerProfiles = new ObservableCollection<ServerProfile>(profiles);
        if (ActiveServer is null && ServerProfiles.Count > 0)
            ActiveServer = ServerProfiles[0];
    }

    public void LoadChannels(IEnumerable<Channel> channels)
    {
        Channels.Clear();
        foreach (var ch in channels) Channels.Add(ch);
        RebuildChannelGroups();
    }

    public void LoadMembers(IEnumerable<User> members)
    {
        Members.Clear();
        foreach (var m in members) Members.Add(m);
        RebuildMemberGroups();
    }

    public void AddMessage(Message message)
    {
        Messages.Add(message);
        AppendDisplayMessage(message);
    }

    public void UpdateUnreadCount(long channelId, int count)
    {
        for (var i = 0; i < Channels.Count; i++)
        {
            if (Channels[i].Id == channelId)
            {
                if (Channels[i].UnreadCount == count) return;
                Channels[i] = Channels[i] with { UnreadCount = count };

                // Update the specific ChannelItem in-place instead of rebuilding all groups
                foreach (var group in ChannelGroups)
                {
                    for (var j = 0; j < group.Items.Count; j++)
                    {
                        if (group.Items[j].Channel.Id == channelId)
                        {
                            group.Items[j] = new ChannelItem { Channel = Channels[i] };
                            return;
                        }
                    }
                }
                return;
            }
        }
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

    /// <summary>Get voice users for a specific channel.</summary>
    public IEnumerable<VoiceStateInfo> GetVoiceUsersForChannel(long channelId)
        => VoiceStates.Where(vs => vs.ChannelId == channelId);

    // ── Command handlers ─────────────────────────────────────────────────────

    private void OnInsertEmoji(string? emoji)
    {
        if (string.IsNullOrEmpty(emoji)) return;
        MessageInput += emoji;
        ShowEmojiPicker = false;
    }

    private void OnChangeStatus(string? status)
    {
        if (string.IsNullOrWhiteSpace(status)) return;
        ShowStatusPicker = false;
        _ = _chat?.SendStatusChangeAsync(status);
        OnPropertyChanged(nameof(CurrentUserStatus));
        OnPropertyChanged(nameof(CurrentUserStatusEnum));
    }

    private void OnSendMessage()
    {
        if (_chat is null || SelectedChannel is null || string.IsNullOrWhiteSpace(MessageInput)) return;
        var channelId = SelectedChannel.Id;
        var content = MessageInput;
        MessageInput = string.Empty;

        if (EditingMessageId is { } editId)
        {
            EditingMessageId = null;
            _ = _chat.EditMessageAsync(editId, content);
        }
        else
        {
            var replyTo = ReplyingToMessage?.Id;
            ReplyingToMessage = null;
            _ = _chat.SendMessageAsync(channelId, content, replyTo);
        }
    }

    private void OnSelectChannel(object? param)
    {
        var channel = param switch
        {
            Channel ch => ch,
            ChannelItem ci => ci.Channel,
            _ => null
        };
        if (channel is null) return;
        SelectedChannel = channel;
    }

    private void OnJoinVoice(Channel? channel)
    {
        if (_chat is null || channel is null || channel.Type != ChannelType.Voice) return;
        _ = _chat.JoinVoiceAsync(channel.Id);
    }

    private void OnLeaveVoice()
    {
        if (_chat is null) return;
        _ = _chat.LeaveVoiceAsync();
        IsInVoice = false;
        VoiceChannelName = null;
        IsMuted = false;
        IsDeafened = false;
    }

    private void OnToggleMute()
    {
        if (_chat is null || !IsInVoice) return;
        IsMuted = !IsMuted;
        _ = _chat.SendVoiceMuteAsync(IsMuted);
    }

    private void OnToggleDeafen()
    {
        if (_chat is null || !IsInVoice) return;
        IsDeafened = !IsDeafened;
        if (IsDeafened) IsMuted = true;
        _ = _chat.SendVoiceDeafenAsync(IsDeafened);
    }

    private static void OnToggleCategory(ChannelGroup? group)
    {
        if (group is null) return;
        group.IsExpanded = !group.IsExpanded;
    }

    private void OnStartReply(Message? message)
    {
        if (message is null) return;
        ReplyingToMessage = message;
    }

    private void OnCancelReply()
    {
        ReplyingToMessage = null;
    }

    private void OnDeleteMessage(Message? message)
    {
        if (_chat is null || message is null) return;
        _ = _chat.DeleteMessageAsync(message.Id);
    }

    private void OnStartEdit(Message? message)
    {
        if (message is null) return;
        EditingMessageId = message.Id;
        MessageInput = message.Content;
    }

    private void OnShowUserPopup(object? param)
    {
        var user = param switch
        {
            User u => u,
            MessageDisplayItem di => di.Author,
            Message m => m.Author,
            _ => null
        };
        if (user is null) return;

        PopupUser = user;
        ShowUserPopup = true;
        OnPropertyChanged(nameof(PopupUserRoleName));
        OnPropertyChanged(nameof(PopupUserRoleColor));
        OnPropertyChanged(nameof(PopupUserStatusText));
    }

    private void OnCloseUserPopup()
    {
        ShowUserPopup = false;
        PopupUser = null;
    }

    private void OnHome()
    {
        IsHomeView = true;
    }

    private void OnSelectFriendsTab(string? tab)
    {
        if (string.IsNullOrWhiteSpace(tab)) return;
        SelectedFriendsTab = tab;
    }

    private void OnMessageFriend(object? param)
    {
        // Placeholder: in the future, open or create a DM conversation with the friend
    }

    // ── Message display items ──────────────────────────────────────────────────

    private void RebuildDisplayMessages()
    {
        DisplayMessages.Clear();
        Message? prev = null;
        foreach (var msg in Messages)
        {
            var item = new MessageDisplayItem(msg, prev)
            {
                ReplyToMessage = msg.ReplyToId is not null
                    ? Messages.FirstOrDefault(m => m.Id == msg.ReplyToId)
                    : null,
                IsOwnMessage = _chat?.CurrentUser is { } u && msg.Author.Id == u.Id
            };
            DisplayMessages.Add(item);
            prev = msg;
        }
    }

    private void AppendDisplayMessage(Message message)
    {
        var prev = Messages.Count > 1 ? Messages[^2] : null;
        var item = new MessageDisplayItem(message, prev)
        {
            ReplyToMessage = message.ReplyToId is not null
                ? Messages.FirstOrDefault(m => m.Id == message.ReplyToId)
                : null,
            IsOwnMessage = _chat?.CurrentUser is { } u && message.Author.Id == u.Id
        };
        DisplayMessages.Add(item);
    }

    // ── Channel grouping ─────────────────────────────────────────────────────

    private void RebuildChannelGroups()
    {
        // Preserve expanded state across rebuilds
        var expandedState = new Dictionary<string, bool>();
        foreach (var g in ChannelGroups)
            expandedState.TryAdd(g.CategoryName ?? "", g.IsExpanded);

        ChannelGroups.Clear();

        var grouped = Channels
            .OrderBy(c => c.Position)
            .GroupBy(c => c.Category);

        foreach (var g in grouped.OrderBy(g => g.Key is null ? 0 : 1))
        {
            var group = new ChannelGroup { CategoryName = g.Key };

            // Restore expanded state
            if (expandedState.TryGetValue(g.Key ?? "", out var wasExpanded))
                group.IsExpanded = wasExpanded;

            foreach (var ch in g)
            {
                var item = new ChannelItem { Channel = ch };

                // Populate voice users for voice channels
                if (ch.Type == ChannelType.Voice)
                {
                    foreach (var vs in VoiceStates.Where(vs => vs.ChannelId == ch.Id))
                        item.VoiceUsers.Add(vs);
                }

                group.Items.Add(item);
            }

            ChannelGroups.Add(group);
        }
    }

    // ── Member grouping by role ──────────────────────────────────────────────

    private void RebuildMemberGroups()
    {
        MemberGroups.Clear();

        var roleMap = new Dictionary<long, WsRole>();
        foreach (var r in Roles)
            roleMap.TryAdd(r.Id, r);

        var grouped = Members
            .GroupBy(m => m.RoleId)
            .Select(g =>
            {
                roleMap.TryGetValue(g.Key, out var role);
                return new { Role = role, Members = g.ToList() };
            })
            .OrderBy(g => g.Role?.Position ?? int.MaxValue);

        foreach (var g in grouped)
        {
            var mg = new MemberGroup
            {
                RoleName = g.Role?.Name ?? "Members",
                RoleColor = g.Role?.Color,
                Position = g.Role?.Position ?? int.MaxValue
            };
            foreach (var m in g.Members) mg.Members.Add(m);
            MemberGroups.Add(mg);
        }
    }

    // ── Message loading ──────────────────────────────────────────────────────

    private async Task LoadMessagesForChannelAsync(long channelId)
    {
        if (_chat is null) return;
        try
        {
            var response = await _chat.GetMessagesAsync(channelId);
            Messages.Clear();
            DisplayMessages.Clear();
            foreach (var msg in response.Messages)
            {
                var attachments = msg.Attachments?
                    .Select(a => new Attachment(a.Id, a.Filename, a.Size, a.Mime, a.Url))
                    .ToList() as IReadOnlyList<Attachment> ?? Array.Empty<Attachment>();
                Messages.Add(new Message(
                    msg.Id,
                    msg.ChannelId,
                    new User(msg.UserId, msg.Username ?? "Unknown", msg.Avatar, 0, UserStatus.Online),
                    msg.Content,
                    DateTime.TryParse(msg.Timestamp, out var ts) ? ts : DateTime.UtcNow,
                    msg.ReplyTo,
                    msg.EditedAt,
                    msg.Deleted,
                    [],
                    attachments
                ));
            }
            RebuildDisplayMessages();
        }
        catch (Exception ex)
        {
            ConnectionStatus = $"Failed to load messages: {ex.Message}";
        }
    }

    // ── ChatService event handlers ──────────────────────────────────────────

    private void OnReady(ReadyPayload payload)
    {
        ConnectionStatus = null;

        // Store roles
        Roles.Clear();
        foreach (var r in payload.Roles) Roles.Add(r);

        // Load channels
        Channels.Clear();
        foreach (var ch in payload.Channels)
        {
            var type = ch.Type switch
            {
                "voice" => ChannelType.Voice,
                "announcement" => ChannelType.Announcement,
                _ => ChannelType.Text
            };
            Channels.Add(new Channel(ch.Id, ch.Name, type, ch.Category, ch.Position, 0, null, ch.Topic));
        }

        // Load members
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
        RebuildMemberGroups();

        // Load voice states
        VoiceStates.Clear();
        foreach (var vs in payload.VoiceStates)
        {
            VoiceStates.Add(new VoiceStateInfo
            {
                UserId = vs.UserId,
                ChannelId = vs.ChannelId,
                Username = vs.Username,
                Muted = vs.Muted,
                Deafened = vs.Deafened,
                Speaking = vs.Speaking
            });
        }

        // Rebuild channel groups now that voice states are loaded
        RebuildChannelGroups();

        // Notify user bar
        OnPropertyChanged(nameof(CurrentUsername));
        OnPropertyChanged(nameof(CurrentUserStatus));
        OnPropertyChanged(nameof(CurrentUserStatusEnum));

        // Select first text channel
        var firstText = Channels.FirstOrDefault(c => c.Type == ChannelType.Text);
        if (firstText is not null)
            SelectedChannel = firstText;
        else if (Channels.Count > 0)
            SelectedChannel = Channels[0];
    }

    private void OnChatMessage(ChatMessagePayload payload)
    {
        if (SelectedChannel is not null && payload.ChannelId == SelectedChannel.Id)
        {
            var attachments = payload.Attachments?
                .Select(a => new Attachment(a.Id, a.Filename, a.Size, a.Mime, a.Url))
                .ToList() as IReadOnlyList<Attachment> ?? Array.Empty<Attachment>();
            var msg = new Message(
                payload.Id,
                payload.ChannelId,
                new User(payload.User.Id, payload.User.Username, payload.User.Avatar, 0, UserStatus.Online),
                payload.Content,
                DateTime.TryParse(payload.Timestamp, out var ts) ? ts : DateTime.UtcNow,
                payload.ReplyTo,
                null,
                false,
                [],
                attachments
            );
            AddMessage(msg);
        }
        else
        {
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
        var status = payload.Status switch
        {
            "online" => UserStatus.Online,
            "idle" => UserStatus.Idle,
            "dnd" => UserStatus.Dnd,
            _ => UserStatus.Offline
        };
        for (var i = 0; i < Members.Count; i++)
        {
            if (Members[i].Id == payload.UserId)
            {
                Members[i] = Members[i] with { Status = status };
                RebuildMemberGroups();
                break;
            }
        }
    }

    private void OnChatEdited(ChatEditedPayload payload)
    {
        for (var i = 0; i < Messages.Count; i++)
        {
            if (Messages[i].Id == payload.MessageId)
            {
                Messages[i] = Messages[i] with { Content = payload.Content, EditedAt = payload.EditedAt };
                RebuildDisplayMessages();
                break;
            }
        }
    }

    private void OnChatDeleted(ChatDeletedPayload payload)
    {
        for (var i = 0; i < Messages.Count; i++)
        {
            if (Messages[i].Id == payload.MessageId)
            {
                Messages[i] = Messages[i] with { Deleted = true, Content = "[deleted]" };
                RebuildDisplayMessages();
                break;
            }
        }
    }

    private void OnMemberJoined(WsMember payload)
    {
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
        RebuildMemberGroups();
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
        Channels.Add(new Channel(payload.Id, payload.Name, type, payload.Category, payload.Position, 0, null, payload.Topic));
        RebuildChannelGroups();
    }

    private void OnChannelUpdated(ChannelEventPayload payload)
    {
        var idx = -1;
        for (var i = 0; i < Channels.Count; i++)
        {
            if (Channels[i].Id == payload.Id)
            {
                idx = i;
                break;
            }
        }
        if (idx < 0) return;
        var type = payload.Type switch
        {
            "voice" => ChannelType.Voice,
            "announcement" => ChannelType.Announcement,
            _ => ChannelType.Text
        };
        Channels[idx] = new Channel(payload.Id, payload.Name, type, payload.Category, payload.Position, Channels[idx].UnreadCount, Channels[idx].LastMessageId, payload.Topic);
        RebuildChannelGroups();
        if (SelectedChannel?.Id == payload.Id)
            OnPropertyChanged(nameof(SelectedChannelTopic));
    }

    private void OnChannelDeleted(long channelId)
    {
        var ch = Channels.FirstOrDefault(c => c.Id == channelId);
        if (ch is not null)
        {
            Channels.Remove(ch);
            RebuildChannelGroups();
            if (SelectedChannel?.Id == channelId)
                SelectedChannel = Channels.FirstOrDefault();
        }
    }

    private void OnConnectionLost(string reason)
    {
        ConnectionStatus = $"Disconnected \u2014 {reason}";
    }

    private void OnWsError(WsErrorPayload error)
    {
        ConnectionStatus = $"Server error: {error.Message}";
    }

    // ── Voice event handlers ─────────────────────────────────────────────────

    private void OnVoiceState(VoiceStatePayload payload)
    {
        // Update or add voice state
        var existing = VoiceStates.FirstOrDefault(vs => vs.UserId == payload.UserId);
        if (existing is not null)
        {
            existing.ChannelId = payload.ChannelId;
            existing.Muted = payload.Muted;
            existing.Deafened = payload.Deafened;
        }
        else
        {
            VoiceStates.Add(new VoiceStateInfo
            {
                UserId = payload.UserId,
                ChannelId = payload.ChannelId,
                Username = payload.Username,
                Muted = payload.Muted,
                Deafened = payload.Deafened
            });
        }

        // If this is the local user, update voice widget state
        if (_chat?.CurrentUser is not null && payload.UserId == _chat.CurrentUser.Id)
        {
            IsInVoice = true;
            _voiceChannelId = payload.ChannelId;
            VoiceChannelName = Channels.FirstOrDefault(c => c.Id == payload.ChannelId)?.Name ?? "Voice";
            IsMuted = payload.Muted;
            IsDeafened = payload.Deafened;
        }

        RebuildChannelGroups();
    }

    private void OnVoiceLeave(VoiceLeavePayload payload)
    {
        var existing = VoiceStates.FirstOrDefault(vs => vs.UserId == payload.UserId);
        if (existing is not null)
            VoiceStates.Remove(existing);

        // If this is the local user, clear voice widget
        if (_chat?.CurrentUser is not null && payload.UserId == _chat.CurrentUser.Id)
        {
            IsInVoice = false;
            VoiceChannelName = null;
            _voiceChannelId = 0;
            IsMuted = false;
            IsDeafened = false;
        }

        RebuildChannelGroups();
    }

    private void OnVoiceSpeakers(VoiceSpeakersPayload payload)
    {
        var speakerSet = new HashSet<long>(payload.Speakers);
        foreach (var vs in VoiceStates.Where(vs => vs.ChannelId == payload.ChannelId))
        {
            vs.Speaking = speakerSet.Contains(vs.UserId);
        }
    }

    private int GetUnreadCount(long channelId)
    {
        var ch = Channels.FirstOrDefault(c => c.Id == channelId);
        return ch?.UnreadCount ?? 0;
    }

    // ── IDisposable ──────────────────────────────────────────────────────────

    public void Dispose()
    {
        _typingTimer?.Dispose();
        _typingTimer = null;
    }
}

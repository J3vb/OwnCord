using System.Collections.ObjectModel;
using System.Windows.Input;
using OwnCord.Client.Models;

namespace OwnCord.Client.ViewModels;

public sealed class MainViewModel : ViewModelBase
{
    private Channel? _selectedChannel;
    private string _messageInput = string.Empty;
    private bool _isTyping;

    public MainViewModel()
    {
        Channels = [];
        Members = [];
        Messages = [];
        SendMessageCommand = new RelayCommand(OnSendMessage, () => !string.IsNullOrWhiteSpace(MessageInput) && SelectedChannel is not null);
    }

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

    public event Action<long, string>? MessageSendRequested;

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
        if (SelectedChannel is null || string.IsNullOrWhiteSpace(MessageInput)) return;
        MessageSendRequested?.Invoke(SelectedChannel.Id, MessageInput);
        MessageInput = string.Empty;
    }
}

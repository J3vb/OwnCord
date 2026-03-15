using System.Collections.ObjectModel;

namespace OwnCord.Client.Models;

/// <summary>
/// Wraps a Channel with its associated voice users for display in the sidebar.
/// </summary>
public sealed class ChannelItem
{
    public Channel Channel { get; init; } = null!;
    public ObservableCollection<VoiceStateInfo> VoiceUsers { get; } = [];

    // Convenience pass-through for binding
    public long Id => Channel.Id;
    public string Name => Channel.Name;
    public ChannelType Type => Channel.Type;
    public int UnreadCount => Channel.UnreadCount;
    public string? Topic => Channel.Topic;
}

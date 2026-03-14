namespace OwnCord.Client.Models;

public enum ChannelType { Text, Voice, Announcement }

public record Channel(
    long Id,
    string Name,
    ChannelType Type,
    string? Category,
    int Position,
    int UnreadCount,
    long? LastMessageId
);

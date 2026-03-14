namespace OwnCord.Client.Models;

public record Message(
    long Id,
    long ChannelId,
    User Author,
    string Content,
    DateTime Timestamp,
    long? ReplyToId,
    string? EditedAt,
    bool Deleted,
    IReadOnlyList<Reaction> Reactions
);

public record Reaction(string Emoji, int Count, bool Me);

namespace OwnCord.Client.Models;

public record Attachment(
    string Id,
    string Filename,
    long Size,
    string Mime,
    string Url
);

public record Message(
    long Id,
    long ChannelId,
    User Author,
    string Content,
    DateTime Timestamp,
    long? ReplyToId,
    string? EditedAt,
    bool Deleted,
    IReadOnlyList<Reaction> Reactions,
    IReadOnlyList<Attachment> Attachments
);

public record Reaction(string Emoji, int Count, bool Me);

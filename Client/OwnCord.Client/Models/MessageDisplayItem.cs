using System.Linq;

namespace OwnCord.Client.Models;

/// <summary>
/// Wraps a Message with computed display properties for the UI.
/// Handles message grouping (consecutive same-author) and day dividers.
/// </summary>
public sealed class MessageDisplayItem
{
    public Message Message { get; }

    /// <summary>True when this message is from the same author as the previous one
    /// and within 7 minutes — avatar and author name should be hidden.</summary>
    public bool IsGrouped { get; }

    /// <summary>True when this message is the first of a new calendar day.</summary>
    public bool ShowDayDivider { get; }

    /// <summary>Formatted day divider text (e.g. "March 15, 2026").</summary>
    public string? DayDividerText { get; }

    /// <summary>The message this replies to (if any) — set externally by the ViewModel.</summary>
    public Message? ReplyToMessage { get; init; }

    // ── Pass-through convenience properties ──

    public long Id => Message.Id;
    public User Author => Message.Author;
    public string Content => Message.Content;
    public DateTime Timestamp => Message.Timestamp;
    public long? ReplyToId => Message.ReplyToId;
    public string? EditedAt => Message.EditedAt;
    public bool Deleted => Message.Deleted;
    public IReadOnlyList<Reaction> Reactions => Message.Reactions;
    public IReadOnlyList<Attachment> Attachments => Message.Attachments;
    public bool IsEdited => EditedAt is not null;
    public bool HasReactions => Reactions.Count > 0;
    public bool HasAttachments => Attachments.Count > 0;
    public bool IsReply => ReplyToId is not null && ReplyToMessage is not null;
    public bool IsSystemMessage => Message.Author.Username == "System";

    /// <summary>Parsed content segments (text and code blocks).</summary>
    public IReadOnlyList<ContentPart> ContentParts { get; }

    /// <summary>True if the message contains at least one code block.</summary>
    public bool HasCodeBlocks => ContentParts.Any(p => p.IsCode);

    /// <summary>True when the current user authored this message (for showing edit/delete actions).</summary>
    public bool IsOwnMessage { get; init; }

    /// <summary>Hex color for the author's role, e.g. "#e74c3c". Null falls back to white.</summary>
    public string? AuthorRoleColor { get; init; }

    public MessageDisplayItem(Message message, Message? previousMessage)
    {
        Message = message;
        ContentParts = ContentPart.Parse(message.Content);

        // Day divider logic
        if (previousMessage is null ||
            message.Timestamp.Date != previousMessage.Timestamp.Date)
        {
            ShowDayDivider = true;
            DayDividerText = message.Timestamp.Date == DateTime.Today
                ? "Today"
                : message.Timestamp.Date == DateTime.Today.AddDays(-1)
                    ? "Yesterday"
                    : message.Timestamp.ToString("MMMM d, yyyy");
        }

        // Grouping logic: same author, within 7 minutes, no day break, not a reply
        if (previousMessage is not null &&
            !ShowDayDivider &&
            message.Author.Id == previousMessage.Author.Id &&
            message.ReplyToId is null &&
            (message.Timestamp - previousMessage.Timestamp).TotalMinutes <= 7)
        {
            IsGrouped = true;
        }
    }
}

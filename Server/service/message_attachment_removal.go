package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// AttachmentInfo is the attachment block a message frame carries.
type AttachmentInfo = db.AttachmentInfo

// AttachmentsChangedResult is a message whose file list shrank because its author
// removed a file, ready to broadcast as a chat_edited frame that carries the
// remaining files. EditedAt is the message's own, unchanged: removing a file is
// not an edit of its text. Attachments is never nil, and empty when no file is
// left on a message that still has text or other content.
type AttachmentsChangedResult struct {
	MessageID      int64
	ChannelID      int64
	Content        string
	EditedAt       *string
	Attachments    []AttachmentInfo
	IsDM           bool
	ParticipantIDs []int64

	// Mentions are the message's current set, re-resolved from its unchanged
	// content: a chat_edited frame replaces the client's copy.
	Mentions         []int64
	MentionRoles     []int64
	MentionsEveryone bool
	MentionsHere     bool
	// PostOpening marks a forum post's opening message.
	PostOpening bool
}

// AfterAttachmentRemoved works out what readers must hear after a file linked to
// msgID was removed: a message left with no text, no files and no other content
// is deleted (the delete result), anything else is announced with its remaining
// files (the changed result). Both are nil when there is nothing to announce: the
// message is gone, already deleted, or not a user message. userID is the user who
// removed the file.
//
// The delete goes through DeleteMessage, so mention reversal, audit and the DM
// audience all run as for any own delete; if that is refused (an archived
// channel, a rate limit) the message is announced as changed instead.
func (s *MessageService) AfterAttachmentRemoved(ctx context.Context, userID, msgID int64) (*AttachmentsChangedResult, *DeleteMessageResult, error) {
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: load message: %w", ErrInternal, err)
	}
	if msg == nil || msg.Deleted || msg.Kind != db.MessageKindUser {
		return nil, nil, nil
	}
	ch, err := s.st.GetChannel(ctx, msg.ChannelID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: load channel: %w", ErrInternal, err)
	}
	if ch == nil {
		return nil, nil, fmt.Errorf("%w: load channel: channel not found", ErrInternal)
	}
	remaining, err := s.st.GetAttachmentsByMessageIDs(ctx, []int64{msgID})
	if err != nil {
		return nil, nil, fmt.Errorf("%w: load attachments: %w", ErrInternal, err)
	}
	files := remaining[msgID]
	if files == nil {
		files = []AttachmentInfo{}
	}

	forward := s.isForward(ctx, msgID)
	if msg.UserID == userID && len(files) == 0 && strings.TrimSpace(msg.Content) == "" &&
		!forward && !s.hasPollOrSticker(ctx, msgID) {
		del, delErr := s.DeleteMessage(ctx, userID, msgID)
		switch {
		case delErr == nil:
			return nil, del, nil
		case errors.Is(delErr, ErrDeletedMessage):
			// Deleted by someone else between the read and here.
			return nil, nil, nil
		}
		slog.Debug("emptied message kept: delete refused", "msg_id", msgID, "error", delErr)
	}

	// Detached from here on: the file is already gone, so a dropped requester must
	// not lose the announcement.
	bg := context.WithoutCancel(ctx)
	isDM := ch.Type == "dm"
	// A forward's text is a snapshot that never pinged anyone, so it keeps no
	// mentions; resolving them now would add highlights it never had.
	mentions := mentionSet{UserIDs: []int64{}, RoleIDs: []int64{}}
	if !forward {
		mentions = s.resolveMentions(bg, msg.Content, msg.UserID, msg.ChannelID, isDM)
		replyPingID, mErr := s.st.ReplaceMessageMentions(bg, msgID, mentions.UserIDs, mentions.Everyone, mentions.RoleIDs)
		if mErr != nil {
			slog.Error("MessageService.AfterAttachmentRemoved ReplaceMessageMentions", "err", mErr, "msg_id", msgID)
		}
		mentions = mentions.withReplyPing(replyPingID)
	}
	res := &AttachmentsChangedResult{
		MessageID:        msgID,
		ChannelID:        msg.ChannelID,
		Content:          msg.Content,
		EditedAt:         msg.EditedAt,
		Attachments:      files,
		IsDM:             isDM,
		Mentions:         mentions.UserIDs,
		MentionRoles:     mentions.RoleIDs,
		MentionsEveryone: mentions.Everyone,
		MentionsHere:     mentions.HereOnly,
		PostOpening:      s.isPostOpening(bg, ch, msgID),
	}
	if isDM {
		participantIDs, pErr := s.DMAudience(bg, msg.ChannelID, msg.UserID)
		if pErr != nil {
			slog.Error("MessageService.AfterAttachmentRemoved DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// Fail closed to the author, as EditMessage: an empty list would fall back to
			// the channel-topic broadcast and bypass the first-contact gate.
			participantIDs = []int64{msg.UserID}
		}
		res.ParticipantIDs = participantIDs
	}
	return res, nil, nil
}

// isForward reports whether the message is a forward. A failed lookup counts as
// one, so an unreadable message is kept rather than deleted or re-resolved.
func (s *MessageService) isForward(ctx context.Context, msgID int64) bool {
	if s.forward.store == nil {
		return false
	}
	fw, err := s.forward.store.GetMessageForward(ctx, msgID)
	return err != nil || fw != nil
}

// hasPollOrSticker reports whether the message is a poll or a sticker, content
// besides text and files that keeps an otherwise empty message worth showing. A
// failed lookup counts as one, for the same reason as isForward.
func (s *MessageService) hasPollOrSticker(ctx context.Context, msgID int64) bool {
	if s.poll.store != nil {
		meta, err := s.poll.store.GetPollMeta(ctx, msgID)
		if err != nil || meta != nil {
			return true
		}
	}
	if s.sticker != nil {
		st, err := s.sticker.GetMessageSticker(ctx, msgID)
		if err != nil || st != nil {
			return true
		}
	}
	return false
}

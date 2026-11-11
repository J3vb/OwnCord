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

// AttachmentsChangedResult is a message whose file list shrank because its author removed
// a file, to broadcast as chat_edited with the remaining files. EditedAt is unchanged
// (not a text edit). Attachments is never nil, and empty when no file is left on a message
// that still has text or other content.
type AttachmentsChangedResult struct {
	MessageID      int64
	ChannelID      int64
	Content        string
	EditedAt       *string
	Attachments    []AttachmentInfo
	IsDM           bool
	ParticipantIDs []int64

	// Mentions are the message's stored set, unchanged: a chat_edited frame replaces the client's copy.
	Mentions         []int64
	MentionRoles     []int64
	MentionsEveryone bool
	MentionsHere     bool
	PostOpening      bool
}

// EmptyMessageDeleter soft-deletes an author's message only while it is still empty, checked in the
// write itself.
type EmptyMessageDeleter interface {
	DeleteEmptyOwnMessage(ctx context.Context, id, userID int64) error
}

// StoredMentionStore reads the mentions a message was stored with.
type StoredMentionStore interface {
	GetMentionsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]int64, error)
	GetRoleMentionsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]int64, error)
}

var (
	_ EmptyMessageDeleter = (*db.DB)(nil)
	_ StoredMentionStore  = (*db.DB)(nil)
)

var errNoLongerEmpty = errors.New("message is no longer empty")

type removalState struct {
	msg   *db.Message
	ch    *db.Channel
	files []AttachmentInfo
}

// loadRemovalState reads the message, its channel and its remaining files. The state is
// nil when there is nothing to announce (gone, already deleted, not a user message).
func (s *MessageService) loadRemovalState(ctx context.Context, msgID int64) (*removalState, error) {
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil {
		return nil, fmt.Errorf("%w: load message: %w", ErrInternal, err)
	}
	if msg == nil || msg.Deleted || msg.Kind != db.MessageKindUser {
		return nil, nil
	}
	ch, err := s.st.GetChannel(ctx, msg.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("%w: load channel: %w", ErrInternal, err)
	}
	if ch == nil {
		return nil, fmt.Errorf("%w: load channel: channel not found", ErrInternal)
	}
	remaining, err := s.st.GetAttachmentsByMessageIDs(ctx, []int64{msgID})
	if err != nil {
		return nil, fmt.Errorf("%w: load attachments: %w", ErrInternal, err)
	}
	files := remaining[msgID]
	if files == nil {
		files = []AttachmentInfo{}
	}
	return &removalState{msg: msg, ch: ch, files: files}, nil
}

// AfterAttachmentRemoved works out what readers must hear after a file linked to msgID was
// removed: a message left with no text, files or other content is deleted (the delete
// result), anything else is announced with its remaining files (the changed result). Both
// nil when there is nothing to announce. userID removed the file.
// The delete uses the own-delete path (mention reversal, audit, DM audience) but is
// conditional: it lands only while the message is still empty, so text another device
// added meanwhile keeps it. A refused delete announces the message as changed from a fresh
// read. Announced mentions are the stored ones.
func (s *MessageService) AfterAttachmentRemoved(ctx context.Context, userID, msgID int64) (*AttachmentsChangedResult, *DeleteMessageResult, error) {
	st, err := s.loadRemovalState(ctx, msgID)
	if err != nil || st == nil {
		return nil, nil, err
	}
	forward := s.isForward(ctx, msgID)
	if st.msg.UserID == userID && len(st.files) == 0 && strings.TrimSpace(st.msg.Content) == "" &&
		!forward && !s.hasPollOrSticker(ctx, msgID) {
		if s.afterRemovalRead != nil {
			s.afterRemovalRead()
		}
		del, delErr := s.deleteMessage(ctx, userID, msgID, nil, "", true)
		switch {
		case delErr == nil:
			return nil, del, nil
		case errors.Is(delErr, ErrDeletedMessage):
			return nil, nil, nil
		}
		slog.Debug("emptied message kept: delete refused", "msg_id", msgID, "error", delErr)
		if st, err = s.loadRemovalState(ctx, msgID); err != nil || st == nil {
			return nil, nil, err
		}
		forward = s.isForward(ctx, msgID)
	}
	return s.attachmentsChanged(ctx, st, forward), nil, nil
}

func (s *MessageService) attachmentsChanged(ctx context.Context, st *removalState, forward bool) *AttachmentsChangedResult {
	// Detached: the file is already gone, so a dropped requester must not lose the announcement.
	bg := context.WithoutCancel(ctx)
	msg := st.msg
	isDM := st.ch.Type == "dm"
	res := &AttachmentsChangedResult{
		MessageID:        msg.ID,
		ChannelID:        msg.ChannelID,
		Content:          msg.Content,
		EditedAt:         msg.EditedAt,
		Attachments:      st.files,
		IsDM:             isDM,
		Mentions:         []int64{},
		MentionRoles:     []int64{},
		MentionsEveryone: msg.MentionsEveryone,
		MentionsHere:     msg.MentionsEveryone && mentionsHereOnly(msg.Content),
		PostOpening:      s.isPostOpening(bg, st.ch, msg.ID),
	}
	if !forward {
		res.Mentions, res.MentionRoles = s.storedMentionsOf(bg, msg.ID)
	}
	if isDM {
		participantIDs, pErr := s.DMAudience(bg, msg.ChannelID, msg.UserID)
		if pErr != nil {
			slog.Error("MessageService.AfterAttachmentRemoved DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// Fail closed to the author, as EditMessage: an empty list would fall back to the
			// channel-topic broadcast and bypass the first-contact gate.
			participantIDs = []int64{msg.UserID}
		}
		res.ParticipantIDs = participantIDs
	}
	return res
}

func mentionsHereOnly(content string) bool {
	parsed := parseMentionTokens(content)
	return parsed.Here && !parsed.Everyone
}

// storedMentionsOf reads the message's stored user and role mentions, the rows the history
// read returns (a reply ping included). A failed read logs and yields empty sets.
func (s *MessageService) storedMentionsOf(ctx context.Context, msgID int64) (users, roles []int64) {
	users, roles = []int64{}, []int64{}
	if s.storedMentions == nil {
		return users, roles
	}
	ids := []int64{msgID}
	if m, err := s.storedMentions.GetMentionsByMessageIDs(ctx, ids); err != nil {
		slog.Error("MessageService.AfterAttachmentRemoved GetMentionsByMessageIDs", "err", err, "msg_id", msgID)
	} else if got := m[msgID]; got != nil {
		users = got
	}
	if m, err := s.storedMentions.GetRoleMentionsByMessageIDs(ctx, ids); err != nil {
		slog.Error("MessageService.AfterAttachmentRemoved GetRoleMentionsByMessageIDs", "err", err, "msg_id", msgID)
	} else if got := m[msgID]; got != nil {
		roles = got
	}
	return users, roles
}

func (s *MessageService) isForward(ctx context.Context, msgID int64) bool {
	if s.forward.store == nil {
		return false
	}
	fw, err := s.forward.store.GetMessageForward(ctx, msgID)
	return err != nil || fw != nil
}

// hasPollOrSticker reports whether the message is a poll or sticker, content that keeps an
// otherwise empty message worth showing. A failed lookup counts as one, as in isForward.
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

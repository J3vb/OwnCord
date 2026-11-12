package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// messageRemovalStore is what messageRemoval reads and writes. *db.DB satisfies it.
type messageRemovalStore interface {
	db.Auditor
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	// The WithRemoval variants add a removal ledger row in the same transaction when the deleter is not the
	// author; an empty reason falls back to "message removed".
	DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64, reason string) error
	PurgeChannelMessagesWithAction(ctx context.Context, channelID, before int64, limit int, actorID int64, reportID *int64) ([]int64, error)
	// The ban purge's author-and-window-scoped counterparts of PurgeChannelMessagesWithAction.
	PurgeUserChannelMessagesSince(ctx context.Context, channelID, userID int64, since string, limit int) ([]int64, error)
	ListUserMessageChannelsSince(ctx context.Context, userID int64, since string) ([]int64, error)
}

// messageRemoval is MessageService's removal side: single delete, bulk purge and
// the ban purge. mentions reverses the mention badges a removal takes back and
// dm resolves a DM's audience.
type messageRemoval struct {
	st       messageRemovalStore
	perms    *PermissionService
	limiter  *auth.RateLimiter
	mentions *mentionState
	dm       *dmDelivery
	// emptyDeleter backs the guarded delete AfterAttachmentRemoved asks for; nil refuses it.
	emptyDeleter EmptyMessageDeleter
}

func newMessageRemoval(st messageRemovalStore, perms *PermissionService, limiter *auth.RateLimiter, mentions *mentionState, dm *dmDelivery) *messageRemoval {
	r := &messageRemoval{st: st, perms: perms, limiter: limiter, mentions: mentions, dm: dm}
	r.emptyDeleter, _ = st.(EmptyMessageDeleter)
	return r
}

// deleteAuthz decides whether userID may delete msg and whether it runs as a
// moderation action (isMod), per permissions.CanDeleteMessage. Any refusal is one
// opaque ErrForbidden.
func (s *messageRemoval) deleteAuthz(ctx context.Context, userID int64, msg *db.Message, ch *db.Channel) (bool, error) {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if errors.Is(err, ErrInternal) {
		return false, err
	}
	if err != nil {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	// db.DeleteMessage skips the ownership check when isMod, so the flag must be the predicate's own verdict.
	isMod, verdict := permissions.CanDeleteMessage(sub, msg.UserID == userID)
	if verdict != nil {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	return isMod, nil
}

// DeleteMessage validates and soft-deletes a message.
func (s *messageRemoval) DeleteMessage(ctx context.Context, userID, msgID int64) (*DeleteMessageResult, error) {
	return s.deleteMessage(ctx, userID, msgID, nil, "", false)
}

// DeleteMessageForReport is DeleteMessage for the report-linked removal: same authorization, plus report_id
// and the moderator's reason on the ledger row.
func (s *messageRemoval) DeleteMessageForReport(ctx context.Context, userID, msgID, reportID int64, reason string) (*DeleteMessageResult, error) {
	return s.deleteMessage(ctx, userID, msgID, &reportID, reason, false)
}

// deleteMessage is the delete every path shares. onlyIfEmpty adds a precondition checked in the write: the
// message must still have no text and no file, else errNoLongerEmpty and nothing changes.
func (s *messageRemoval) deleteMessage(ctx context.Context, userID, msgID int64, reportID *int64, reason string, onlyIfEmpty bool) (*DeleteMessageResult, error) {
	if err := validateActionReason(reason); err != nil {
		return nil, err
	}
	ratKey := auth.Key("chat_delete", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive integer", ErrBadRequest)
	}

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil {
		return nil, fmt.Errorf("%w: delete message: load: %w", ErrInternal, err)
	}
	if msg == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	// GetMessage returns tombstones, so without this guard a second chat_delete reaches
	// DecrementMentionCounts again and eats a mention raised by a different live message.
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrDeletedMessage)
	}
	// Call and group rows are read-only for everyone, moderators included.
	if msg.Kind != db.MessageKindUser && msg.Kind != db.MessageKindPinAdd && msg.Kind != db.MessageKindMemberJoin {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	// Fail closed, as EditMessage: a lookup failure must not skip the DM-participant or archived checks.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	if chErr != nil {
		return nil, fmt.Errorf("%w: delete message: load channel: %w", ErrInternal, chErr)
	}
	if ch == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	isDM := ch.Type == "dm"

	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}

	isMod, err := s.deleteAuthz(ctx, userID, msg, ch)
	if err != nil {
		return nil, err
	}

	// Flush the queued mention increment before the soft-delete commits so increment and reversal stay
	// symmetric; an unflushed reversal could consume a genuine badge.
	s.mentions.FlushPendingMentionCounts(context.WithoutCancel(ctx), []int64{msgID})

	// The delete and the reversal of its mention badge run under the channel's emit
	// lock, so a reader's read-pointer move cannot land between them.
	_, mcErr, err := s.mentions.removeAndReverseMentions(ctx, msg.ChannelID, func() ([]int64, error) {
		return []int64{msgID}, s.softDeleteRow(ctx, msgID, userID, isMod, msg.UserID, reportID, reason, onlyIfEmpty)
	})
	if err != nil {
		return nil, err
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	// The reversal took this message's mention_count increments back.
	if mcErr != nil {
		slog.Error("MessageService.DeleteMessage DecrementMentionCounts", "err", mcErr, "channel_id", msg.ChannelID, "msg_id", msgID)
	}

	result := &DeleteMessageResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		IsDM:      isDM,
		IsMod:     isMod,
		IsThread:  ch.IsThread(),
	}

	if isDM {
		// Detached: the soft-delete committed, so a dropped deleter must not lose the chat_deleted fan-out.
		participantIDs, pErr := s.dm.DMAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// As in EditMessage: a nil ParticipantIDs would broadcast over the channel topic to an untrusted
			// recipient; fail closed to the deleter only.
			result.ParticipantIDs = []int64{userID}
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}

// softDeleteRow writes the delete: the guarded own-empty variant when onlyIfEmpty,
// else the normal one.
func (s *messageRemoval) softDeleteRow(ctx context.Context, msgID, userID int64, isMod bool, authorID int64, reportID *int64, reason string, onlyIfEmpty bool) error {
	var err error
	switch {
	case !onlyIfEmpty:
		err = s.st.DeleteMessageWithRemoval(ctx, msgID, userID, isMod, authorID, reportID, reason)
	case s.emptyDeleter == nil:
		return errNoLongerEmpty
	default:
		err = s.emptyDeleter.DeleteEmptyOwnMessage(ctx, msgID, userID)
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, db.ErrMessageNotEmpty):
		return errNoLongerEmpty
	case errors.Is(err, db.ErrNotFound):
		// A message that raced to the writer after the msg.Deleted check surfaces as db.ErrNotFound; map it to
		// ErrDeletedMessage so DecrementMentionCounts is not reached for a delete that did not happen.
		return fmt.Errorf("%w: cannot delete this message", ErrDeletedMessage)
	case errors.Is(err, db.ErrForbidden):
		return fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	default:
		// A store failure is not a refusal: logged and answered INTERNAL.
		return fmt.Errorf("%w: delete message: %w", ErrInternal, err)
	}
}

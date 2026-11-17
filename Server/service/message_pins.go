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

type messagePinStore interface {
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	SetMessagePinned(ctx context.Context, p db.SetPinnedParams) (*db.PinEventRow, error)
}

type messagePins struct {
	st      messagePinStore
	perms   *PermissionService
	limiter *auth.RateLimiter
	dm      *dmDelivery
}

// PinEventResult is the pin row a pin wrote, with its author resolved and, for a DM, the
// recipients. Nil when the pin wrote no row: an unpin, a re-pin, or a pin inside the 10 minute window.
type PinEventResult struct {
	Row            *db.PinEventRow
	Author         *db.User
	AuthorRole     string
	ParticipantIDs []int64
	IsDM           bool
}

// SetMessagePinned pins or unpins a message; when the pin writes a row it is returned for fan-out, else nil.
func (s *messagePins) SetMessagePinned(ctx context.Context, userID, channelID, msgID int64, pinned bool) (*PinEventResult, error) {
	if s.limiter != nil && !s.limiter.Allow(auth.Key("chat_pin", userID), 10, time.Second) {
		return nil, ErrRateLimited
	}
	if channelID <= 0 || msgID <= 0 {
		return nil, fmt.Errorf("%w: invalid IDs", ErrBadRequest)
	}
	ch, err := lookupChannel(ctx, s.st, channelID)
	if err != nil {
		return nil, err
	}
	// Archived channels are read-only. This path skips checkSendPermission, so it needs the gate directly.
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}
	if err := s.pinAuthz(ctx, userID, ch); err != nil {
		return nil, err
	}
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil || msg.ChannelID != channelID {
		return nil, fmt.Errorf("%w: message not found in this channel", ErrNotFound)
	}
	if msg.Kind != db.MessageKindUser {
		return nil, fmt.Errorf("%w: cannot pin a system message", ErrBadRequest)
	}
	author, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: pinner lookup: %w", ErrInternal, err)
	}
	if author == nil {
		return nil, fmt.Errorf("%w: pinner not found", ErrInternal)
	}
	row, err := s.st.SetMessagePinned(ctx, db.SetPinnedParams{
		MessageID: msgID, Pinned: pinned, UserID: userID, Username: author.Username,
	})
	if err != nil {
		// The pin SQL excludes soft-deleted rows, so a message deleted after the GetMessage check
		// surfaces here as db.ErrNotFound; map it so the API answers 404, not 500.
		if errors.Is(err, db.ErrNotFound) {
			return nil, fmt.Errorf("%w: message not found in this channel", ErrNotFound)
		}
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if row == nil {
		return nil, nil
	}
	// The pin has committed: resolve the audience on a context detached from the request so a
	// dropped caller does not cost the room the row.
	return s.pinEventResult(context.WithoutCancel(ctx), ch, row, author), nil
}

// pinEventResult resolves the audience of a committed pin row: the author's role name and,
// in a DM, DMAudience (as edit, delete and reactions use), so a pending message request
// reaches only the sender. A failed lookup sends the row to the pinner only.
func (s *messagePins) pinEventResult(ctx context.Context, ch *db.Channel, row *db.PinEventRow, author *db.User) *PinEventResult {
	res := &PinEventResult{Row: row, Author: author}
	if role, err := s.st.GetRoleByID(ctx, author.RoleID); err == nil && role != nil {
		res.AuthorRole = role.Name
	}
	if ch.Type == "dm" {
		res.IsDM = true
		ids, err := s.dm.DMAudience(ctx, ch.ID, author.ID)
		if err != nil {
			slog.Warn("pin row: participant lookup", "err", err, "channel_id", ch.ID)
			// Fail closed to the pinner: an empty list would use the topic broadcast.
			res.ParticipantIDs = []int64{author.ID}
		} else {
			res.ParticipantIDs = ids
		}
	}
	return res
}

// pinAuthz maps permissions.CanPinMessage's verdict onto service errors. A DM
// non-participant or failed participation lookup is an opaque ErrNotFound; a participant's
// failed block lookup stays internal; other DM subject failures are ErrNotFound (fail
// closed). A block or timeout keeps its own kind; every other refusal, or a channel
// subject failure, is ErrForbidden (never 500).
func (s *messagePins) pinAuthz(ctx context.Context, userID int64, ch *db.Channel) error {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if err != nil {
		if ch.Type == "dm" {
			if sub.DMParticipant {
				return err
			}
			return fmt.Errorf("%w: access denied", ErrNotFound)
		}
		return fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}
	verdict := permissions.CanPinMessage(sub)
	switch {
	case verdict == nil:
		return nil
	case ch.Type == "dm" && errors.Is(verdict, permissions.ErrNotDMParticipant):
		return fmt.Errorf("%w: access denied", ErrNotFound)
	case errors.Is(verdict, permissions.ErrBlocked), errors.Is(verdict, permissions.ErrTimedOut):
		return denial(verdict)
	default:
		return fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}
}

package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// requireChannelRead resolves a channel and asserts the user may read its
// CONTENT: DM membership for a DM, READ_MESSAGES and — for a labelled
// channel — the caller's own acknowledgement row otherwise (see
// permissions.CanReadContent). A DM the user is not in is reported as
// ErrNotFound rather than ErrForbidden — its existence is not something an
// outsider gets to learn. Backs GetMessages, GetMessagesAround,
// GetPinnedMessages and GetReactionUsers — every REST read of a channel's
// content shares this one gate.
func (s *MessageService) requireChannelRead(ctx context.Context, userID, channelID int64) error {
	if channelID <= 0 {
		return fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	sub := readSubject(ctx, s.st, s.perms, userID, ch)
	return readContentDenial(permissions.CanReadContent(sub))
}

// GetMessages retrieves paginated messages for a channel with permission checks.
func (s *MessageService) GetMessages(ctx context.Context, userID, channelID, before int64, limit int) ([]db.MessageAPIResponse, bool, error) {
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return nil, false, err
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Fetch one extra to detect has_more.
	msgs, err := s.st.GetMessagesForAPI(ctx, channelID, before, limit+1, userID)
	if err != nil {
		slog.Error("MessageService.GetMessages", "err", err, "channel_id", channelID)
		return nil, false, fmt.Errorf("%w: failed to fetch messages", ErrInternal)
	}

	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}

	return msgs, hasMore, nil
}

// GetMessagesAfter retrieves the page of messages newer than `after`, ordered
// oldest-first, with the same read gate as GetMessages. It is the downward
// continuation of a window the client reached through GetMessagesAround:
// hasMore is false once the page runs into the newest message, which is the
// client's cue to re-attach to the live tail.
func (s *MessageService) GetMessagesAfter(ctx context.Context, userID, channelID, after int64, limit int) ([]db.MessageAPIResponse, bool, error) {
	if after <= 0 {
		return nil, false, fmt.Errorf("%w: after must be positive", ErrBadRequest)
	}
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return nil, false, err
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Fetch one extra to detect has_more.
	msgs, err := s.st.GetMessagesAfterForAPI(ctx, channelID, after, limit+1, userID)
	if err != nil {
		slog.Error("MessageService.GetMessagesAfter", "err", err, "channel_id", channelID)
		return nil, false, fmt.Errorf("%w: failed to fetch messages", ErrInternal)
	}

	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}
	return msgs, hasMore, nil
}

// requireSearchChannelAccess is SearchMessages' single-channel branch gate.
// Inlined rather than routed through requireChannelRead — search has always
// had its own bespoke access checks and error codes (a DM non-participant is
// ErrForbidden here, ErrNotFound there) — but the NSFW check has to be
// repeated too, or search stays the leak path the plan calls out as "would
// ship silently".
func (s *MessageService) requireSearchChannelAccess(ctx context.Context, userID, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	switch {
	case ch.Type == "dm":
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return fmt.Errorf("%w: access denied", ErrForbidden)
		}
	case !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages):
		return fmt.Errorf("%w: access denied", ErrForbidden)
	case ch.NSFW:
		if ok, ackErr := s.st.HasNSFWAcknowledgement(ctx, userID, channelID); ackErr != nil || !ok {
			return fmt.Errorf("%w: %w", ErrForbidden, permissions.ErrNSFWUnacknowledged)
		}
	}
	return nil
}

// MessageWindow is a slice of channel history centred on one message, as
// returned by GetMessagesAround. Messages are ordered oldest-first; the
// HasMore flags report whether the channel holds further history on each side
// of the window.
type MessageWindow struct {
	Messages      []db.MessageAPIResponse `json:"messages"`
	HasMoreBefore bool                    `json:"has_more_before"`
	HasMoreAfter  bool                    `json:"has_more_after"`
}

// GetMessagesAround retrieves the window of `limit` messages centred on
// messageID, ordered oldest-first, with the same read gate as GetMessages.
//
// The centre message must be a live message in this channel: a message from
// another channel, one that never existed, or a soft-deleted one (which
// history omits, so there is no row to centre on) is ErrNotFound.
func (s *MessageService) GetMessagesAround(ctx context.Context, userID, channelID, messageID int64, limit int) (*MessageWindow, error) {
	if messageID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return nil, err
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	msg, err := s.st.GetMessage(ctx, messageID)
	if err != nil {
		slog.Error("MessageService.GetMessagesAround", "err", err, "message_id", messageID)
		return nil, fmt.Errorf("%w: failed to fetch message", ErrInternal)
	}
	if msg == nil || msg.ChannelID != channelID || msg.Deleted {
		return nil, fmt.Errorf("%w: message not found in this channel", ErrNotFound)
	}

	// Half the window sits before the centre, the rest after it; the centre
	// occupies one slot. Ask for one extra on each side so the has-more flags
	// come out of the same query instead of two follow-up counts.
	beforeCount := limit / 2
	afterCount := limit - beforeCount - 1

	msgs, err := s.st.GetMessagesAroundForAPI(ctx, channelID, messageID, beforeCount+1, afterCount+1, userID)
	if err != nil {
		slog.Error("MessageService.GetMessagesAround", "err", err, "channel_id", channelID)
		return nil, fmt.Errorf("%w: failed to fetch messages", ErrInternal)
	}

	centreIdx := slices.IndexFunc(msgs, func(m db.MessageAPIResponse) bool { return m.ID == messageID })
	if centreIdx < 0 {
		// The centre vanished between the lookup and the window query.
		return nil, fmt.Errorf("%w: message not found in this channel", ErrNotFound)
	}

	window := &MessageWindow{Messages: msgs}
	if centreIdx > beforeCount {
		window.HasMoreBefore = true
		window.Messages = window.Messages[centreIdx-beforeCount:]
		centreIdx = beforeCount
	}
	if len(window.Messages)-centreIdx-1 > afterCount {
		window.HasMoreAfter = true
		window.Messages = window.Messages[:centreIdx+afterCount+1]
	}
	return window, nil
}

// GetPinnedMessages retrieves pinned messages for a channel.
func (s *MessageService) GetPinnedMessages(ctx context.Context, userID, channelID int64) ([]db.MessageAPIResponse, error) {
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return nil, err
	}
	msgs, err := s.st.GetPinnedMessages(ctx, channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch pinned messages: %w", ErrInternal, err)
	}
	return msgs, nil
}

// PinEventResult is the pin row a pin wrote, with its author
// resolved and, for a DM, the participants who receive it. It is nil when the
// pin wrote no row: an unpin, a re-pin, or a pin inside the 10 minute window.
type PinEventResult struct {
	Row            *db.PinEventRow
	Author         *db.User
	AuthorRole     string
	ParticipantIDs []int64
	// IsDM is true for a DM or group DM, whose row goes to ParticipantIDs.
	IsDM bool
}

// SetMessagePinned pins or unpins a message. When the pin writes a pin row it
// returns it for the caller to fan out; otherwise the result is nil.
func (s *MessageService) SetMessagePinned(ctx context.Context, userID, channelID, msgID int64, pinned bool) (*PinEventResult, error) {
	if s.limiter != nil && !s.limiter.Allow(auth.Key("chat_pin", userID), 10, time.Second) {
		return nil, ErrRateLimited
	}
	if channelID <= 0 || msgID <= 0 {
		return nil, fmt.Errorf("%w: invalid IDs", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	// Archived channels are read-only. SetMessagePinned bypasses
	// checkSendPermission (it runs its own DM/permission branch below), so it
	// needs the shared gate directly — see requireChannelWritable in
	// message_perms.go.
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}
	if err := s.pinAuthz(ctx, userID, ch); err != nil {
		return nil, err
	}
	// Verify message belongs to this channel.
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
		// The pin SQL excludes soft-deleted rows, so a message deleted between
		// the GetMessage check above and this UPDATE (or one whose Deleted flag
		// we didn't re-check) surfaces here as db.ErrNotFound. Map it to the
		// service taxonomy so writeServiceError answers 404, not a 500 — same
		// class of guard as EditMessage's ErrDeletedMessage and handleReaction's
		// ErrBadRequest on their own deleted-message paths.
		if errors.Is(err, db.ErrNotFound) {
			return nil, fmt.Errorf("%w: message not found in this channel", ErrNotFound)
		}
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if row == nil {
		return nil, nil
	}
	// The pin has committed: resolve the audience on a context detached from the
	// request so a dropped caller does not cost the room the row.
	return s.pinEventResult(context.WithoutCancel(ctx), ch, row, author), nil
}

// pinEventResult resolves the audience of a committed pin row: its author's
// role name and, in a DM, its delivery audience (DMAudience, as edit, delete and
// reactions use, so a DM whose message request is pending reaches only the
// sender and a group DM reaches every member). A failed audience lookup sends
// the row to the pinner only; the row is committed either way.
func (s *MessageService) pinEventResult(ctx context.Context, ch *db.Channel, row *db.PinEventRow, author *db.User) *PinEventResult {
	res := &PinEventResult{Row: row, Author: author}
	if role, err := s.st.GetRoleByID(ctx, author.RoleID); err == nil && role != nil {
		res.AuthorRole = role.Name
	}
	if ch.Type == "dm" {
		res.IsDM = true
		ids, err := s.DMAudience(ctx, ch.ID, author.ID)
		if err != nil {
			slog.Warn("pin row: participant lookup", "err", err, "channel_id", ch.ID)
			// Fail closed to the pinner, as EditMessage and DeleteMessage do: an
			// empty list would make dmEventOrFallback use the topic broadcast.
			res.ParticipantIDs = []int64{author.ID}
		} else {
			res.ParticipantIDs = ids
		}
	}
	return res
}

// pinAuthz decides whether userID may pin or unpin in ch. The rule is
// permissions.CanPinMessage; this only maps its verdict onto the service's
// error kinds, which are unchanged. A DM non-participant or a failed
// participation lookup is an opaque ErrNotFound; a confirmed participant's
// failed block lookup stays an internal error, as before; any other failure
// to resolve a DM subject is ErrNotFound (fail closed). A block or timeout
// keeps its own kind, and every other refusal, or a failure to resolve a
// channel subject, is ErrForbidden (fails closed to 403, never 500).
func (s *MessageService) pinAuthz(ctx context.Context, userID int64, ch *db.Channel) error {
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

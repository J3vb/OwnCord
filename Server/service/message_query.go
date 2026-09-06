package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// requireChannelRead resolves a channel and asserts the user may read its
// CONTENT: DM membership for a DM, READ_MESSAGES and — for a labelled
// channel — the caller's own acknowledgement row otherwise (B5-7,
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

// SearchMessages performs full-text search across accessible channels.
func (s *MessageService) SearchMessages(ctx context.Context, userID int64, query string, channelID *int64, limit int) ([]db.MessageSearchResult, error) {
	if query == "" {
		return nil, fmt.Errorf("%w: query cannot be empty", ErrBadRequest)
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Single-channel search.
	if channelID != nil && *channelID > 0 {
		if err := s.requireSearchChannelAccess(ctx, userID, *channelID); err != nil {
			return nil, err
		}
		results, err := s.st.SearchMessages(ctx, query, channelID, limit)
		if err != nil {
			return nil, fmt.Errorf("%w: search failed: %w", ErrInternal, err)
		}
		return results, nil
	}

	// Global search: build the READABLE channel list (B5-7) — the visible
	// set minus any labelled channel the caller has not acknowledged, so a
	// hit inside one is silently absent from the results rather than
	// returned. This is the leak path the plan calls "would ship silently":
	// a gate on the single-channel branch alone leaves this one wide open.
	accessibleIDs, err := s.ReadableChannelIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(accessibleIDs) == 0 {
		return nil, nil
	}

	results, err := s.st.SearchMessagesInChannels(ctx, query, accessibleIDs, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: search failed: %w", ErrInternal, err)
	}
	return results, nil
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

// SetMessagePinned pins or unpins a message.
func (s *MessageService) SetMessagePinned(ctx context.Context, userID, channelID, msgID int64, pinned bool) error {
	if channelID <= 0 || msgID <= 0 {
		return fmt.Errorf("%w: invalid IDs", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	// Archived channels are read-only. SetMessagePinned bypasses
	// checkSendPermission (it runs its own DM/permission branch below), so it
	// needs the shared gate directly — see requireChannelWritable in
	// message_perms.go.
	if err := requireChannelWritable(ch); err != nil {
		return err
	}
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return fmt.Errorf("%w: access denied", ErrNotFound)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, channelID); blkErr != nil {
			return blkErr
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.ManageMessages) {
		// Require READ_MESSAGES alongside MANAGE_MESSAGES so a role locked out
		// of a private channel cannot mutate its pins — the admin panel's
		// "Can access" toggle denies READ_MESSAGES|CONNECT_VOICE and leaves
		// MANAGE_MESSAGES intact. Mirrors handleReaction and checkSendPermission.
		return fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}
	// Verify message belongs to this channel.
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil || msg.ChannelID != channelID {
		return fmt.Errorf("%w: message not found in this channel", ErrNotFound)
	}
	if err := s.st.SetMessagePinned(ctx, msgID, pinned); err != nil {
		// The pin SQL excludes soft-deleted rows, so a message deleted between
		// the GetMessage check above and this UPDATE (or one whose Deleted flag
		// we didn't re-check) surfaces here as db.ErrNotFound. Map it to the
		// service taxonomy so writeServiceError answers 404, not a 500 — same
		// class of guard as EditMessage's ErrDeletedMessage and handleReaction's
		// ErrBadRequest on their own deleted-message paths.
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: message not found in this channel", ErrNotFound)
		}
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return nil
}

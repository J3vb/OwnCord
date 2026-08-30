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

// requireChannelRead resolves a channel and asserts the user may read it: DM
// membership for a DM, READ_MESSAGES otherwise. A DM the user is not in is
// reported as ErrNotFound rather than ErrForbidden — its existence is not
// something an outsider gets to learn.
func (s *MessageService) requireChannelRead(ctx context.Context, userID, channelID int64) error {
	if channelID <= 0 {
		return fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, channelID)
		if dmErr != nil || !ok {
			return fmt.Errorf("%w: access denied", ErrNotFound)
		}
		return nil
	}
	if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return fmt.Errorf("%w: access denied", ErrForbidden)
	}
	return nil
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
		ch, err := s.st.GetChannel(ctx, *channelID)
		if err != nil || ch == nil {
			return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
		}
		if ch.Type == "dm" {
			ok, err := s.st.IsDMParticipant(ctx, userID, *channelID)
			if err != nil || !ok {
				return nil, fmt.Errorf("%w: access denied", ErrForbidden)
			}
		} else if !s.perms.HasChannelPerm(ctx, userID, *channelID, permissions.ReadMessages) {
			return nil, fmt.Errorf("%w: access denied", ErrForbidden)
		}
		results, err := s.st.SearchMessages(ctx, query, channelID, limit)
		if err != nil {
			return nil, fmt.Errorf("%w: search failed: %w", ErrInternal, err)
		}
		return results, nil
	}

	// Global search: build accessible channel list.
	accessibleIDs, err := s.GetAccessibleChannelIDs(ctx, userID)
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

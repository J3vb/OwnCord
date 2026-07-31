package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// GetMessages retrieves paginated messages for a channel with permission checks.
func (s *MessageService) GetMessages(ctx context.Context, userID, channelID, before int64, limit int) ([]db.MessageAPIResponse, bool, error) {
	if channelID <= 0 {
		return nil, false, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, false, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	// Permission check.
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return nil, false, fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return nil, false, fmt.Errorf("%w: access denied", ErrForbidden)
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
			return nil, fmt.Errorf("%w: search failed: %v", ErrInternal, err)
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
		return nil, fmt.Errorf("%w: search failed: %v", ErrInternal, err)
	}
	return results, nil
}

// GetPinnedMessages retrieves pinned messages for a channel.
func (s *MessageService) GetPinnedMessages(ctx context.Context, userID, channelID int64) ([]db.MessageAPIResponse, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return nil, fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	msgs, err := s.st.GetPinnedMessages(ctx, channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch pinned messages: %v", ErrInternal, err)
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
	return s.st.SetMessagePinned(ctx, msgID, pinned)
}

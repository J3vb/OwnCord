package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/owncord/server/permissions"
)

// validPresenceStatuses is the set of accepted status values for presence_update.
var validPresenceStatuses = map[string]bool{
	"online": true, "idle": true, "dnd": true, "offline": true,
}

// registerPresenceHandlers registers presence, typing, and channel focus handlers.
// All three are V2 handlers.
func registerPresenceHandlers(r *HandlerRegistry, deps PresenceDeps) {
	r.RegisterV2(MsgTypeTypingStart, handleTypingV2, deps)
	r.RegisterV2(MsgTypePresenceUpdate, handlePresenceV2, deps)
	r.RegisterV2(MsgTypeChannelFocus, handleChannelFocusV2, deps)
}

// handleTypingV2 is the V2 handler for typing_start messages.
// It validates the channel, checks permissions, and returns events to broadcast
// the typing indicator to channel members (excluding the sender).
func handleTypingV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	typingCmd := cmd.(TypingStartCmd)
	channelID := typingCmd.ChannelID()
	userID := info.UserID

	// Rate limit.
	ratKey := fmt.Sprintf("typing:%d:%d", userID, channelID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, typingRateLimit, typingWindow) {
		return Result{} // silently drop; no error for typing throttle
	}

	// Channel lookup.
	ch, err := d.DB.GetChannel(channelID)
	if err != nil || ch == nil {
		return Result{} // silently drop for unknown channels
	}

	// Permission check.
	if ch.Type == "dm" {
		ok, dmErr := d.DB.IsDMParticipant(userID, channelID)
		if dmErr != nil || !ok {
			return Result{} // silently drop — not a DM participant
		}
	} else {
		if !hasPerm(d.DB, d.Permissions, userID, channelID, permissions.ReadMessages) {
			return Result{} // silently drop — no read permission
		}
	}

	payload := buildTypingMsg(channelID, userID, info.Username)

	if ch.Type == "dm" {
		// For DM channels, get participant IDs and send to each excluding sender.
		participantIDs, pErr := d.DB.GetDMParticipantIDs(channelID)
		if pErr != nil {
			return Result{} // silently drop on error
		}
		// Build one TypingDMEvent per other participant (UserTargetedEvent routing).
		var events []Event
		for _, pid := range participantIDs {
			if pid == userID {
				continue
			}
			events = append(events, TypingDMEvent{
				targetUserID: pid,
				payload:      payload,
			})
		}
		return Result{Events: events}
	}

	// Regular channel: ExcludeSenderEvent routing.
	return Result{
		Events: []Event{
			TypingChannelEvent{
				channelID:     channelID,
				excludeUserID: userID,
				payload:       payload,
			},
		},
	}
}

// handlePresenceV2 is the V2 handler for presence_update messages.
// It validates the status, updates the DB, and broadcasts to all clients.
func handlePresenceV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	presenceCmd := cmd.(PresenceUpdateCmd)
	userID := info.UserID

	// Rate limit.
	ratKey := fmt.Sprintf("presence:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, presenceRateLimit, presenceWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many presence updates"}}
	}

	// Validate status.
	status := presenceCmd.Status()
	if !validPresenceStatuses[status] {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "status must be online|idle|dnd|offline"}}
	}

	// Update DB.
	if err := d.DB.UpdateUserStatus(userID, status); err != nil {
		slog.Error("ws handlePresenceV2 UpdateUserStatus", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update status"}}
	}

	// Broadcast to all connected clients.
	return Result{
		Events: []Event{
			PresenceEvent{payload: buildPresenceMsg(userID, status)},
		},
	}
}

// handleChannelFocusV2 is the V2 handler for channel_focus messages.
// It validates permissions, signals the client's focused channel via SetChannelID,
// and marks the channel as read.
func handleChannelFocusV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	focusCmd := cmd.(ChannelFocusCmd)
	chID := focusCmd.ChannelID()
	userID := info.UserID

	if chID <= 0 {
		return Result{} // silently drop invalid channel_id
	}

	// Channel lookup.
	ch, chErr := d.DB.GetChannel(chID)
	if chErr != nil || ch == nil {
		return Result{} // silently drop — channel not found
	}

	// Permission check.
	if ch.Type == "dm" {
		ok, dmErr := d.DB.IsDMParticipant(userID, chID)
		if dmErr != nil || !ok {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "not a participant in this DM"}}
		}
	} else {
		if denied := requirePerm(d.DB, d.Permissions, userID, chID, permissions.ReadMessages, "READ_MESSAGES"); denied != nil {
			return *denied
		}
	}

	slog.Debug("channel_focus", "user_id", userID, "channel_id", chID)

	// Mark channel as read by updating read_states to the latest message.
	latestID, latestErr := d.DB.GetLatestMessageID(chID)
	if latestErr == nil && latestID > 0 {
		if rsErr := d.DB.UpdateReadState(userID, chID, latestID); rsErr != nil {
			slog.Warn("handleChannelFocusV2 UpdateReadState", "err", rsErr, "user_id", userID, "channel_id", chID)
		}
	}

	return Result{SetChannelID: &chID}
}

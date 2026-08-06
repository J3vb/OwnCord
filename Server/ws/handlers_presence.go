package ws

import (
	"context"
	"errors"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/service"
)

// channel_focus / mark_read share one budget: both run the identical
// HandleChannelFocus service call, whose UpdateReadState is a SQLite write
// against the single writer connection.
const (
	focusRateLimit  = 5
	focusRateWindow = time.Second
)

// registerPresenceHandlers registers presence, typing, and channel focus handlers.
// All three are V2 handlers.
func registerPresenceHandlers(r *HandlerRegistry, deps PresenceDeps) {
	r.RegisterV2(MsgTypeTypingStart, handleTypingV2, deps)
	r.RegisterV2(MsgTypePresenceUpdate, handlePresenceV2, deps)
	r.RegisterV2(MsgTypeChannelFocus, handleChannelFocusV2, deps)
	r.RegisterV2(MsgTypeMarkRead, handleMarkReadV2, deps)
}

// handleTypingV2 is the V2 handler for typing_start messages.
// It validates the channel, checks permissions, and returns events to broadcast
// the typing indicator to channel members (excluding the sender).
func handleTypingV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	typingCmd := cmd.(TypingStartCmd)
	channelID := typingCmd.ChannelID()
	userID := info.UserID

	ch, err := d.ChannelSvc.HandleTyping(ctx, userID, channelID, d.Limiter)
	if err != nil || ch == nil {
		return Result{} // silently drop
	}

	payload := buildTypingMsg(channelID, userID, info.Username)

	if ch.Type == "dm" {
		participantIDs, pErr := d.ChannelSvc.GetDMParticipantIDs(ctx, channelID)
		if pErr != nil {
			return Result{}
		}
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
func handlePresenceV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	presenceCmd := cmd.(PresenceUpdateCmd)
	userID := info.UserID
	status := presenceCmd.Status()

	customStatus, err := d.ChannelSvc.HandlePresenceUpdate(ctx, userID, status, presenceCmd.CustomStatus(), d.Limiter)
	if err != nil {
		return serviceErrorToResult(err)
	}

	return Result{Events: presenceEvents(userID, status, customStatus)}
}

// handleChannelFocusV2 is the V2 handler for channel_focus messages.
// It validates permissions, signals the client's focused channel via SetChannelID,
// and marks the channel as read.
func handleChannelFocusV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	focusCmd := cmd.(ChannelFocusCmd)
	chID := focusCmd.ChannelID()

	// Every frame drives an unmetered SQLite write (UpdateReadState) plus
	// perm checks and pubsub churn; mark_read shares the budget because it
	// runs the identical service call. Silently dropping matches the
	// handlers' existing error posture.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("focus", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{}
	}

	_, err := d.ChannelSvc.HandleChannelFocus(ctx, info.UserID, chID)
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
		}
		return Result{} // silently drop other errors
	}

	return Result{SetChannelID: &chID}
}

// handleMarkReadV2 is the V2 handler for mark_read messages. It runs the same
// access check and read-state advance as channel_focus but deliberately leaves
// SetChannelID unset: marking a channel read from its context menu must not
// move the connection's focus off the channel the user is actually looking at
// (which would misroute typing/read bookkeeping for the visible channel).
func handleMarkReadV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	markCmd := cmd.(MarkReadCmd)

	// Shared budget with channel_focus — same underlying SQLite write.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("focus", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{}
	}

	_, err := d.ChannelSvc.HandleChannelFocus(ctx, info.UserID, markCmd.ChannelID())
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
		}
		return Result{} // silently drop other errors
	}
	return Result{}
}

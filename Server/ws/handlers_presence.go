package ws

import (
	"context"
	"errors"

	"github.com/owncord/server/service"
)

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

	ch, err := d.ChannelSvc.HandleTyping(userID, channelID, d.Limiter)
	if err != nil || ch == nil {
		return Result{} // silently drop
	}

	payload := buildTypingMsg(channelID, userID, info.Username)

	if ch.Type == "dm" {
		participantIDs, pErr := d.ChannelSvc.GetDMParticipantIDs(channelID)
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
func handlePresenceV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	presenceCmd := cmd.(PresenceUpdateCmd)
	userID := info.UserID
	status := presenceCmd.Status()

	if err := d.ChannelSvc.HandlePresenceUpdate(userID, status, d.Limiter); err != nil {
		return serviceErrorToResult(err)
	}

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

	_, err := d.ChannelSvc.HandleChannelFocus(info.UserID, chID)
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
		}
		return Result{} // silently drop other errors
	}

	return Result{SetChannelID: &chID}
}

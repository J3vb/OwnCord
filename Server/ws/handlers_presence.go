package ws

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// channel_focus and mark_read each get their own 5/s budget under this same
// limit/window even though both run the identical HandleChannelFocus service
// call. They used to share one auth.Key("focus", ...) budget, which let a
// "Mark All as Read" burst (one mark_read per badged channel) exhaust the
// window and starve the next legitimate channel_focus — leaving the
// connection subscribed to the previous channel's pub/sub topic with no
// error surfaced to the client. A channel_focus that does exceed its own
// budget is deferred, not dropped: the latest one is applied once the window
// frees (see focus_defer.go).
const (
	focusRateLimit  = 5
	focusRateWindow = time.Second
)

// registerPresenceHandlers registers presence, typing, and channel focus handlers.
// All are V2 handlers.
func registerPresenceHandlers(r *HandlerRegistry, deps PresenceDeps) {
	r.RegisterV2(MsgTypeTypingStart, handleTypingV2, deps)
	r.RegisterV2(MsgTypePresenceUpdate, handlePresenceV2, deps)
	r.RegisterV2(MsgTypeActivityUpdate, handleActivityUpdateV2, deps)
	r.RegisterV2(MsgTypeListeningUpdate, handleListeningUpdateV2, deps)
	r.RegisterV2(MsgTypeChannelFocus, handleChannelFocusV2, deps)
	r.RegisterV2(MsgTypeMarkRead, handleMarkReadV2, deps)
	r.RegisterV2(MsgTypeMarkUnread, handleMarkUnreadV2, deps)
}

// handleTypingV2 is the V2 handler for typing_start messages.
// It validates the channel, checks permissions, and returns events to broadcast
// the typing indicator to channel members (excluding the sender).
func handleTypingV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	typingCmd := cmd.(TypingStartCmd)
	channelID := typingCmd.ChannelID
	userID := info.UserID

	ch, err := d.ChannelSvc.HandleTyping(ctx, userID, channelID, d.Limiter)
	if err != nil || ch == nil {
		return Result{} // silently drop
	}

	payload := buildTypingMsg(channelID, userID, info.Username)

	if ch.Type == "dm" {
		// the same message-request-aware audience every other DM frame
		// path uses (MessageService.DMAudience), so an untrusted recipient of
		// a held first message hears no typing indicator either. Falls back
		// to the unfiltered participant list when MessageSvc was not wired
		// (a test built without it), matching DMAudience's own
		// nil-messageRequests posture.
		var (
			participantIDs []int64
			pErr           error
		)
		if d.MessageSvc != nil {
			participantIDs, pErr = d.MessageSvc.DMAudience(ctx, channelID, userID)
		} else {
			participantIDs, pErr = d.ChannelSvc.GetDMParticipantIDs(ctx, channelID)
		}
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
	status := presenceCmd.Status

	res, err := d.ChannelSvc.HandlePresenceUpdate(ctx, userID, status, presenceCmd.CustomStatus, presenceCmd.ExpiresIn, d.Limiter)
	if err != nil {
		return serviceErrorToResult(err)
	}

	// The text may predate its own clear (a bare flip reads the stored row),
	// so it is published only while its expiry has not passed. The live
	// presence is stored before the events are emitted (handleMessageApply),
	// so CustomStatusExpired either finds this tag and clears it, or finds a
	// newer one and leaves it.
	customStatus := visibleCustomStatus(res.CustomStatus, res.ExpiresAt, time.Now())
	live := &livePresence{status: status, customStatus: customStatus}
	if customStatus != nil {
		live.customStatusExpiresAt = res.ExpiresAt
	}
	// The game and the song follow the connection, not the status: the frame
	// carries them.
	return Result{Events: presenceEvents(userID, status, customStatus, info.Activity, info.Listening), SetPresence: live}
}

// handleChannelFocusV2 is the V2 handler for channel_focus messages.
// It validates permissions, signals the client's focused channel via SetChannelID,
// and, unless the frame said read:false, marks the channel as read. A read:false
// focus admits and subscribes only: it writes no read state and tells the
// activity coalescer nothing.
func handleChannelFocusV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	focusCmd := cmd.(ChannelFocusCmd)
	chID := focusCmd.ChannelID

	// Every frame drives an unmetered SQLite write (UpdateReadState) plus
	// perm checks and pubsub churn, so focus is metered on its own key —
	// mark_read runs the identical service call but must not be able to
	// spend this budget (see handleMarkReadV2). A refused frame is deferred
	// rather than dropped: dropping it would leave a fast channel switcher on
	// a channel the server never subscribed them to, so the applier remembers
	// the latest refused channel, and whether it marks read, and applies it
	// once the window frees.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("focus", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{DeferChannelFocus: &chID, DeferChannelFocusNoRead: focusCmd.NoRead}
	}

	var err error
	if focusCmd.NoRead {
		_, err = d.ChannelSvc.AdmitChannelFocus(ctx, info.UserID, chID)
	} else {
		_, err = d.ChannelSvc.HandleChannelFocus(ctx, info.UserID, chID)
	}
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
		}
		return dropUnlessDeadline(ctx, err) // silently drop other errors
	}

	if focusCmd.NoRead {
		return Result{SetChannelID: &chID}
	}
	return Result{SetChannelID: &chID, Events: []Event{channelReadEvt(info.UserID, chID, readThroughNoted)}}
}

// markReadNoMessageSvcWarn limits the no-MessageSvc notice to one line.
var markReadNoMessageSvcWarn sync.Once

// handleMarkReadV2 is the V2 handler for mark_read messages. It runs the same
// access check as channel_focus and moves the read pointer, but deliberately
// leaves SetChannelID unset: marking a channel read from its context menu must
// not move the connection's focus off the channel the user is actually looking
// at (which would misroute typing/read bookkeeping for the visible channel).
// Without message_id it reads up to the channel's latest message; with one it
// moves the pointer forward only. Either way the caller gets a read_state
// frame (sent by MoveReadPointer under the mention lock), and the coalescer is
// told the pointer the database returned.
func handleMarkReadV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	markCmd := cmd.(MarkReadCmd)

	// Own budget, separate from channel_focus: a "Mark All as Read" burst
	// (one mark_read per badged channel) must not starve a legitimate
	// channel_focus that shares the same 5/s window — that silently leaves
	// the connection subscribed to the old channel's pub/sub topic.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("markread", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{}
	}

	if d.MessageSvc == nil {
		// No message service wired. Production always wires one; some test
		// fixtures build PresenceDeps without it, so keep the pre-pointer
		// path and say so once.
		markReadNoMessageSvcWarn.Do(func() {
			slog.Info("mark_read: PresenceDeps has no MessageSvc, using the pre-pointer path (no read_state frame)")
		})
		_, err := d.ChannelSvc.HandleChannelFocus(ctx, info.UserID, markCmd.ChannelID)
		if err != nil {
			if errors.Is(err, service.ErrForbidden) {
				return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
			}
			return dropUnlessDeadline(ctx, err) // silently drop other errors
		}
		return Result{Events: []Event{channelReadEvt(info.UserID, markCmd.ChannelID, readThroughNoted)}}
	}

	op := service.ReadAtLatest
	if markCmd.MessageID > 0 {
		op = service.ReadUpTo
	}
	rs, err := d.MessageSvc.MoveReadPointer(ctx, info.UserID, markCmd.ChannelID, op, markCmd.MessageID)
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
		}
		return dropUnlessDeadline(ctx, err) // silently drop other errors
	}
	return Result{Events: []Event{channelReadEvt(info.UserID, markCmd.ChannelID, rs.LastReadMessageID)}}
}

// dropUnlessDeadline is the result of a read-state command that ignores its
// failure: an empty Result, except when the frame deadline ctx cut the work
// short, which is carried as the error so the client is told REQUEST_TIMEOUT
// rather than left to believe the read pointer moved.
func dropUnlessDeadline(ctx context.Context, err error) Result {
	if commandDeadlineExceeded(ctx, err) {
		return Result{Error: err}
	}
	return Result{}
}

// handleMarkUnreadV2 is the V2 handler for mark_unread messages: it moves the
// caller's read pointer to just before message_id. Unlike mark_read it answers
// every refusal, because an explicit click must not silently do nothing: over
// its own 5/s budget it is RATE_LIMITED, a message that is not a live message
// of the channel is NOT_FOUND, lost access is FORBIDDEN. On success the caller
// gets a read_state frame and the coalescer's mark drops to the new pointer.
func handleMarkUnreadV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	unreadCmd := cmd.(MarkUnreadCmd)

	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("markunread", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many requests"}}
	}
	if d.MessageSvc == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "internal error"}}
	}

	rs, err := d.MessageSvc.MoveReadPointer(ctx, info.UserID, unreadCmd.ChannelID, service.MarkUnread, unreadCmd.MessageID)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrForbidden):
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "access denied"}}
		case errors.Is(err, service.ErrNotFound):
			return Result{Error: ClientError{Code: ErrCodeNotFound, Message: "message not found"}}
		case errors.Is(err, service.ErrBadRequest):
			return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "invalid request"}}
		default:
			return serviceErrorToResult(err)
		}
	}
	return Result{Events: []Event{channelReadEvt(info.UserID, unreadCmd.ChannelID, rs.LastReadMessageID)}}
}

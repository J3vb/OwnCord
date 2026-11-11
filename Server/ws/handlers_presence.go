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

// channel_focus and mark_read each get their own 5/s budget: a shared one let a
// "Mark All as Read" burst starve the next channel_focus, leaving the connection
// on the previous channel's topic with no error. A channel_focus over budget is
// deferred, not dropped (focus_defer.go).
const (
	focusRateLimit  = 5
	focusRateWindow = time.Second
)

func registerPresenceHandlers(r *HandlerRegistry, deps PresenceDeps) {
	r.RegisterV2(MsgTypeTypingStart, handleTypingV2, deps)
	r.RegisterV2(MsgTypePresenceUpdate, handlePresenceV2, deps)
	r.RegisterV2(MsgTypeActivityUpdate, handleActivityUpdateV2, deps)
	r.RegisterV2(MsgTypeListeningUpdate, handleListeningUpdateV2, deps)
	r.RegisterV2(MsgTypeChannelFocus, handleChannelFocusV2, deps)
	r.RegisterV2(MsgTypeMarkRead, handleMarkReadV2, deps)
	r.RegisterV2(MsgTypeMarkUnread, handleMarkUnreadV2, deps)
}

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
		// The same message-request-aware audience as every DM frame path
		// (MessageService.DMAudience), so an untrusted recipient of a held first
		// message sees no typing either; the unfiltered list when MessageSvc is
		// unwired (test fixture).
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

func handlePresenceV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	presenceCmd := cmd.(PresenceUpdateCmd)
	userID := info.UserID
	status := presenceCmd.Status

	res, err := d.ChannelSvc.HandlePresenceUpdate(ctx, userID, status, presenceCmd.CustomStatus, presenceCmd.ExpiresIn, d.Limiter)
	if err != nil {
		return serviceErrorToResult(err)
	}

	// The text may predate its own clear (a bare flip reads the stored row), so
	// publish it only before its expiry. The live presence is stored before
	// events are emitted, so CustomStatusExpired either finds this tag and clears
	// it or finds a newer one.
	customStatus := visibleCustomStatus(res.CustomStatus, res.ExpiresAt, time.Now())
	live := &livePresence{status: status, customStatus: customStatus}
	if customStatus != nil {
		live.customStatusExpiresAt = res.ExpiresAt
	}
	// The game and song follow the connection, not the status.
	return Result{Events: presenceEvents(userID, status, customStatus, info.Activity, info.Listening, false), SetPresence: live}
}

// handleChannelFocusV2 validates permissions, sets SetChannelID and, unless
// read:false, marks the channel read. read:false admits and subscribes only: no
// read state, nothing for the coalescer.
func handleChannelFocusV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	focusCmd := cmd.(ChannelFocusCmd)
	chID := focusCmd.ChannelID

	// Every frame drives an unmetered SQLite write plus permission checks and
	// pubsub churn, so focus is metered on its own key. A refused frame is
	// deferred, not dropped (a fast switcher would stay on a channel never
	// subscribed): the applier keeps the latest refused channel and applies it
	// when the window frees.
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

var markReadNoMessageSvcWarn sync.Once

// handleMarkReadV2 runs channel_focus's access check, then moves the read
// pointer, leaving SetChannelID unset so a context-menu mark does not move the
// connection's focus. Without message_id it reads to the latest; with one it
// moves forward only. MoveReadPointer sends read_state under the mention lock;
// the coalescer gets the database's pointer.
func handleMarkReadV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PresenceDeps)
	markCmd := cmd.(MarkReadCmd)

	// Own budget, separate from channel_focus, so a "Mark All as Read" burst
	// cannot starve it.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("markread", info.UserID), focusRateLimit, focusRateWindow) {
		return Result{}
	}

	if d.MessageSvc == nil {
		// No message service: production always wires one, but some test fixtures
		// do not, so keep the pre-pointer path and warn once.
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
// failure: empty, except when the frame deadline cut the work short, which
// becomes REQUEST_TIMEOUT so the client does not think the pointer moved.
func dropUnlessDeadline(ctx context.Context, err error) Result {
	if commandDeadlineExceeded(ctx, err) {
		return Result{Error: err}
	}
	return Result{}
}

// handleMarkUnreadV2 moves the read pointer to just before message_id. Unlike
// mark_read it answers every refusal (an explicit click must not silently do
// nothing): RATE_LIMITED, NOT_FOUND for a message not live in the channel,
// FORBIDDEN for lost access.
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

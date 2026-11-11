package ws

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

// wsCommandDeadline bounds the database work behind one inbound frame. It sits
// under the 25 s ping interval so one stalled command cannot starve the pong. An
// atomic package var so tests can shrink it without racing readers.
var wsCommandDeadline atomic.Int64

func init() { wsCommandDeadline.Store(int64(10 * time.Second)) }

func commandDeadline() time.Duration { return time.Duration(wsCommandDeadline.Load()) }

// commandDeadlineExempt lists message types whose handlers dispatch on the
// connection context, not the per-frame deadline;
// TestCommandDeadline_EveryTypeClassified fails when a type is in neither set.
// voice_mod_* pair a database write with a LiveKit call under the voice-
// moderation lock, so cutting the write short would split the pair; chat_command
// runs a plugin with its own time budget.
var commandDeadlineExempt = map[string]struct{}{
	MsgTypeVoiceModMute:   {},
	MsgTypeVoiceModDeafen: {},
	MsgTypeVoiceModMove:   {},
	MsgTypeVoiceModKick:   {},
	MsgTypeChatCommand:    {},
}

func isCommandDeadlineExempt(msgType string) bool {
	_, ok := commandDeadlineExempt[msgType]
	return ok
}

// commandDeadlineExceeded reports whether the per-frame deadline fctx cut a
// failed command short. It tests the context, not the error, because services
// wrap driver errors with %v and errors.Is would miss. A handler that succeeded
// after the deadline is never passed here.
func commandDeadlineExceeded(fctx context.Context, resultErr error) bool {
	return resultErr != nil && errors.Is(fctx.Err(), context.DeadlineExceeded)
}

// errDeadlineSpent stands in for a handler error when only the frame's own expiry
// is asked about.
var errDeadlineSpent = errors.New("frame deadline spent before dispatch")

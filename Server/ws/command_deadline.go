package ws

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

// wsCommandDeadline bounds the database work behind one inbound frame. It
// sits under the 25 s ping interval so a single stalled command
// cannot by itself starve the pong. A package var, not a config key, so tests
// can shrink it (an atomic, so a parallel test cannot race the readers);
// nobody has measured a better value yet.
var wsCommandDeadline atomic.Int64

func init() { wsCommandDeadline.Store(int64(10 * time.Second)) }

// commandDeadline returns the current per-frame deadline.
func commandDeadline() time.Duration { return time.Duration(wsCommandDeadline.Load()) }

// commandDeadlineExempt lists the message types whose handlers dispatch on the
// connection context instead of the per-frame deadline. Every other registered
// type is deadline-bound; TestCommandDeadline_EveryTypeClassified fails when a
// type is added to neither side or an entry here goes stale.
//
//   - voice_mod_mute / voice_mod_deafen / voice_mod_move / voice_mod_kick pair a
//     database write with a LiveKit call under the voice-moderation lock inside
//     the handler, so cutting the write short would split the pair.
//   - chat_command runs a plugin with its own guest time budget.
var commandDeadlineExempt = map[string]struct{}{
	MsgTypeVoiceModMute:   {},
	MsgTypeVoiceModDeafen: {},
	MsgTypeVoiceModMove:   {},
	MsgTypeVoiceModKick:   {},
	MsgTypeChatCommand:    {},
}

// isCommandDeadlineExempt reports whether msgType dispatches without the
// per-frame deadline.
func isCommandDeadlineExempt(msgType string) bool {
	_, ok := commandDeadlineExempt[msgType]
	return ok
}

// commandDeadlineExceeded reports whether a failed command was cut short by
// the per-frame deadline fctx. It tests the context, not the handler's error:
// services wrap driver errors with %v, so errors.Is on the result would miss.
// A handler that returned success after the deadline is never passed here and
// is applied normally.
func commandDeadlineExceeded(fctx context.Context, resultErr error) bool {
	return resultErr != nil && errors.Is(fctx.Err(), context.DeadlineExceeded)
}

// errDeadlineSpent stands in for a handler error when only the frame's own
// expiry is being asked about, before any handler has run.
var errDeadlineSpent = errors.New("frame deadline spent before dispatch")

package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// EmitEvents routes typed events to the broadcast methods. Called from readPump
// goroutines after a V2 handler returns; ctx carries the dispatching connection's
// cancellation for routes that hit the database.
//
// Routing is chosen by the event's deliveryClass, never by which accessor
// interfaces it satisfies: a DM event is also a ChannelEvent and a presence event
// also a BroadcastAllEvent. An event with an unknown class or a failed assertion
// is logged and dropped, never broadcast. EmitEvents emits on the server's behalf;
// emitEventsFrom names the requesting user so their channel frames are rate limited
// per sender (allowTopicFrame).
func (h *Hub) EmitEvents(ctx context.Context, events []Event) {
	h.emitEventsFrom(ctx, 0, events)
}

func (h *Hub) emitEventsFrom(ctx context.Context, senderID int64, events []Event) {
	for _, ev := range events {
		if !h.emitOne(ctx, senderID, ev) {
			slog.Error("EmitEvents: unroutable event dropped",
				"type", fmt.Sprintf("%T", ev), "class", int(ev.deliveryClass()))
		}
	}
}

// emitOne delivers ev on the route its deliveryClass names and reports whether it
// did. False means an unknown class or ev lacks the class's accessor; nothing was sent.
func (h *Hub) emitOne(ctx context.Context, senderID int64, ev Event) bool {
	switch ev.deliveryClass() {
	case classSequencedDM:
		return h.emitSequencedDM(ctx, senderID, ev)
	case classVoiceChannelGuarded:
		return h.emitVoiceChannelGuarded(ctx, senderID, ev)
	case classVoiceChannel:
		return h.emitVoiceChannel(ctx, senderID, ev)
	case classExcludeSender:
		return h.emitExcludeSender(ctx, senderID, ev)
	case classPresenceOthers:
		return h.emitPresenceOthers(ctx, senderID, ev)
	case classPresenceSelf:
		return h.emitPresenceSelf(ctx, senderID, ev)
	case classTypingDM:
		return h.emitTypingDM(ctx, senderID, ev)
	case classCallSignal:
		return h.emitCallSignal(ctx, senderID, ev)
	case classUserTargeted:
		return h.emitUserTargeted(ctx, senderID, ev)
	case classActivity:
		return h.emitActivity(ctx, senderID, ev)
	case classChannel:
		return h.emitChannel(ctx, senderID, ev)
	case classVoiceVisibility:
		return h.emitVoiceVisibility(ctx, senderID, ev)
	case classPresence:
		return h.emitPresence(ctx, senderID, ev)
	case classBroadcastAll:
		return h.emitBroadcastAll(ctx, senderID, ev)
	case classThreadNote:
		return h.emitThreadNote(ctx, senderID, ev)
	case classInvalid:
		return false
	default:
		return false
	}
}

func (h *Hub) emitSequencedDM(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(SequencedDMEvent)
	if !ok {
		return false
	}
	// Normal priority: sequenced frames must share the per-client FIFO so the max-seq
	// ack watermark never passes an undelivered event.
	h.sendSequencedToUsers(e.ChannelID(), e.ParticipantIDs(), e.Payload())
	return true
}

func (h *Hub) emitVoiceChannelGuarded(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(VoiceChannelGuardedEvent)
	if !ok {
		return false
	}
	h.sendToUserIfInVoiceChannel(e.VoiceChannelID(), e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitVoiceChannel(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(VoiceChannelEvent)
	if !ok {
		return false
	}
	h.sendToVoiceChannelExcept(e.VoiceChannelID(), e.ExcludeUserID(), e.Payload())
	return true
}

func (h *Hub) emitExcludeSender(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(ExcludeSenderEvent)
	if !ok {
		return false
	}
	// Low priority: typing indicators are ephemeral.
	h.broadcastExcludeLow(e.ChannelID(), e.ExcludeUserID(), e.Payload())
	return true
}

func (h *Hub) emitPresenceOthers(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceOthersEvent)
	if !ok {
		return false
	}
	// An invisible user's public presence half: like the visible case it must invalidate
	// any queued coalescer entry so a stale connect-time presence cannot flush after
	// and overwrite this fresher status. The drop and broadcast run atomically under
	// presenceMu (dropQueuedPresenceAndBroadcast) so a racing flush cannot enqueue its
	// stale frame after this one.
	h.dropQueuedPresenceAndBroadcast(e.excludeUserID, func() {
		// Normal priority, excluding the owner, NOT broadcastExcludeLow. Every other source
		// of this user's presence (the connect/disconnect batch and the visible
		// presence_update path) shares the normal queue; the low queue would split one
		// user's presence across two per-client FIFOs with different durability (low
		// silently drops on overflow, never replayed) and drain order (normal strictly
		// before low).
		h.broadcastPresenceFrame(e.excludeUserID, e.Payload())
	})
	return true
}

func (h *Hub) emitPresenceSelf(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceSelfEvent)
	if !ok {
		return false
	}
	// Normal priority, NOT the high-priority class of other targeted events. Every other
	// source of this user's own presence (the visible presence_update path and the
	// batch's private copy) shares the normal queue in the presence class (a full queue
	// drops the frame and marks the client stale; Client.sendPresenceMsg). SendToUserHigh
	// would split it across two FIFOs: writePump drains high strictly before normal, so
	// a newer invisible self-frame on high could land before an older visible-status
	// frame on normal, leaving the owner's client on a stale status. presenceMu orders
	// the payload choice against a game activity sweep, as in emitPresence.
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	payload := h.presencePayloadLocked(e.TargetUserID(), e.Payload(), e.bare)
	for _, c := range h.clientsOf(e.TargetUserID()) {
		c.sendPresenceMsg(payload)
	}
	return true
}

func (h *Hub) emitTypingDM(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// Low priority, NOT the high-priority targeted class. DM typing is the
	// direct-delivery counterpart of TypingChannelEvent: ephemeral and droppable.
	// SendToUserHigh would give it the strictest durability in a DM (overflow
	// disconnects the client) versus the most droppable in a channel, so a busy typer
	// could disconnect a backpressured recipient over a cosmetic frame.
	h.SendToUserLow(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitCallSignal(ctx context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// Normal priority, NOT the high-priority class. A ring or decline is ordered against
	// the caller's voice_leave / voice_state, which ride the normal queue via the async
	// hub dispatch. writePump drains high before normal, so on the high queue a fresh
	// call_incoming overtook an older voice_leave and the callee applied that stale
	// leave to the new ring, cancelling it (a false "Missed call"). awaitDispatch first
	// so earlier voice events have reached the normal queue ahead of the signal. Best
	// effort: a cancelled ctx sends without the barrier.
	_ = h.awaitDispatch(ctx)
	h.SendToUser(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitUserTargeted(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// High priority: targeted events (DM opens, mentions). dm_channel_open is
	// unsequenced and targeted, so replay can never deliver it and an addressee
	// mid-reconnect would be left with an unreachable DM channel. Bump the visibility
	// watermark so a client resuming at or before the open takes the full-ready path
	// (which includes DM channels).
	if _, isOpen := ev.(DMChannelOpenEvent); isOpen {
		// Ratcheted upward only (see bumpVisibilityWatermark): a plain Store(Load(&h.seq))
		// let a writer that read an older h.seq regress a concurrently stored higher
		// watermark.
		h.bumpVisibilityWatermark()
	}
	h.SendToUserHigh(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitActivity(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(ActivityEvent)
	if !ok {
		return false
	}
	// Not a ChannelEvent: no seq and no topic, only a note for the coalescer, which
	// flushes off this goroutine.
	if n := e.ActivityNote(); n.readBy != 0 {
		h.activity.markRead(n.readBy, n.channelID, n.readUpTo, n.readSet, time.Now())
	} else {
		h.activity.note(n)
	}
	return true
}

func (h *Hub) emitThreadNote(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(ThreadNoteEvent)
	if !ok {
		return false
	}
	h.handleThreadNote(e.ThreadNote()) //nolint:contextcheck // the coalescer timer is owned by the hub lifecycle, not by this request
	return true
}

func (h *Hub) emitChannel(ctx context.Context, senderID int64, ev Event) bool {
	e, ok := ev.(ChannelEvent)
	if !ok {
		return false
	}
	h.broadcastChannelEvent(ctx, senderID, e)
	return true
}

func (h *Hub) emitVoiceVisibility(ctx context.Context, _ int64, ev Event) bool {
	e, ok := ev.(VoiceVisibilityEvent)
	if !ok {
		return false
	}
	// Server-wide, but never to a client that cannot read the channel. ctx comes from
	// the dispatching connection so the audience lookup dies with it.
	h.broadcastVoiceEvent(ctx, e.VisibleChannelID(), e.UserID(), e.Payload())
	return true
}

func (h *Hub) emitPresence(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceEvent)
	if !ok {
		return false
	}
	// Normal priority, including presence: connect/disconnect presence for the same user
	// goes out as a sequenced global presence_batch (hub_presence.go). The low queue
	// would be a different per-client FIFO, so writePump (normal strictly before low)
	// could deliver a newer connect/disconnect frame before an older presence_update
	// in the low queue, leaving the observer stale. A user-chosen presence also
	// bypasses the coalescer: drop any entry queued for this user and broadcast
	// atomically under presenceMu (dropQueuedPresenceAndBroadcast), or the pending
	// flush (up to 300ms later) could overwrite this fresher status. The frame is chosen
	// inside the closure under presenceMu: a handler that snapshotted a game before a
	// switch-off must not re-broadcast it after the sweep cleared it.
	h.dropQueuedPresenceAndBroadcast(e.userID, func() {
		h.broadcastPresenceFrame(0, h.presencePayloadLocked(e.userID, e.Payload(), e.bare))
	})
	return true
}

func (h *Hub) emitBroadcastAll(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(BroadcastAllEvent)
	if !ok {
		return false
	}
	h.BroadcastToAll(e.Payload())
	return true
}

// presencePayloadLocked picks the frame for a presence event that may carry a game
// or song the handler snapshotted earlier. bare (the same frame with null game and
// song) is sent while member activity is off, and also when the live game and song
// are both already nil: a sweep cleared them after the snapshot, even if the
// switch was turned back on. The caller holds presenceMu.
func (h *Hub) presencePayloadLocked(userID int64, payload, bare []byte) []byte {
	if bare == nil {
		return payload
	}
	if !h.gameActivity.on.Load() {
		return bare
	}
	if mergeLivePresence(h.clientsOf(userID)).noActivity() {
		return bare
	}
	return payload
}

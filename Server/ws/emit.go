package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// EmitEvents routes typed events to the broadcast methods, called from readPump
// goroutines after a V2 handler returns; ctx carries the connection's
// cancellation for routes that hit the database.
// Routing is by the event's deliveryClass, never by which accessor interfaces it
// satisfies (a DM event is also a ChannelEvent). An unknown class or failed
// assertion is logged and dropped. EmitEvents emits on the server's behalf;
// emitEventsFrom names the sender so their channel frames are rate limited
// (allowTopicFrame).
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
	// Normal priority: sequenced frames share the per-client FIFO so the max-seq
	// ack watermark never passes an undelivered event.
	h.sendSequencedToUsers(e.ChannelID(), e.ParticipantIDs(), 0, e.Payload())
	return true
}

func (h *Hub) emitVoiceChannelGuarded(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(VoiceChannelGuardedEvent)
	if !ok {
		return false
	}
	h.sendToUserIfInVoiceChannel(e.VoiceChannelID(), e.SenderUserID(), e.TargetUserID(), e.Payload())
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
	h.broadcastExcludeLow(e.ChannelID(), e.ExcludeUserID(), e.Payload())
	return true
}

func (h *Hub) emitPresenceOthers(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceOthersEvent)
	if !ok {
		return false
	}
	// Like the visible case, an invisible user's public presence half must
	// invalidate any queued coalescer entry so a stale connect presence cannot
	// overwrite it; the drop and broadcast run atomically under presenceFeed.mu
	// so a racing flush cannot enqueue a stale frame after this one.
	h.dropQueuedPresenceAndBroadcast(e.excludeUserID, func() {
		// Normal priority, not broadcastExcludeLow: every other source of this
		// user's presence uses the normal queue, and the low queue would split it
		// across two FIFOs with different durability (low drops on overflow) and
		// drain order.
		h.broadcastPresenceFrame(e.excludeUserID, e.Payload())
	})
	return true
}

func (h *Hub) emitPresenceSelf(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceSelfEvent)
	if !ok {
		return false
	}
	// Normal priority, not SendToUserHigh: writePump drains high before normal,
	// so a newer invisible self-frame on high could land before an older visible-
	// status frame on normal and leave the owner on a stale status.
	// presenceFeed.mu orders the payload choice against a game activity sweep, as
	// in emitPresence.
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
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
	// Low priority, not the high targeted class: SendToUserHigh would make DM
	// typing the strictest-durability frame (overflow disconnects the client), so
	// a busy typer could disconnect a backpressured recipient over a cosmetic
	// frame.
	h.SendToUserLow(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitCallSignal(ctx context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// Normal priority, not high: a ring or decline is ordered against the
	// caller's voice_leave / voice_state on the normal queue. On high, a fresh
	// call_incoming overtook an older voice_leave and the callee applied that
	// stale leave to the new ring (a false "Missed call"). awaitDispatch first so
	// earlier voice events are queued ahead; a cancelled ctx sends without the
	// barrier.
	_ = h.awaitDispatch(ctx)
	if own, isCall := ev.(CallSignalEvent); isCall && own.ownDevices {
		for _, c := range h.clientsOf(own.targetUserID) {
			if c.features.callSync {
				c.trySendMsg(own.payload)
			}
		}
		return true
	}
	h.SendToUser(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitUserTargeted(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// High priority: dm_channel_open is unsequenced and targeted, so replay can
	// never deliver it and a mid-reconnect addressee would lack the DM channel.
	// Bump the visibility watermark so a client resuming at or before the open
	// takes the full-ready path.
	if _, isOpen := ev.(DMChannelOpenEvent); isOpen {
		// Ratcheted upward only (bumpVisibilityWatermark): a plain
		// Store(Load(&h.seq)) let a writer that read an older h.seq regress a
		// higher concurrent watermark.
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
	// Not a ChannelEvent: no seq or topic, only a note for the coalescer, which
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
	// Server-wide but never to a client that cannot read the channel; ctx comes
	// from the dispatching connection so the lookup dies with it.
	h.broadcastVoiceEvent(ctx, e.VisibleChannelID(), e.UserID(), e.Payload())
	return true
}

func (h *Hub) emitPresence(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceEvent)
	if !ok {
		return false
	}
	// Normal priority: connect/disconnect presence goes out as a sequenced
	// presence_batch on the normal queue, and the low queue could deliver an
	// older presence_update after a newer frame. A user-chosen presence bypasses
	// the coalescer: drop the queued entry and broadcast atomically under
	// presenceFeed.mu (dropQueuedPresenceAndBroadcast), or the pending flush
	// could overwrite it. The frame is chosen inside the closure so a game
	// snapshotted before a switch-off is not re-broadcast after the sweep cleared
	// it.
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

// presencePayloadLocked picks the frame for a presence event whose game or song
// the handler snapshotted earlier. bare (null game and song) is sent while member
// activity is off, or when the live game and song are already nil (a sweep
// cleared them after the snapshot). Caller holds presenceFeed.mu.
func (h *Hub) presencePayloadLocked(userID int64, payload, bare []byte) []byte {
	if bare == nil {
		return payload
	}
	if !h.settings.gameActivity.on.Load() {
		return bare
	}
	if mergeLivePresence(h.clientsOf(userID)).noActivity() {
		return bare
	}
	return payload
}

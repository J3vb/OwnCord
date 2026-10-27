package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// EmitEvents routes typed events to the appropriate broadcast methods.
// Called from readPump goroutines after a V2 handler returns. ctx carries the
// dispatching connection's cancellation for the routes that hit the database.
//
// Routing is chosen by the event's own deliveryClass, never by which accessor
// interfaces it happens to satisfy: a DM event is also a ChannelEvent, a
// presence event is also a BroadcastAllEvent, and case order used to be the only
// thing keeping them apart. Each case asserts the accessor it needs; an event
// whose class is unknown, or whose assertion fails, is logged and dropped,
// never broadcast.
//
// EmitEvents emits on the server's own behalf; emitEventsFrom names the user
// whose request produced the events, so their channel frames are rate limited
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

// emitOne delivers ev on the route its deliveryClass names and reports whether
// it did. false means the class is unknown or ev lacks the accessor interface
// that class needs; nothing was sent. Each route is its own emit* method below,
// which asserts the accessor it needs.
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
	// Normal priority: sequenced frames must share the per-client FIFO
	// so the max-seq ack watermark never passes an undelivered event.
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
	// An invisible user's public presence half: like the visible case, it
	// must invalidate any queued coalescer entry so a stale connect-time
	// presence can't flush after (and overwrite) this fresher user-chosen
	// status. The drop and the broadcast run atomically under presenceMu
	// (see dropQueuedPresenceAndBroadcast, OC-0005) so a flush racing in at
	// the same moment can never enqueue its stale frame after this one.
	h.dropQueuedPresenceAndBroadcast(e.excludeUserID, func() {
		// Normal priority, excluding the owner — NOT broadcastExcludeLow.
		// Every other source of this same user's presence (the
		// connect/disconnect presence_batch, and the visible
		// presence_update path) already shares the normal-priority queue;
		// the low queue would split one user's presence across two
		// per-client FIFOs with different durability (low silently drops
		// on overflow, so no replay ever repairs the loss) and different
		// drain order (writePump drains normal strictly before low) —
		// exactly the hazard OC-0214 fixed for the visible case (OC-0003).
		h.broadcastPresenceFrame(e.excludeUserID, e.Payload())
	})
	return true
}

func (h *Hub) emitPresenceSelf(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceSelfEvent)
	if !ok {
		return false
	}
	// Normal priority, NOT the high-priority class used for other targeted
	// events. Every other source of this same user's own presence — the
	// visible presence_update path and the connect/disconnect batch's
	// private copy — already shares the normal-priority queue, in the
	// presence class (a full queue drops the frame and marks the client
	// stale; see Client.sendPresenceMsg). Routing this one through
	// h.SendToUserHigh instead split one user's own presence across two
	// per-client FIFOs: writePump drains high strictly before normal, so a
	// newer invisible self-frame on high could be delivered before an
	// older visible-status frame still on normal, leaving the owner's own
	// client on a stale status (OC-0003/OC-0214).
	//
	// presenceMu orders the choice of payload against a game activity sweep,
	// the way emitPresence's closure does (WP 8.3e-2).
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	payload := h.presencePayloadLocked(e.TargetUserID(), e.Payload(), e.bare)
	if c := h.GetClient(e.TargetUserID()); c != nil {
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
	// direct-delivery counterpart of TypingChannelEvent (classExcludeSender
	// above), ephemeral and safely droppable on overflow. SendToUserHigh
	// would give the identical event the STRICTEST durability class in a DM
	// (its overflow chain disconnects the client, client.go sendHighMsg ->
	// closeAllSendLocked) versus the most droppable one in a channel, so a
	// busy DM typer could disconnect a backpressured recipient over a
	// cosmetic frame (OC-0260).
	h.SendToUserLow(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitCallSignal(ctx context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// Normal priority, NOT the high-priority targeted class. A ring or
	// decline is ordered against the caller's voice_leave / voice_state,
	// which ride the normal queue via the async hub dispatch. writePump
	// drains high strictly before normal, so on the high queue a fresh
	// call_incoming overtook an older voice_leave and the callee applied
	// that stale leave to the new ring, cancelling it (a false "Missed
	// call"). awaitDispatch first, so any voice event this connection
	// enqueued earlier has reached the normal queue ahead of the signal.
	// Best effort: a cancelled ctx just sends without the barrier.
	_ = h.awaitDispatch(ctx)
	h.SendToUser(e.TargetUserID(), e.Payload())
	return true
}

func (h *Hub) emitUserTargeted(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(UserTargetedEvent)
	if !ok {
		return false
	}
	// High priority: targeted events (DM opens, mentions).
	// dm_channel_open is unsequenced and targeted, so replay can never
	// deliver it — an addressee mid-reconnect would be left with an
	// unreachable DM channel. Bump the visibility watermark so any
	// client resuming from a seq at or before the open takes the
	// full-ready path (whose payload includes DM channels).
	if _, isOpen := ev.(DMChannelOpenEvent); isOpen {
		// Ratcheted upward only: see bumpVisibilityWatermark on Hub.
		// A plain Store(Load(&h.seq)) (as on the other two writers) let a
		// writer that read an older h.seq overwrite a concurrently stored
		// higher watermark, silently regressing mustFullResync's boundary.
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
	// Not a ChannelEvent: it takes no seq and no topic, only a note for
	// the coalescer, which flushes it off this goroutine.
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
	// Server-wide, but never to a client that cannot read the channel.
	// ctx is threaded from the dispatching connection so the audience
	// lookup dies with it rather than outliving the request.
	h.broadcastVoiceEvent(ctx, e.VisibleChannelID(), e.UserID(), e.Payload())
	return true
}

func (h *Hub) emitPresence(_ context.Context, _ int64, ev Event) bool {
	e, ok := ev.(PresenceEvent)
	if !ok {
		return false
	}
	// Normal priority, including presence: connect and disconnect presence
	// for the same user already go out as a sequenced global
	// presence_batch (hub_presence.go). Splitting handler-driven presence
	// onto the low-priority queue put it in a different per-client FIFO
	// than those, so writePump (which drains normal strictly before low)
	// could deliver a newer connect/disconnect frame before an older
	// presence_update still sitting in the low queue — leaving the
	// observer's final view stale (OC-0214).
	// A user-chosen presence also bypasses the connect/disconnect
	// coalescer; drop any entry still queued for this user and broadcast
	// atomically under presenceMu (see dropQueuedPresenceAndBroadcast,
	// OC-0005), or the pending flush (up to 300ms later) could race in
	// between and overwrite this fresher status with the stale one.
	//
	// The frame is chosen inside the closure, under presenceMu: a handler
	// that snapshotted a game before a switch-off must not re-broadcast it
	// after the sweep cleared it (WP 8.3e-2).
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

// presencePayloadLocked picks the frame for a presence event that may carry a
// game or song the handler snapshotted earlier (WP 8.3e-2, 8.10a). bare, the
// same frame with a null game and song, is sent while member activity is off,
// and also when the user's live game and song are both already nil: a sweep
// cleared them after the snapshot, even if the switch has been turned back on
// since. The caller holds presenceMu.
func (h *Hub) presencePayloadLocked(userID int64, payload, bare []byte) []byte {
	if bare == nil {
		return payload
	}
	if !h.gameActivity.on.Load() {
		return bare
	}
	if c := h.GetClient(userID); c == nil || c.livePresence().noActivity() {
		return bare
	}
	return payload
}

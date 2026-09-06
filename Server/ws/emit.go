package ws

import (
	"context"
	"fmt"
	"log/slog"
)

// EmitEvents routes typed events to the appropriate broadcast methods.
// Called from readPump goroutines after a V2 handler returns. ctx carries the
// dispatching connection's cancellation for the routes that hit the database.
//
// CRITICAL ordering: SequencedDMEvent MUST be checked before ChannelEvent
// because DM events implement both interfaces. The SequencedDMEvent path
// calls sendSequencedToUsers which preserves the seqMu serialization guarantee.
//
// VoiceChannelEvent MUST be checked before ExcludeSenderEvent because voice
// events implement a superset of ExcludeSender semantics but target by voice
// channel membership rather than channel focus.
func (h *Hub) EmitEvents(ctx context.Context, events []Event) {
	for _, ev := range events {
		switch e := ev.(type) {
		case SequencedDMEvent:
			// Normal priority: sequenced frames must share the per-client FIFO
			// so the max-seq ack watermark never passes an undelivered event.
			h.sendSequencedToUsers(e.ChannelID(), e.ParticipantIDs(), e.Payload())
		case VoiceChannelGuardedEvent:
			h.sendToUserIfInVoiceChannel(e.VoiceChannelID(), e.TargetUserID(), e.Payload())
		case VoiceChannelEvent:
			h.sendToVoiceChannelExcept(e.VoiceChannelID(), e.ExcludeUserID(), e.Payload())
		case ExcludeSenderEvent:
			// An invisible user's public presence half rides this branch;
			// like the visible case below, it must invalidate any queued
			// coalescer entry so a stale connect-time presence can't flush
			// after (and overwrite) this fresher user-chosen status. The
			// drop and the broadcast run atomically under presenceMu (see
			// dropQueuedPresenceAndBroadcast, OC-0005) so a flush racing in
			// at the same moment can never enqueue its stale frame after
			// this fresher one.
			if po, isPresence := ev.(PresenceOthersEvent); isPresence {
				h.dropQueuedPresenceAndBroadcast(po.excludeUserID, func() {
					// Normal priority, excluding the owner — NOT
					// broadcastExcludeLow. Every other source of this same
					// user's presence (connect/disconnect via BroadcastToAll,
					// and the visible presence_update path below) already
					// shares the normal-priority queue; putting this one on
					// the low-priority queue instead split one user's
					// presence across two per-client FIFOs with different
					// durability (low silently drops on overflow instead of
					// disconnecting, so no replay ever repairs the loss) and
					// different drain order (writePump always drains normal
					// strictly before low, so a newer frame on one queue can
					// be delivered before an older frame still sitting on the
					// other) — exactly the hazard OC-0214 fixed for the
					// visible case below (OC-0003).
					h.BroadcastToAllExcept(po.excludeUserID, e.Payload())
				})
			} else {
				// Low priority: typing indicators are ephemeral.
				h.broadcastExcludeLow(e.ChannelID(), e.ExcludeUserID(), e.Payload())
			}
		case PresenceSelfEvent:
			// Normal priority, NOT the UserTargetedEvent default below (which
			// PresenceSelfEvent also satisfies — this case must stay ordered
			// before it so the type switch picks this one). Every other
			// source of this same user's own presence — the visible
			// presence_update path (PresenceEvent -> BroadcastToAll) and the
			// connect/disconnect coalescer's private half
			// (BroadcastPresence -> h.SendToUser) — already shares the
			// normal-priority queue. Routing this one through
			// h.SendToUserHigh instead split one user's own presence across
			// two per-client FIFOs with different drain order: writePump
			// always drains high strictly before normal, so a newer
			// invisible self-frame on high could be delivered before an
			// older visible-status frame still sitting on normal, leaving
			// the owner's own client on a stale status — the same hazard
			// OC-0003/OC-0214 fixed for the "others" half of presence.
			h.SendToUser(e.TargetUserID(), e.Payload())
		case TypingDMEvent:
			// Low priority, NOT the UserTargetedEvent default below (which
			// TypingDMEvent also satisfies — this case must stay ordered
			// before it so the type switch picks this one). DM typing is the
			// direct-delivery counterpart of TypingChannelEvent, which
			// satisfies ExcludeSenderEvent and is routed to
			// broadcastExcludeLow above — ephemeral and safely droppable on
			// overflow. Falling through to UserTargetedEvent's
			// h.SendToUserHigh instead gave the identical event the
			// STRICTEST durability class in a DM (its overflow fallback
			// chain disconnects the client, client.go sendHighMsg ->
			// closeAllSendLocked) versus the most droppable one in a channel,
			// so a busy DM typer could disconnect a backpressured recipient
			// over a cosmetic frame (OC-0260).
			h.SendToUserLow(e.TargetUserID(), e.Payload())
		case UserTargetedEvent:
			// High priority: targeted events (DM opens, mentions).
			// dm_channel_open is unsequenced and targeted, so replay can never
			// deliver it — an addressee mid-reconnect would be left with an
			// unreachable DM channel. Bump the visibility watermark so any
			// client resuming from a seq at or before the open takes the
			// full-ready path (whose payload includes DM channels).
			if _, isOpen := ev.(DMChannelOpenEvent); isOpen {
				// Ratcheted upward only: see bumpVisibilityWatermark on Hub.
				// A plain Store(Load(&h.seq)) here (as on the other two
				// writers) let a writer that read an older h.seq overwrite a
				// concurrently stored higher watermark, silently regressing
				// mustFullResync's boundary.
				h.bumpVisibilityWatermark()
			}
			h.SendToUserHigh(e.TargetUserID(), e.Payload())
		case ChannelEvent:
			h.BroadcastToChannel(e.ChannelID(), e.Payload())
		case VoiceVisibilityEvent:
			// Server-wide, but never to a client that cannot read the channel.
			// ctx is threaded from the dispatching connection so the audience
			// lookup dies with it rather than outliving the request.
			h.broadcastVoiceEvent(ctx, e.VisibleChannelID(), e.UserID(), e.Payload())
		case BroadcastAllEvent:
			// Normal priority for everything, including presence: connect and
			// disconnect presence for the same user already go out via
			// hub.BroadcastToAll (serve.go, serve_pumps.go, hub_broadcast.go).
			// Splitting handler-driven presence onto the low-priority queue
			// put it in a different per-client FIFO than those, so writePump
			// (which always drains normal strictly before low) could deliver
			// a newer connect/disconnect frame before an older presence_update
			// still sitting in the low queue — leaving the observer's final
			// view of that user's status stale. Routing everything through
			// BroadcastToAll keeps every source of one user's presence in a
			// single ordered, seq-stamped, replayable stream (OC-0214).
			if pe, isPresence := ev.(PresenceEvent); isPresence {
				// A user-chosen presence also bypasses the connect/disconnect
				// coalescer; drop any entry still queued for this user and
				// broadcast atomically under presenceMu (see
				// dropQueuedPresenceAndBroadcast, OC-0005), or the pending
				// flush (up to 300ms later) could race in between the drop
				// and the broadcast and overwrite this fresher status with
				// the stale connect-time one.
				h.dropQueuedPresenceAndBroadcast(pe.userID, func() {
					h.BroadcastToAll(e.Payload())
				})
			} else {
				h.BroadcastToAll(e.Payload())
			}
		default:
			slog.Warn("EmitEvents: unknown event type", "type", fmt.Sprintf("%T", ev))
		}
	}
}

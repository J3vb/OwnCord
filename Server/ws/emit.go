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
					// Low priority: typing indicators are ephemeral.
					h.broadcastExcludeLow(e.ChannelID(), e.ExcludeUserID(), e.Payload())
				})
			} else {
				// Low priority: typing indicators are ephemeral.
				h.broadcastExcludeLow(e.ChannelID(), e.ExcludeUserID(), e.Payload())
			}
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
			h.broadcastVoiceEvent(ctx, e.VisibleChannelID(), e.Payload())
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

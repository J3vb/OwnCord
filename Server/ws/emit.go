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
			// High priority: DMs are time-sensitive.
			h.sendSequencedToUsersHigh(e.ChannelID(), e.ParticipantIDs(), e.Payload())
		case VoiceChannelGuardedEvent:
			h.sendToUserIfInVoiceChannel(e.VoiceChannelID(), e.TargetUserID(), e.Payload())
		case VoiceChannelEvent:
			h.sendToVoiceChannelExcept(e.VoiceChannelID(), e.ExcludeUserID(), e.Payload())
		case ExcludeSenderEvent:
			// Low priority: typing indicators are ephemeral.
			h.broadcastExcludeLow(e.ChannelID(), e.ExcludeUserID(), e.Payload())
		case UserTargetedEvent:
			// High priority: targeted events (DM opens, mentions).
			h.SendToUserHigh(e.TargetUserID(), e.Payload())
		case ChannelEvent:
			h.BroadcastToChannel(e.ChannelID(), e.Payload())
		case VoiceVisibilityEvent:
			// Server-wide, but never to a client that cannot read the channel.
			// ctx is threaded from the dispatching connection so the audience
			// lookup dies with it rather than outliving the request.
			h.broadcastVoiceEvent(ctx, e.VisibleChannelID(), e.Payload())
		case BroadcastAllEvent:
			// Check concrete type: presence is low-priority, others are normal.
			if _, isPresence := ev.(PresenceEvent); isPresence {
				h.BroadcastToAllLow(e.Payload())
			} else {
				h.BroadcastToAll(e.Payload())
			}
		default:
			slog.Warn("EmitEvents: unknown event type", "type", fmt.Sprintf("%T", ev))
		}
	}
}

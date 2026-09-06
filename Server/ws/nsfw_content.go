package ws

import (
	"context"
	"log/slog"
	"time"
)

// broadcastChannelEvent is EmitEvents' ChannelEvent route (B5-7): a metadata
// kind (contentBearingKinds is false) goes straight to BroadcastToChannel,
// unchanged — the ordinary topic-subscriber Publish path, at exactly its
// pre-B5-7 cost. A content-bearing kind is narrowed to
// channelContentAudience — CanReadContent over today's actual topic
// subscribers — and withheld from the plugin sink entirely when the channel
// turned out to be labelled (decision 13: a plugin has no acknowledgement).
func (h *Hub) broadcastChannelEvent(ctx context.Context, e ChannelEvent) {
	if !contentBearingKinds[e.EventType()] {
		h.BroadcastToChannel(e.ChannelID(), e.Payload())
		return
	}
	recipients, labelled := h.channelContentAudience(ctx, e.ChannelID())
	bm := broadcastMsg{
		channelID:      e.ChannelID(),
		msg:            e.Payload(),
		recipients:     recipients,
		skipPluginSink: labelled,
		enqueuedAt:     time.Now(),
	}
	select {
	case h.broadcast <- bm:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping channel content",
			"channel_id", e.ChannelID(), "msg_len", len(e.Payload()))
	}
}

// contentBearingKinds classifies every server->client message type as either
// CONTENT (carries a message body or metadata that discloses one) or
// METADATA (everything else) for B5-7's NSFW gate. broadcastChannelEvent
// routes CONTENT kinds through channelContentAudience (CanReadContent —
// withheld from an unacknowledged member of a labelled channel) and
// everything else through the ordinary BroadcastToChannel/CanViewChannel
// path, unchanged.
//
// true = content-bearing; false = metadata, listed explicitly so a reviewer
// can see the decision was made, not merely defaulted. Every server->client
// type in message_types.go MUST have an entry — TestNSFW_EveryServerFrameKindIsClassified
// fails on any that don't, so B5-8..B5-10's new frames have to choose too.
var contentBearingKinds = map[string]bool{
	// ── content: a message body, or metadata that discloses one ──
	MsgTypeChatMessage:     true,
	MsgTypeChatEdited:      true,
	MsgTypeReactionUpdate:  true,
	MsgTypePluginBroadcast: true, // plugin-authored content posted into a channel

	// ── metadata: no message body ──
	MsgTypeAuthOK:              false,
	MsgTypeAuthError:           false,
	MsgTypeReady:               false, // buildReady carries channel/member/voice state only, never message content
	MsgTypeChatSendOK:          false, // direct to the sender, who already knows their own content
	MsgTypeChatDeleted:         false, // ids only
	MsgTypeChatBulkDeleted:     false, // ids only
	MsgTypeTyping:              false,
	MsgTypePresence:            false,
	MsgTypeChannelCreate:       false, // must reach every viewer, including the one that turns the label on
	MsgTypeChannelUpdate:       false, // ditto
	MsgTypeChannelDelete:       false,
	MsgTypeVoiceState:          false,
	MsgTypeVoiceConfig:         false,
	MsgTypeVoiceToken:          false,
	MsgTypeVoiceLeaveBC:        false,
	MsgTypeVoiceMoved:          false,
	MsgTypeVoiceDisconnected:   false,
	MsgTypeMemberJoin:          false,
	MsgTypeMemberUpdate:        false,
	MsgTypeUserUpdate:          false,
	MsgTypeMemberBan:           false,
	MsgTypeRolesUpdate:         false,
	MsgTypeEmojiUpdate:         false,
	MsgTypeServerRestart:       false,
	MsgTypeError:               false,
	MsgTypePong:                false,
	MsgTypeDMChannelOpen:       false, // DMs cannot be labelled
	MsgTypeDMChannelClose:      false,
	MsgTypeDMRequest:           false, // DMs cannot be labelled
	MsgTypeCallIncoming:        false,
	MsgTypeCallDeclined:        false,
	MsgTypeVoiceE2EEAnnounceBC: false,
	MsgTypeVoiceE2EEOfferRelay: false,
	MsgTypeCommandReply:        false, // ephemeral, direct to the invoking client
	MsgTypeNSFWAck:             false, // the gate's own signal, not gated content
}

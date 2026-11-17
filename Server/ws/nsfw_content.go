package ws

import (
	"context"
	"encoding/json"
	"log/slog"
)

// broadcastChannelEvent is EmitEvents' ChannelEvent route. A metadata kind takes
// BroadcastToChannel's ordinary Publish path. A content-bearing kind stays on that path but
// is marked with nsfwChannelID, so the hub resolves the channel's label and the recipient's
// acknowledgement at dispatch time (off the dispatch goroutine, hub_content_gate.go) and
// narrows subscribers by CanReadContent's ack check. Both carry senderID for the per-sender
// topic limit. Withheld from the plugin sink when the channel is labelled (a plugin has no
// acknowledgement). Resolving at enqueue made authorization a property of when a frame was
// queued, not delivered: a consent revocation completing while it waited was missed, and a
// frame queued before labelling carried no filter and went to everyone, plugin sink
// included. Dispatch-time resolution also moves a DB round trip off every emitting handler
// into a resolver goroutine under a timeout.
func (h *Hub) broadcastChannelEvent(ctx context.Context, senderID int64, e ChannelEvent) {
	_ = ctx
	if !contentBearingKinds[e.EventType()] {
		h.enqueue(broadcastMsg{channelID: e.ChannelID(), msg: e.Payload(), senderID: senderID}, "message")
		return
	}
	h.enqueue(broadcastMsg{
		channelID:     e.ChannelID(),
		msg:           e.Payload(),
		nsfwChannelID: e.ChannelID(),
		senderID:      senderID,
	}, "channel content")
}

// resolveChannelContentGate answers the NSFW content gate for one queued broadcast; a zero
// channelID (metadata kinds, ordinary broadcasts) resolves nothing. Never on the dispatch
// goroutine (a resolver goroutine calls it under contentGateTimeout) and outside seqMu (a DB
// round trip, and seqMu serializes every broadcast). Ordering contract:
// nsfwDispatchResolveRaceHook.
func (h *Hub) resolveChannelContentGate(ctx context.Context, channelID int64) (allow func(userID int64) bool, labelled, unconfirmed bool) {
	if channelID == 0 {
		return nil, false, false
	}
	return h.channelNSFWFilter(ctx, channelID)
}

// nsfwDispatchResolveRaceHook runs once per content-bearing channel event on the dispatch
// goroutine, when dequeued and right before its NSFW gate read (and before seqMu).
// Test-only barrier pinning the ordering contract: the gate is resolved when the event
// reaches the dispatch loop, so a revocation or relabelling COMPLETED by then is honoured.
// It does not promise retraction: a revocation after resolution but before the bytes reach
// a send queue cannot recall frames already authorized.
var nsfwDispatchResolveRaceHook func(channelID int64)

// contentBearingKinds classifies every server-to-client message type for the NSFW gate as
// CONTENT (a message body, or metadata disclosing one) or METADATA. Content kinds go
// through channelNSFWFilter (CanReadContent's ack check); the rest through ordinary
// BroadcastToChannel / CanViewChannel. Metadata is listed explicitly (false) so the
// decision is visible. Every server-to-client type in message_types.go MUST have an entry
// (TestNSFW_EveryServerFrameKindIsClassified).
var contentBearingKinds = map[string]bool{
	MsgTypeChatMessage:         true,
	MsgTypeChatEdited:          true,
	MsgTypeReactionUpdate:      true,
	MsgTypePollUpdate:          true, // names a message and carries its tallies, as reaction_update does
	MsgTypeMessageLinkPreviews: true, // a linked page's title and description, which discloses what the message links to
	MsgTypePluginBroadcast:     true, // plugin-authored content posted into a channel
	MsgTypeThreadChanged:       true, // a thread's name, discloses what the parent's unacknowledged members may not read

	MsgTypeAuthOK:            false,
	MsgTypeAuthError:         false,
	MsgTypeReady:             false, // buildReady carries channel/member/voice state only, never message content
	MsgTypeChatSendOK:        false, // direct to the sender, who already knows their own content
	MsgTypeChatForwardOK:     false, // direct to the sender; ids only
	MsgTypePollCreateOK:      false, // direct to the sender; ids only
	MsgTypeForumPostCreateOK: false, // direct to the sender, who already knows their own content
	MsgTypePollVoteOK:        false, // direct to the sender; ids only
	MsgTypePollEndOK:         false, // direct to the sender; ids only
	MsgTypeChatDeleted:       false, // ids only
	MsgTypeThreadCreateOK:    false, // direct to the sender, who just named the thread
	MsgTypeThreadUpdateOK:    false, // direct to the sender; the thread id only
	MsgTypeThreadFollowOK:    false, // direct to the sender; the thread id and a flag only
	// thread_follow_update goes to one user after the follower and read-access checks, never to a topic, so
	// the gate has nothing to add.
	MsgTypeThreadFollowUpdate:  false,
	MsgTypeThreadDeleted:       false, // ids only
	MsgTypeChatBulkDeleted:     false, // ids only
	MsgTypeChatPinned:          false, // ids + flag only, no message body
	MsgTypeTyping:              false,
	MsgTypePresence:            false,
	MsgTypePresenceBatch:       false,
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
	MsgTypeMemberUpdateBatch:   false,
	MsgTypeUserUpdate:          false,
	MsgTypeMemberBan:           false,
	MsgTypeRolesUpdate:         false,
	MsgTypeEmojiUpdate:         false,
	MsgTypeStickerUpdate:       false,
	MsgTypeUploadPolicy:        false,
	MsgTypeGameActivityPolicy:  false,
	MsgTypeVideoBitrateCap:     false,
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
	MsgTypeVoiceWatching:       false,
	MsgTypeCommandReply:        false, // ephemeral, direct to the invoking client
	MsgTypeNSFWAck:             false, // the gate's own signal, not gated content
	MsgTypeModQueue:            false, // a report's public id and state only; never message content
	MsgTypeModAction:           false, // a warning/timeout notice to its own subject; never message content
	MsgTypeMemberTimeouts:      false, // active-timeout ids and expiries to moderators and the target; never message content
	MsgTypeChannelCategories:   false, // category ids, names and positions to MANAGE_CHANNELS holders only; never message content
	MsgTypeAppealStatus:        false, // an appeal's state to its own appellant only; never message content
	MsgTypeMentionCount:        false, // a channel id and this user's own mention total only; never message content
	MsgTypeReadState:           false, // a channel id and this user's own read pointer and counts only (3D-5c); never message content
	MsgTypeChannelActivity:     false, // ids and flags only (2B-2); the author id is withheld from an unacknowledged reader of a labelled channel
}

// reconnectFrameReadableRaceHook runs once per content-bearing frame in
// reconnectWriteReplay's loop right before its live readability check. Test-only: a revoke
// can land between two frames of one replay, and the hook pins that interleaving.
var reconnectFrameReadableRaceHook func(userID, channelID int64)

// frameReadableNow answers the NSFW content gate live for exactly the one frame about to be
// written, never a batch snapshot, so a revoke or unlabel between two frames of one replay
// is honoured by the next. Label and consent come from one point read. A lookup failure
// fails closed (not readable) and reports confirmed=false so the caller can mark the frame
// lost: the live re-check exists to distrust a stale "yes".
func (h *Hub) frameReadableNow(ctx context.Context, userID, channelID int64) (readable, confirmed bool) {
	found, ok, err := h.readers.Visibility.ChannelContentGate(ctx, userID, channelID)
	if err != nil {
		slog.Warn("ws: frameReadableNow ChannelContentGate failed, dropping frame",
			"channel_id", channelID, "err", err)
		return false, false
	}
	if !found {
		// A missing channel is unknown, not "not labelled": fail closed as channelNSFWFilter does. A deleted
		// channel's frame is not owed.
		slog.Warn("ws: frameReadableNow found no such channel, dropping frame", "channel_id", channelID)
		return false, true
	}
	return ok, true
}

// payloadChannelID extracts payload.channel_id from a wrapped frame, or 0 if absent or
// unparseable. thread_changed carries none; its channel is payload.thread.parent_id.
func payloadChannelID(data []byte) int64 {
	var frame struct {
		Payload struct {
			ChannelID int64 `json:"channel_id"`
			Thread    *struct {
				ParentID int64 `json:"parent_id"`
			} `json:"thread"`
		} `json:"payload"`
	}
	if json.Unmarshal(data, &frame) != nil {
		return 0
	}
	if frame.Payload.ChannelID == 0 && frame.Payload.Thread != nil {
		return frame.Payload.Thread.ParentID
	}
	return frame.Payload.ChannelID
}

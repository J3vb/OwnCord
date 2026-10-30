package ws

import (
	"context"
	"encoding/json"
	"log/slog"
)

// broadcastChannelEvent is EmitEvents' ChannelEvent route. A metadata kind
// (contentBearingKinds false) takes BroadcastToChannel's ordinary topic-subscriber
// Publish path. A content-bearing kind stays on that same path (channel-scoped,
// bm.recipients nil) but is marked with nsfwChannelID, so the hub resolves the
// channel's label and the recipient's acknowledgement at dispatch time (off the
// dispatch goroutine, hub_content_gate.go) and narrows the subscribers by
// CanReadContent's ack check there. Both carry senderID for the per-sender topic
// limit. It is withheld from the plugin sink when the channel is labelled (a plugin
// has no acknowledgement).
//
// Resolving at enqueue with a precomputed filter made authorization a property of
// when a frame was queued, not delivered: a consent revocation completing while it
// waited in h.broadcast was missed, and a frame queued while the channel was
// unlabelled carried no filter, so labelling it before dispatch delivered it to
// everyone, plugin sink included. Resolving at dispatch also moves a database round
// trip off every emitting handler, into a resolver goroutine under a timeout, so
// it does not stall the one goroutine serializing broadcasts.
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

// resolveChannelContentGate answers the NSFW content gate for one queued broadcast.
// A zero channelID (every metadata kind and ordinary broadcast) resolves nothing.
//
// Never on the dispatch goroutine: Run parks the frame in its channel's lane and a
// resolver goroutine calls this under contentGateTimeout. Also outside seqMu: it is
// a database round trip and seqMu serializes every broadcast. The ordering
// contract is on nsfwDispatchResolveRaceHook.
func (h *Hub) resolveChannelContentGate(ctx context.Context, channelID int64) (allow func(userID int64) bool, labelled, unconfirmed bool) {
	if channelID == 0 {
		return nil, false, false
	}
	return h.channelNSFWFilter(ctx, channelID)
}

// nsfwDispatchResolveRaceHook, when non-nil, runs once per content-bearing channel
// event on the dispatch goroutine, when the event is dequeued and immediately
// before its NSFW gate read (and before seqMu). Test-only: the deterministic barrier
// that pins the ordering contract.
//
// The contract: the gate is resolved when the event reaches the dispatch loop, so a
// revocation or relabelling COMPLETED by then is honoured. A caller that enqueues,
// mutates consent, then lets dispatch run is in the honoured case; the hook holds
// dispatch at that boundary instead of sleeping. It does not promise retraction: a
// revocation landing after resolution but before the bytes reach a send queue
// cannot recall frames already authorized.
var nsfwDispatchResolveRaceHook func(channelID int64)

// contentBearingKinds classifies every server-to-client message type for the NSFW
// gate as CONTENT (a message body, or metadata disclosing one) or METADATA.
// broadcastChannelEvent routes content kinds through channelNSFWFilter
// (CanReadContent's ack check: withheld from an unacknowledged member of a labelled
// channel) and everything else through the ordinary BroadcastToChannel /
// CanViewChannel path. Metadata is listed explicitly (false) so a reviewer sees the
// decision was made. Every server-to-client type in message_types.go MUST have an
// entry: TestNSFW_EveryServerFrameKindIsClassified fails otherwise.
var contentBearingKinds = map[string]bool{
	MsgTypeChatMessage:     true,
	MsgTypeChatEdited:      true,
	MsgTypeReactionUpdate:  true,
	MsgTypePollUpdate:      true, // names a message and carries its tallies, as reaction_update does
	MsgTypePluginBroadcast: true, // plugin-authored content posted into a channel
	MsgTypeThreadChanged:   true, // a thread's name, discloses what the parent's unacknowledged members may not read

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
	// thread_follow_update names the thread but is never published to a topic: it goes to
	// one user after the follower and read-access checks, so the gate has nothing to add.
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
	MsgTypeUserUpdate:          false,
	MsgTypeMemberBan:           false,
	MsgTypeRolesUpdate:         false,
	MsgTypeEmojiUpdate:         false,
	MsgTypeStickerUpdate:       false,
	MsgTypeUploadPolicy:        false,
	MsgTypeGameActivityPolicy:  false,
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

// reconnectFrameReadableRaceHook, when non-nil, runs once per content-bearing frame in
// reconnectWriteReplay's write loop right before checking that frame's live
// readability. Test-only: a snapshot per reconnect (or per channel in a batch)
// still lets a revoke land between two frames of one replay and leak everything
// after it, so the hook pins that interleaving deterministically.
var reconnectFrameReadableRaceHook func(userID, channelID int64)

// frameReadableNow answers the NSFW content gate live for exactly the one frame
// about to be written, never a batch snapshot and never reused for another frame:
// reconnectWriteReplay calls it before each content-bearing handshakeWrite, so a
// revoke or unlabel between two frames of one replay is honoured by the very next
// frame. A lookup failure fails closed (not readable) and reports confirmed=false so
// the caller can mark the frame lost: re-checking live exists to distrust a stale
// "yes", so an error must not fall back to one.
func (h *Hub) frameReadableNow(ctx context.Context, userID, channelID int64) (readable, confirmed bool) {
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil {
		slog.Warn("ws: frameReadableNow GetChannel failed, dropping frame",
			"channel_id", channelID, "err", err)
		return false, false
	}
	if ch == nil {
		// A missing channel is unknown, not "not labelled": fail closed as channelNSFWFilter
		// does, rather than trust a frame whose channel cannot be confirmed. A deleted
		// channel's frame is not owed.
		slog.Warn("ws: frameReadableNow found no such channel, dropping frame", "channel_id", channelID)
		return false, true
	}
	if !ch.NSFW {
		return true, true
	}
	ok, ackErr := h.readers.Visibility.HasNSFWAcknowledgement(ctx, userID, channelID)
	if ackErr != nil {
		slog.Warn("ws: frameReadableNow HasNSFWAcknowledgement failed, dropping frame",
			"channel_id", channelID, "err", ackErr)
		return false, false
	}
	return ok, true
}

// payloadChannelID extracts payload.channel_id from a wrapped frame, or 0 if absent
// or unparseable. thread_changed carries none; its channel is the thread's parent
// (payload.thread.parent_id).
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

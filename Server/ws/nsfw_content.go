package ws

import (
	"context"
	"encoding/json"
	"log/slog"
)

// broadcastChannelEvent is EmitEvents' ChannelEvent route (B5-7): a metadata
// kind (contentBearingKinds is false) goes straight to BroadcastToChannel,
// unchanged — the ordinary topic-subscriber Publish path, at exactly its
// pre-B5-7 cost. A content-bearing kind stays on that SAME path (still
// channel-scoped, bm.recipients nil) but is marked with nsfwChannelID, so
// deliverBroadcast resolves the channel's label and the recipient's
// acknowledgement at DISPATCH time and narrows the topic's subscribers by
// CanReadContent's ack check there. Withheld from the plugin sink entirely
// when the channel turns out to be labelled (decision 13: a plugin has no
// acknowledgement).
//
// The gate used to be resolved here, at enqueue, and handed over as a
// precomputed filter. That made a queued frame's authorization a property of
// when it was QUEUED rather than of when it was DELIVERED: a consent
// revocation completing while the frame waited in h.broadcast was not seen by
// it, and — the same defect from the other side — a frame queued while the
// channel was still unlabelled carried no filter at all, so labelling the
// channel before it dispatched delivered it to everyone, including a plugin
// sink that decision 13 says must never receive a labelled channel's content
// (OC-0449). Resolving on the dispatch goroutine also moves a database round
// trip off every emitting request handler and onto the one goroutine that
// already serializes broadcasts.
func (h *Hub) broadcastChannelEvent(ctx context.Context, e ChannelEvent) {
	_ = ctx
	if !contentBearingKinds[e.EventType()] {
		h.BroadcastToChannel(e.ChannelID(), e.Payload())
		return
	}
	h.enqueue(broadcastMsg{
		channelID:     e.ChannelID(),
		msg:           e.Payload(),
		nsfwChannelID: e.ChannelID(),
	}, "channel content")
}

// nsfwDispatchResolveRaceHook, when non-nil, runs once per content-bearing
// channel event on the dispatch goroutine, immediately BEFORE
// deliverBroadcast resolves that event's B5-7 gate and before seqMu is taken.
// Test-only (always nil in production): it is the deterministic barrier the
// ordering contract needs to be pinned rather than raced for.
//
// The contract it exists to pin: the gate is resolved when the event reaches
// the dispatch loop, so a revocation or a relabelling that has COMPLETED by
// then is honoured by that event. A caller that enqueues, then mutates
// consent, then lets dispatch run is in the honoured case; the hook lets a
// test hold dispatch at exactly that boundary, mutate, and release, instead
// of sleeping and hoping the mutation landed in the window. What the contract
// does NOT promise is retraction: a revocation landing after resolution but
// before the bytes reach a send queue cannot recall frames already authorized,
// and nothing here claims it can. Mirrors the established
// reconnectFrameReadableRaceHook / refreshChannelVisibilityRaceHook pattern.
var nsfwDispatchResolveRaceHook func(channelID int64)

// contentBearingKinds classifies every server->client message type as either
// CONTENT (carries a message body or metadata that discloses one) or
// METADATA (everything else) for B5-7's NSFW gate. broadcastChannelEvent
// routes CONTENT kinds through channelNSFWFilter (CanReadContent's ack check
// — withheld from an unacknowledged member of a labelled channel) and
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
	MsgTypeModQueue:            false, // a report's public id and state only (B5-8); never message content
	MsgTypeModAction:           false, // a warning/timeout notice to its own subject (B5-9); never message content
	MsgTypeAppealStatus:        false, // an appeal's state to its own appellant only (B5-10); never message content
}

// reconnectFrameReadableRaceHook, when non-nil, runs once per content-bearing
// frame in reconnectWriteReplay's write loop, immediately before checking
// that frame's live readability (Codex round 2, P1). Test-only (always nil
// in production): a single snapshot taken once per reconnect — or even once
// per channel within a batch — still lets a revoke land between two frames
// of the same replay and leak everything after it, so this hook lets a test
// pin that exact interleaving (revoke between frame N and frame N+1 of the
// SAME channel) deterministically instead of chasing a real goroutine race.
var reconnectFrameReadableRaceHook func(userID, channelID int64)

// frameReadableNow answers B5-7's content gate live, for exactly the one
// frame about to be written — never a batch snapshot, and never reused for
// another frame even of the same channel: reconnectWriteReplay calls this
// immediately before each content-bearing frame's handshakeWrite, so a
// revoke or unlabel landing between two frames of one replay is honoured by
// the very next frame it affects, not just the next reconnect. A lookup
// failure fails closed (not readable) — the whole point of re-checking live
// is to distrust a stale "yes", so an error must not fall back to one.
func (h *Hub) frameReadableNow(ctx context.Context, userID, channelID int64) bool {
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil {
		slog.Warn("ws: frameReadableNow GetChannel failed, dropping frame",
			"channel_id", channelID, "err", err)
		return false
	}
	if ch == nil {
		// A missing channel is UNKNOWN, not "not labelled" — same posture as
		// a lookup error (round 2 P1's channelNSFWFilter fix): fail closed
		// rather than trust a frame whose channel this read cannot even
		// confirm exists any more.
		slog.Warn("ws: frameReadableNow found no such channel, dropping frame", "channel_id", channelID)
		return false
	}
	if !ch.NSFW {
		return true
	}
	ok, ackErr := h.readers.Visibility.HasNSFWAcknowledgement(ctx, userID, channelID)
	if ackErr != nil {
		slog.Warn("ws: frameReadableNow HasNSFWAcknowledgement failed, dropping frame",
			"channel_id", channelID, "err", ackErr)
		return false
	}
	return ok
}

// payloadChannelID extracts payload.channel_id from a wrapped wire frame, or
// 0 if absent/unparseable.
func payloadChannelID(data []byte) int64 {
	var frame struct {
		Payload struct {
			ChannelID int64 `json:"channel_id"`
		} `json:"payload"`
	}
	if json.Unmarshal(data, &frame) != nil {
		return 0
	}
	return frame.Payload.ChannelID
}

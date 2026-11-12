package ws_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// journeyVoiceJoinE2EELeave records a two-party encrypted call: both join, the
// key holder (lowest connected user id in the room) announces its ECDH public
// key and offers the room key to its peer, then leaves.
//
// The fixture carries both forms of voice_state: the sequenced broadcast a
// room's audience receives (sent synchronously to the joiner too, OC-0349 —
// its position in the join burst is now part of the contract), and the
// unsequenced copy the joiner is handed directly for each participant
// already in the room.
func journeyVoiceJoinE2EELeave(t *testing.T, r *epochRig) {
	_, bobID, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)

	// alice joins an empty room: token, her own state, then room config.
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expect("voice_token")
	a.expect("voice_state") // alice's own, sent synchronously (OC-0349)
	a.expect("voice_config")
	b.expect("voice_state") // alice's, broadcast to the room's audience

	// bob joins an occupied room: token, his own state, the state of every
	// participant already there, then room config. Reading his voice_config is
	// also the barrier for the announce below — the voice-topic subscription
	// he needs to receive it is made earlier in the same handler.
	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	b.expect("voice_token")
	b.expect("voice_state") // bob's own, sent synchronously (OC-0349)
	b.expect("voice_state") // alice's, relayed to the joiner
	b.expect("voice_config")
	a.expect("voice_state") // bob's, broadcast to the room's audience

	// alice publishes her ECDH public key, signed by her identity key; the
	// server checks only the size and base64-ness of both and relays them
	// verbatim (voice_e2ee.go:126-140) — it never verifies the signature.
	a.send(map[string]any{
		"type": "voice_e2ee_announce",
		"payload": map[string]any{
			"public_key": "YWxpY2UtZWNkaC1wdWJsaWMta2V5LWZpeHR1cmU=",
			"signature":  "YWxpY2Utc2lnbmF0dXJlLW92ZXItaGVyLWVjZGgta2V5",
		},
	})
	b.expect("voice_e2ee_announce")

	// bob answers with a legacy announce and no signature at all. signature is
	// omitempty on both the command and the relay, so this is what freezes its
	// ABSENT form — alice's above froze the present one, and a field recorded
	// only one way would let the other be renamed or dropped unseen. The relay
	// excludes its sender and alice is idle, so it is the only frame in flight
	// on her socket.
	b.send(map[string]any{
		"type": "voice_e2ee_announce",
		"payload": map[string]any{
			"public_key": "Ym9iLWVjZGgtcHVibGljLWtleS1maXh0dXJl",
		},
	})
	a.expect("voice_e2ee_announce")

	// alice is the key holder (lowest user id in the room) and offers the room
	// key to bob.
	a.send(map[string]any{
		"type": "voice_e2ee_offer",
		"payload": map[string]any{
			"target_user_id": bobID,
			"encrypted_key":  "ZW5jcnlwdGVkLXJvb20ta2V5LWZpeHR1cmU=",
			"iv":             "aXYtZml4dHVyZS0xMg==",
		},
	})
	b.expect("voice_e2ee_offer")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyVoiceWatch records who-watches-what: two members share a room, alice
// reports that she watches bob's screen share (voice_watch), bob receives the
// unsequenced voice_watching relay, then bob clears his own (empty) set and
// alice receives that. The sender never gets its own frame.
func journeyVoiceWatch(t *testing.T, r *epochRig) {
	_, bobID, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)

	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	b.expect("voice_token")
	b.expect("voice_state")
	b.expect("voice_state")
	b.expect("voice_config")
	a.expect("voice_state")

	// Duplicates and alice's own id (1) are dropped; the relay is sorted.
	a.send(map[string]any{
		"type":    "voice_watch",
		"payload": map[string]any{"user_ids": []any{bobID, bobID, 1}},
	})
	b.expect("voice_watching")

	b.send(map[string]any{
		"type":    "voice_watch",
		"payload": map[string]any{"user_ids": []any{}},
	})
	a.expect("voice_watching")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// ─── voice and call slice (WP 7.3a) ──────────────────────────────────────────

// voiceJoinPair joins alice ("a") then bob ("b") to channel id, recording both
// join bursts exactly as journeyVoiceWatch does: alice's own token, state and
// room config plus bob's broadcast on her side, then bob's token, own state,
// the relayed state of alice and config, with alice's copy of bob's state. Each
// read is per connection, so the interleaving between the two sockets is never
// part of the contract.
func voiceJoinPair(a, b *wsConn, channelID int64) {
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	b.expect("voice_token")
	b.expect("voice_state")
	b.expect("voice_state")
	b.expect("voice_config")
	a.expect("voice_state")
}

// journeyVoiceSelfState records the four self-service state toggles, each on
// and then off, as the voice_state broadcast every one of them produces. The
// sender receives its own copy (synchronously, as on join) and the room's other
// member receives the broadcast. Every toggle is sent exactly twice: the
// per-user limit is two per second per command, so a third would be dropped
// with a rate_limited error instead of a frame.
func journeyVoiceSelfState(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	voiceJoinPair(a, b, voiceChannelID)

	toggles := []struct {
		msgType, key string
	}{
		{"voice_mute", "muted"},
		{"voice_deafen", "deafened"},
		{"voice_camera", "enabled"},
		{"voice_screenshare", "enabled"},
	}
	for _, tg := range toggles {
		for _, on := range []bool{true, false} {
			a.send(map[string]any{"type": tg.msgType, "payload": map[string]any{tg.key: on}})
			a.expect("voice_state")
			b.expect("voice_state")
		}
	}

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// seedModerator promotes alice to the Admin role (id 2, position 80, carries
// MUTE_MEMBERS; the migration-001 Moderator role (id 3) does not; Member
// is lower) so her voice_mod_* commands clear the hierarchy and
// MUTE_MEMBERS gate. It runs before any connection is dialled, so the promoted
// role is what the permission cache first loads.
func (r *epochRig) seedModerator(t *testing.T, aliceID int64) {
	t.Helper()
	if err := r.db.UpdateUserRole(context.Background(), aliceID, 2); err != nil {
		t.Fatalf("UpdateUserRole(alice, admin): %v", err)
	}
}

// seedSecondVoiceChannel adds the destination a voice_mod_move needs. It lives
// here, not in seedBaseline, so no other fixture's channel list changes.
func (r *epochRig) seedSecondVoiceChannel(t *testing.T) int64 {
	t.Helper()
	id, err := r.db.CreateChannel(context.Background(), "Voice 2", "voice", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel(Voice 2): %v", err)
	}
	if id != secondVoiceChannelID {
		t.Fatalf("second voice channel id = %d, want %d — the fixtures record channel_id verbatim", id, secondVoiceChannelID)
	}
	return id
}

const secondVoiceChannelID = 3

// journeyVoiceModeration records alice, promoted to Admin, server-muting
// and server-deafening bob (on, then off) while both sit in one voice room.
// Each action is one voice_state broadcast, reaching both sockets. A server
// deafen implies a server mute, so the deafen frames carry both flags.
func journeyVoiceModeration(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	voiceJoinPair(a, b, voiceChannelID)

	for _, on := range []bool{true, false} {
		a.send(map[string]any{
			"type":    "voice_mod_mute",
			"payload": map[string]any{"channel_id": voiceChannelID, "user_id": bobID, "muted": on},
		})
		a.expect("voice_state")
		b.expect("voice_state")
	}
	for _, on := range []bool{true, false} {
		a.send(map[string]any{
			"type":    "voice_mod_deafen",
			"payload": map[string]any{"channel_id": voiceChannelID, "user_id": bobID, "deafened": on},
		})
		a.expect("voice_state")
		b.expect("voice_state")
	}

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyVoiceModerationMoveKick records alice, promoted to Admin, moving bob
// to a second voice channel and then disconnecting him from it.
//
// A move is a server-driven leave followed by voice_moved; the re-join is the
// target's own voice_join, which bob sends here so the kick has somebody to
// act on. Ordering subtleties, all per connection: bob's voice_leave (the
// eviction's broadcast, which reaches him through the hub's fan-out loop) and
// voice_moved (a direct send from the handler) race each other, so they are
// read with expectEither and recorded direct-send first. Voice broadcasts reach
// every client that can see the channel, so alice sees bob's leave from the
// first room, his state in the destination and his leave from it. Bob
// rejoins the DESTINATION, which the post-move rejoin block does not cover (it
// holds only for the channel he was moved out of). After the kick the same
// pairing holds and is recorded the same way: voice_disconnected, then
// voice_leave. Only bob gets voice_disconnected.
func journeyVoiceModerationMoveKick(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	// Only MOVE_MEMBERS opens a move; the seeded Admin role lacks it.
	if _, err := r.db.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE id = 2`, permissions.MoveMembers); err != nil {
		t.Fatalf("grant MOVE_MEMBERS to admin: %v", err)
	}
	r.seedSecondVoiceChannel(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	voiceJoinPair(a, b, voiceChannelID)

	a.send(map[string]any{
		"type":    "voice_mod_move",
		"payload": map[string]any{"user_id": bobID, "to_channel_id": secondVoiceChannelID},
	})
	b.expectEither("voice_moved", "voice_leave")
	a.expect("voice_leave")

	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": secondVoiceChannelID},
	})
	b.expect("voice_token")
	b.expect("voice_state")
	b.expect("voice_config")
	a.expect("voice_state") // bob's, in the destination room: broadcast reaches her too

	a.send(map[string]any{
		"type":    "voice_mod_kick",
		"payload": map[string]any{"user_id": bobID},
	})
	b.expectEither("voice_disconnected", "voice_leave")
	a.expect("voice_leave") // bob's, from the destination room

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave") // alice's, from the first room; bob is out of voice but still sees it
	a.barrier()
	b.barrier()
}

// journeyVoiceTokenRefresh records a member asking for a fresh LiveKit token
// while in a room: the reply is a voice_token addressed to her alone, shaped
// exactly like the one from voice_join. The server allows one refresh per user
// per minute, so this is the only one the journey sends. Nobody else gets a
// frame, which the closing barrier on bob proves.
func journeyVoiceTokenRefresh(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	a.send(map[string]any{"type": "voice_token_refresh", "payload": map[string]any{}})
	a.expect("voice_token")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyCallRingDecline records a one-to-one DM call that is rung and
// declined. alice joins the DM's voice channel first (a ring from someone who
// is not in the call is refused), rings, and bob — who is not in the call —
// receives call_incoming and declines; alice receives call_declined. The call
// signals are direct per-user sends to the other participant only: the ringer
// gets nothing back for the ring and the decliner nothing for the decline.
// Ring and decline are separate rate-limit keys (one per three seconds each),
// so one of each fits.
//
// alice's join broadcasts voice_state to bob too (voice broadcasts reach every
// client that can see the channel, and a DM is visible to both members), so it
// is part of bob's list. The DM exists before either connects and each member
// trusts the other (the ring is filtered on the callee trusting the caller, the
// decline on the reverse), so no dm_request or dm_channel_open frame appears.
func journeyCallRingDecline(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := r.db.TrustSender(context.Background(), bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender(bob trusts alice): %v", err)
	}
	// The decline fans out under the same trust filter as the ring, in the
	// other direction: without alice trusting bob the call_declined would be
	// silently dropped.
	if err := r.db.TrustSender(context.Background(), aliceID, bobID, "accepted"); err != nil {
		t.Fatalf("TrustSender(alice trusts bob): %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok)
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": dmChannel.ID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	a.send(map[string]any{"type": "call_ring", "payload": map[string]any{"channel_id": dmChannel.ID}})
	b.expect("call_incoming")

	b.send(map[string]any{"type": "call_decline", "payload": map[string]any{"channel_id": dmChannel.ID}})
	a.expect("call_declined")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyVoiceModDenied records the server answering a voice command with
// `error`: bob, a plain member, tries to disconnect alice, who is his equal in
// rank. The hierarchy check runs before anything else about the target, so the
// refusal is the same whether or not alice is in voice and nothing is
// broadcast. The error is a direct reply carrying the request's code and
// message; neither the actor nor the target receives any other frame.
func journeyVoiceModDenied(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	b.send(map[string]any{
		"type":    "voice_mod_kick",
		"payload": map[string]any{"user_id": aliceID},
	})
	b.expect("error")
	a.barrier()
	b.barrier()
}

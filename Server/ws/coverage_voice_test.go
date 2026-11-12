package ws_test

// coverage_voice_test.go: voice handler validation and full-flow coverage
// tests (split from coverage_boost_test.go).

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── voice handler edge cases ────────────────────────────────────────────────

func TestHandleVoiceJoin_InvalidChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-bad-chid")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_join", map[string]any{
		"channel_id": "not-a-number",
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceJoin_NegativeChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-neg-chid")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_join", map[string]any{
		"channel_id": -1,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceMute_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-bad-payload")
	c, send := connectClient(t, hub, user, 0, 16)

	// Put client in voice so the "not in voice" guard doesn't fire first.
	ws.SetClientVoiceChID(c, 999)

	raw := envelope("voice_mute", "not-an-object")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid voice_mute payload", code)
	}
}

func TestHandleVoiceDeafen_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-bad-payload")
	c, send := connectClient(t, hub, user, 0, 16)

	// Put client in voice so the "not in voice" guard doesn't fire first.
	ws.SetClientVoiceChID(c, 999)

	raw := envelope("voice_deafen", "not-an-object")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid voice_deafen payload", code)
	}
}

// ─── voice camera and screenshare error paths ────────────────────────────────

func TestHandleVoiceCamera_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-not-in-voice")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_camera", map[string]any{
		"enabled": true,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestHandleVoiceCamera_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-bad-payload")
	vcID := mustCreateChannel(t, database, "cam-vc", "voice")
	c, send := connectClient(t, hub, user, 0, 16)

	// Set voice channel so the not-in-voice check passes.
	ws.SetClientVoiceChID(c, vcID)

	raw := envelope("voice_camera", "not-an-object")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceScreenshare_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-not-in-voice")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_screenshare", map[string]any{
		"enabled": true,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestHandleVoiceScreenshare_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-bad-payload")
	vcID := mustCreateChannel(t, database, "screen-vc", "voice")
	c, send := connectClient(t, hub, user, 0, 16)

	ws.SetClientVoiceChID(c, vcID)

	raw := envelope("voice_screenshare", "not-an-object")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

// ─── voice join/leave full flow (voice_handlers.go coverage) ─────────────────

func TestHandleVoiceJoin_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-flow-user")
	vcID := seedVoiceChannel(t, database, "vj-flow-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	raw := envelope("voice_join", map[string]any{
		"channel_id": vcID,
	})
	hub.HandleMessageForTest(c, raw)

	msgs := drainChanTimeout(send, 500*time.Millisecond)
	foundState := false
	foundConfig := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil {
			switch env["type"] {
			case "voice_state":
				foundState = true
			case "voice_config":
				foundConfig = true
			}
		}
	}
	if !foundState {
		t.Error("expected voice_state broadcast after voice_join")
	}
	if !foundConfig {
		t.Error("expected voice_config after voice_join")
	}
}

// TestVoiceState_NotDeliveredToRolesDeniedRead locks the visibility invariant
// for voice metadata: voice_state / voice_leave used to go out via
// BroadcastToAll, so every authenticated client learned the membership and
// camera/mute state of voice channels that channel_overrides hides from their
// role — even though the ready payload deliberately filters them out. A member
// who can read the channel must still receive them.
func TestVoiceState_NotDeliveredToRolesDeniedRead(t *testing.T) {
	hub, database := newCoverageHub(t)
	joiner := seedCoverageOwner(t, database, "vs-joiner")
	vcID := seedVoiceChannel(t, database, "vs-private-vc")

	// Two plain members (role 4). One is locked out of the channel with the
	// override the admin panel writes when "Can access" is unchecked.
	newMember := func(name string) *db.User {
		t.Helper()
		if _, err := database.CreateUser(context.Background(), name, "hash", 4); err != nil {
			t.Fatalf("CreateUser %s: %v", name, err)
		}
		u, err := database.GetUserByUsername(context.Background(), name)
		if err != nil || u == nil {
			t.Fatalf("GetUserByUsername %s: %v", name, err)
		}
		return u
	}
	insider := newMember("vs-insider")
	outsiderRole := int64(3) // Moderator: a distinct role so the deny is role-scoped
	outsider := newMember("vs-outsider")
	if err := database.UpdateUserRole(context.Background(), outsider.ID, outsiderRole); err != nil {
		t.Fatalf("reassign outsider role: %v", err)
	}
	if err := database.UpsertChannelOverride(context.Background(), vcID, outsiderRole, 0,
		permissions.ReadMessages|permissions.ConnectVoice); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	insiderSend := make(chan []byte, 64)
	outsiderSend := make(chan []byte, 64)
	hub.Register(ws.NewTestClientWithUser(hub, insider, 0, insiderSend))
	hub.Register(ws.NewTestClientWithUser(hub, outsider, 0, outsiderSend))

	jc, _ := connectClient(t, hub, joiner, 0, 64)

	raw := envelope("voice_join", map[string]any{"channel_id": vcID})
	hub.HandleMessageForTest(jc, raw)

	countVoiceState := func(ch <-chan []byte) int {
		n := 0
		for _, msg := range drainChanTimeout(ch, 300*time.Millisecond) {
			var env map[string]any
			if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
				n++
			}
		}
		return n
	}
	if got := countVoiceState(insiderSend); got == 0 {
		t.Error("a member who may READ the channel must still receive voice_state")
	}
	if got := countVoiceState(outsiderSend); got != 0 {
		t.Errorf("a role denied READ received %d voice_state events, want 0", got)
	}
}

func TestHandleVoiceJoin_AlreadyInSameChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-same-user")
	vcID := seedVoiceChannel(t, database, "vj-same-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	raw := joinVoiceAndDrain(hub, c, send, vcID)

	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "ALREADY_JOINED" {
		t.Errorf("error code = %q, want ALREADY_JOINED", code)
	}
}

func TestHandleVoiceJoin_SwitchChannels(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-switch-user")
	vc1 := seedVoiceChannel(t, database, "vj-switch-vc1")
	vc2 := seedVoiceChannel(t, database, "vj-switch-vc2")
	c, send := connectClient(t, hub, user, 0, 128)

	joinVoiceAndDrain(hub, c, send, vc1)

	raw2 := envelope("voice_join", map[string]any{
		"channel_id": vc2,
	})
	hub.HandleMessageForTest(c, raw2)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundLeave := false
	foundConfig := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil {
			switch env["type"] {
			case "voice_leave":
				foundLeave = true
			case "voice_config":
				foundConfig = true
			}
		}
	}
	if !foundLeave {
		t.Error("expected voice_leave broadcast when switching channels")
	}
	if !foundConfig {
		t.Error("expected voice_config for new channel")
	}
}

func TestHandleVoiceJoin_ChannelFull(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := mustCreateChannel(t, database, "full-vc", "voice")
	mustExec(t, database, "UPDATE channels SET voice_max_users = 1 WHERE id = ?", vcID)

	user1 := seedCoverageOwner(t, database, "vj-full-u1")
	c1, send1 := connectClient(t, hub, user1, 0, 64)

	raw := joinVoiceAndDrain(hub, c1, send1, vcID)

	user2 := seedVoiceMember(t, database, "vj-full-u2")
	c2, send2 := connectClient(t, hub, user2, 0, 64)

	hub.HandleMessageForTest(c2, raw)

	code := drainForErrorCode(send2, 300*time.Millisecond)
	if code != "CHANNEL_FULL" {
		t.Errorf("error code = %q, want CHANNEL_FULL", code)
	}
}

func TestHandleVoiceLeave_ExplicitLeave(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vl-explicit-user")
	vcID := seedVoiceChannel(t, database, "vl-explicit-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	joinVoiceAndDrain(hub, c, send, vcID)

	leaveRaw, _ := json.Marshal(map[string]any{"type": "voice_leave"})
	hub.HandleMessageForTest(c, leaveRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	if !containsFrameType(msgs, "voice_leave") {
		t.Error("expected voice_leave broadcast after explicit leave")
	}
}

func TestHandleVoiceLeave_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vl-not-in-voice")
	c, _ := connectClient(t, hub, user, 0, 16)

	// handleVoiceLeave is synchronous — a no-op leave returns with state intact.
	hub.HandleVoiceLeaveForTest(c)

	// Client should still be connected and have no voice channel set.
	if !hub.IsUserConnected(user.ID) {
		t.Error("user should still be connected after no-op voice leave")
	}
	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Errorf("voiceChID = %d, want 0 after leave when not in voice", got)
	}
}

func TestHandleVoiceMute_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-flow-user")
	vcID := seedVoiceChannel(t, database, "vm-flow-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	joinVoiceAndDrain(hub, c, send, vcID)

	muteRaw := envelope("voice_mute", map[string]any{
		"muted": true,
	})
	hub.HandleMessageForTest(c, muteRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	if !containsFrameType(msgs, "voice_state") {
		t.Error("expected voice_state broadcast after mute")
	}
}

func TestHandleVoiceDeafen_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-flow-user")
	vcID := seedVoiceChannel(t, database, "vd-flow-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	joinVoiceAndDrain(hub, c, send, vcID)

	deafenRaw := envelope("voice_deafen", map[string]any{
		"deafened": true,
	})
	hub.HandleMessageForTest(c, deafenRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	if !containsFrameType(msgs, "voice_state") {
		t.Error("expected voice_state broadcast after deafen")
	}
}

func TestHandleVoiceJoin_ChannelNotFound(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-notfound-user")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_join", map[string]any{
		"channel_id": 99999,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("error code = %q, want NOT_FOUND", code)
	}
}

// ─── Voice join quality comes from the global config only ───────────────────

func TestHandleVoiceJoin_PerChannelQualityOverrideIsNotRead(t *testing.T) {
	// voice report #14: channels.voice_quality was read here but nothing ever
	// wrote the column (not CreateChannel, not the admin channel update), so
	// the per-channel override was dead code and is dropped. A value forced
	// into the column directly must not change the join's quality; the global
	// voice.quality is authoritative.
	for _, forced := range []string{"high", "garbage"} {
		t.Run(forced, func(t *testing.T) {
			hub, database := newCoverageHub(t)
			user := seedCoverageOwner(t, database, "vj-quality-user")

			vcID := mustCreateChannel(t, database, "quality-vc", "voice")
			mustExec(t, database, "UPDATE channels SET voice_quality = ? WHERE id = ?", forced, vcID)

			c, send := connectClient(t, hub, user, 0, 64)

			raw := envelope("voice_join", map[string]any{"channel_id": vcID})
			hub.HandleMessageForTest(c, raw)

			for _, msg := range drainChanTimeout(send, 300*time.Millisecond) {
				var env map[string]any
				if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_config" {
					p := env["payload"].(map[string]any)
					if p["quality"] != "medium" {
						t.Errorf("voice_config quality = %v, want medium (the unreachable per-channel override is ignored)", p["quality"])
					}
					return
				}
			}
			t.Error("expected voice_config")
		})
	}
}

func TestHandleVoiceJoin_MultipleParticipants(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "vj-multi-vc")

	user1 := seedCoverageOwner(t, database, "vj-multi-u1")
	c1, send1 := connectClient(t, hub, user1, 0, 64)

	raw := joinVoiceAndDrain(hub, c1, send1, vcID)

	user2 := seedCoverageOwner(t, database, "vj-multi-u2")
	c2, send2 := connectClient(t, hub, user2, 0, 64)

	hub.HandleMessageForTest(c2, raw)

	msgs := drainChanTimeout(send2, 300*time.Millisecond)
	voiceStateCount := 0
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			voiceStateCount++
		}
	}
	if voiceStateCount < 2 {
		t.Errorf("voice_state count = %d, want at least 2", voiceStateCount)
	}
}

func TestHandleVoiceLeave_BroadcastsToOtherParticipants(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "vl-bcast-vc")

	user1 := seedCoverageOwner(t, database, "vl-bcast-u1")
	user2 := seedCoverageOwner(t, database, "vl-bcast-u2")
	c1, send1 := connectClient(t, hub, user1, 0, 64)
	c2, send2 := connectClient(t, hub, user2, 0, 64)

	joinRaw := envelope("voice_join", map[string]any{
		"channel_id": vcID,
	})
	hub.HandleMessageForTest(c1, joinRaw)
	hub.HandleMessageForTest(c2, joinRaw)
	drainChanTimeout(send1, 100*time.Millisecond)
	drainChanBuf(send2)

	leaveRaw, _ := json.Marshal(map[string]any{"type": "voice_leave"})
	hub.HandleMessageForTest(c1, leaveRaw)

	msgs := drainChanTimeout(send2, 300*time.Millisecond)
	if !containsFrameType(msgs, "voice_leave") {
		t.Error("user2 should receive voice_leave when user1 leaves")
	}
}

func TestHandleVoiceCamera_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-flow-user")
	vcID := seedVoiceChannel(t, database, "vc-flow-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	joinVoiceAndDrain(hub, c, send, vcID)

	camRaw := envelope("voice_camera", map[string]any{
		"enabled": true,
	})
	hub.HandleMessageForTest(c, camRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	if !containsFrameType(msgs, "voice_state") {
		t.Error("expected voice_state after camera toggle")
	}
}

func TestHandleVoiceScreenshare_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-flow-user")
	vcID := seedVoiceChannel(t, database, "vs-flow-vc")
	c, send := connectClient(t, hub, user, 0, 64)

	joinVoiceAndDrain(hub, c, send, vcID)

	ssRaw := envelope("voice_screenshare", map[string]any{
		"enabled": true,
	})
	hub.HandleMessageForTest(c, ssRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	if !containsFrameType(msgs, "voice_state") {
		t.Error("expected voice_state after screenshare toggle")
	}
}

// ─── Voice control "not in voice" guards ────────────────────────────────────

func TestHandleVoiceMute_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-not-in-voice")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_mute", map[string]any{
		"muted": true,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestHandleVoiceDeafen_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-not-in-voice")
	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("voice_deafen", map[string]any{
		"deafened": true,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

// ─── Voice join with invalid quality fallback ───────────────────────────────

func TestHandleVoiceJoin_InvalidQualityFallsBackToMedium(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-badquality-user")

	vcID := mustCreateChannel(t, database, "badquality-vc", "voice")
	mustExec(t, database, "UPDATE channels SET voice_quality = 'garbage' WHERE id = ?", vcID)

	c, send := connectClient(t, hub, user, 0, 64)

	raw := envelope("voice_join", map[string]any{
		"channel_id": vcID,
	})
	hub.HandleMessageForTest(c, raw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_config" {
			p := env["payload"].(map[string]any)
			if p["quality"] != "medium" {
				t.Errorf("voice_config quality = %v, want medium", p["quality"])
			}
			return
		}
	}
	t.Error("expected voice_config with medium quality fallback")
}

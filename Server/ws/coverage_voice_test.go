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
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": "not-a-number",
		},
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
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": -1,
		},
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
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Put client in voice so the "not in voice" guard doesn't fire first.
	ws.SetClientVoiceChID(c, 999)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mute",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid voice_mute payload", code)
	}
}

func TestHandleVoiceDeafen_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Put client in voice so the "not in voice" guard doesn't fire first.
	ws.SetClientVoiceChID(c, 999)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_deafen",
		"payload": "not-an-object",
	})
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
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_camera",
		"payload": map[string]any{
			"enabled": true,
		},
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
	vcID, err := database.CreateChannel(context.Background(), "cam-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Set voice channel so the not-in-voice check passes.
	ws.SetClientVoiceChID(c, vcID)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_camera",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceScreenshare_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_screenshare",
		"payload": map[string]any{
			"enabled": true,
		},
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
	vcID, err := database.CreateChannel(context.Background(), "screen-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	ws.SetClientVoiceChID(c, vcID)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_screenshare",
		"payload": "not-an-object",
	})
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
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
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
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET role_id = ? WHERE id = ?`, outsiderRole, outsider.ID,
	); err != nil {
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

	joinerSend := make(chan []byte, 64)
	jc := ws.NewTestClientWithUser(hub, joiner, 0, joinerSend)
	hub.Register(jc)
	waitRegistered(t, hub, jc)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": vcID},
	})
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
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	drainChanTimeout(send, 100*time.Millisecond)

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
	send := make(chan []byte, 128)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw1, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vc1,
		},
	})
	hub.HandleMessageForTest(c, raw1)
	drainChanTimeout(send, 100*time.Millisecond)

	raw2, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vc2,
		},
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
	vcID, err := database.CreateChannel(context.Background(), "full-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	_, err = database.ExecContext(context.Background(), "UPDATE channels SET voice_max_users = 1 WHERE id = ?", vcID)
	if err != nil {
		t.Fatalf("UPDATE channels: %v", err)
	}

	user1 := seedCoverageOwner(t, database, "vj-full-u1")
	send1 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	waitRegistered(t, hub, c1)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c1, raw)
	drainChanTimeout(send1, 100*time.Millisecond)

	user2 := seedCoverageOwner(t, database, "vj-full-u2")
	send2 := make(chan []byte, 64)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

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
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	drainChanTimeout(send, 100*time.Millisecond)

	leaveRaw, _ := json.Marshal(map[string]any{"type": "voice_leave"})
	hub.HandleMessageForTest(c, leaveRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundLeave := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_leave" {
			foundLeave = true
			break
		}
	}
	if !foundLeave {
		t.Error("expected voice_leave broadcast after explicit leave")
	}
}

func TestHandleVoiceLeave_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vl-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

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
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	drainChanTimeout(send, 100*time.Millisecond)

	muteRaw, _ := json.Marshal(map[string]any{
		"type": "voice_mute",
		"payload": map[string]any{
			"muted": true,
		},
	})
	hub.HandleMessageForTest(c, muteRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state broadcast after mute")
	}
}

func TestHandleVoiceDeafen_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-flow-user")
	vcID := seedVoiceChannel(t, database, "vd-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	drainChanTimeout(send, 100*time.Millisecond)

	deafenRaw, _ := json.Marshal(map[string]any{
		"type": "voice_deafen",
		"payload": map[string]any{
			"deafened": true,
		},
	})
	hub.HandleMessageForTest(c, deafenRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state broadcast after deafen")
	}
}

func TestHandleVoiceJoin_ChannelNotFound(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-notfound-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": 99999,
		},
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("error code = %q, want NOT_FOUND", code)
	}
}

func TestHandleVoiceJoin_WithQualityOverride(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-quality-user")

	vcID, err := database.CreateChannel(context.Background(), "quality-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	_, err = database.ExecContext(context.Background(), "UPDATE channels SET voice_quality = 'high' WHERE id = ?", vcID)
	if err != nil {
		t.Fatalf("UPDATE: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, raw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_config" {
			p := env["payload"].(map[string]any)
			if p["quality"] != "high" {
				t.Errorf("voice_config quality = %v, want high", p["quality"])
			}
			return
		}
	}
	t.Error("expected voice_config with quality override")
}

func TestHandleVoiceJoin_MultipleParticipants(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "vj-multi-vc")

	user1 := seedCoverageOwner(t, database, "vj-multi-u1")
	send1 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	waitRegistered(t, hub, c1)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c1, raw)
	drainChanTimeout(send1, 100*time.Millisecond)

	user2 := seedCoverageOwner(t, database, "vj-multi-u2")
	send2 := make(chan []byte, 64)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

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
	send1 := make(chan []byte, 64)
	send2 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c1)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c1, joinRaw)
	hub.HandleMessageForTest(c2, joinRaw)
	drainChanTimeout(send1, 100*time.Millisecond)
	drainChanBuf(send2)

	leaveRaw, _ := json.Marshal(map[string]any{"type": "voice_leave"})
	hub.HandleMessageForTest(c1, leaveRaw)

	msgs := drainChanTimeout(send2, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_leave" {
			found = true
			break
		}
	}
	if !found {
		t.Error("user2 should receive voice_leave when user1 leaves")
	}
}

func TestHandleVoiceCamera_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-flow-user")
	vcID := seedVoiceChannel(t, database, "vc-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	drainChanTimeout(send, 100*time.Millisecond)

	camRaw, _ := json.Marshal(map[string]any{
		"type": "voice_camera",
		"payload": map[string]any{
			"enabled": true,
		},
	})
	hub.HandleMessageForTest(c, camRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state after camera toggle")
	}
}

func TestHandleVoiceScreenshare_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-flow-user")
	vcID := seedVoiceChannel(t, database, "vs-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	drainChanTimeout(send, 100*time.Millisecond)

	ssRaw, _ := json.Marshal(map[string]any{
		"type": "voice_screenshare",
		"payload": map[string]any{
			"enabled": true,
		},
	})
	hub.HandleMessageForTest(c, ssRaw)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state after screenshare toggle")
	}
}

// ─── Voice control "not in voice" guards ────────────────────────────────────

func TestHandleVoiceMute_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_mute",
		"payload": map[string]any{
			"muted": true,
		},
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
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_deafen",
		"payload": map[string]any{
			"deafened": true,
		},
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

	vcID, err := database.CreateChannel(context.Background(), "badquality-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	_, err = database.ExecContext(context.Background(), "UPDATE channels SET voice_quality = 'garbage' WHERE id = ?", vcID)
	if err != nil {
		t.Fatalf("UPDATE: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
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

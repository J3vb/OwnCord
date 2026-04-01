package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// ─── IsUserConnected ────────────────────────────────────────────────────────

func TestIsUserConnected_NotConnected(t *testing.T) {
	hub, _ := newCoverageHub(t)

	if hub.IsUserConnected(9999) {
		t.Error("expected false for unregistered user")
	}
}

func TestIsUserConnected_Connected(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "connected-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if !hub.IsUserConnected(user.ID) {
		t.Error("expected true for registered user")
	}
}

func TestIsUserConnected_AfterUnregister(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "unreg-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.Unregister(c)
	time.Sleep(20 * time.Millisecond)

	if hub.IsUserConnected(user.ID) {
		t.Error("expected false after unregister")
	}
}

// ─── qualityBitrate ─────────────────────────────────────────────────────────

func TestQualityBitrate_KnownPresets(t *testing.T) {
	tests := []struct {
		quality string
		want    int
	}{
		{"low", 32000},
		{"medium", 64000},
		{"high", 128000},
	}
	for _, tc := range tests {
		got := ws.QualityBitrateForTest(tc.quality)
		if got != tc.want {
			t.Errorf("qualityBitrate(%q) = %d, want %d", tc.quality, got, tc.want)
		}
	}
}

func TestQualityBitrate_UnknownFallsBackToMedium(t *testing.T) {
	got := ws.QualityBitrateForTest("ultra")
	if got != 64000 {
		t.Errorf("qualityBitrate('ultra') = %d, want 64000 (medium fallback)", got)
	}
}

func TestQualityBitrate_EmptyFallsBackToMedium(t *testing.T) {
	got := ws.QualityBitrateForTest("")
	if got != 64000 {
		t.Errorf("qualityBitrate('') = %d, want 64000 (medium fallback)", got)
	}
}

// ─── buildDMChannelOpen ─────────────────────────────────────────────────────

func TestBuildDMChannelOpen_NilRecipient(t *testing.T) {
	result := ws.BuildDMChannelOpenForTest(1, nil)
	if result != nil {
		t.Error("expected nil for nil recipient")
	}
}

func TestBuildDMChannelOpen_ValidRecipient(t *testing.T) {
	avatar := "avatar.png"
	user := &db.User{
		ID:       42,
		Username: "testuser",
		Avatar:   &avatar,
		Status:   "online",
	}

	result := ws.BuildDMChannelOpenForTest(100, user)
	if result == nil {
		t.Fatal("expected non-nil result for valid recipient")
	}
	if !json.Valid(result) {
		t.Fatalf("result is not valid JSON: %s", result)
	}

	var msg struct {
		Type    string `json:"type"`
		Payload struct {
			ChannelID int64 `json:"channel_id"`
			Recipient struct {
				ID       int64  `json:"id"`
				Username string `json:"username"`
				Avatar   string `json:"avatar"`
				Status   string `json:"status"`
			} `json:"recipient"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(result, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Payload.ChannelID != 100 {
		t.Errorf("ChannelID = %d, want 100", msg.Payload.ChannelID)
	}
	if msg.Payload.Recipient.ID != 42 {
		t.Errorf("Recipient.ID = %d, want 42", msg.Payload.Recipient.ID)
	}
	if msg.Payload.Recipient.Username != "testuser" {
		t.Errorf("Username = %q, want 'testuser'", msg.Payload.Recipient.Username)
	}
	if msg.Payload.Recipient.Avatar != "avatar.png" {
		t.Errorf("Avatar = %q, want 'avatar.png'", msg.Payload.Recipient.Avatar)
	}
}

func TestBuildDMChannelOpen_NilAvatar(t *testing.T) {
	user := &db.User{
		ID:       43,
		Username: "noavatar",
		Avatar:   nil,
		Status:   "offline",
	}

	result := ws.BuildDMChannelOpenForTest(200, user)
	if result == nil {
		t.Fatal("expected non-nil result")
	}

	var msg struct {
		Payload struct {
			Recipient struct {
				Avatar string `json:"avatar"`
			} `json:"recipient"`
		} `json:"payload"`
	}
	_ = json.Unmarshal(result, &msg)
	if msg.Payload.Recipient.Avatar != "" {
		t.Errorf("Avatar = %q, want empty string for nil avatar", msg.Payload.Recipient.Avatar)
	}
}

// ─── broadcastVoiceStateUpdate ──────────────────────────────────────────────

func TestBroadcastVoiceStateUpdate_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "bvsu-noop")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// User not in voice — should be a no-op, no crash.
	hub.BroadcastVoiceStateUpdateForTest(c)
}

func TestBroadcastVoiceStateUpdate_InVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "bvsu-voice")

	// Create a voice channel.
	chanID, err := database.CreateChannel("bvsu-ch", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// Join the voice channel in DB.
	if err := database.JoinVoiceChannel(user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	ws.SetClientVoiceChID(c, chanID)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Should broadcast a voice_state message.
	hub.BroadcastVoiceStateUpdateForTest(c)

	// Drain the channel and check for voice_state message.
	time.Sleep(20 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "voice_state" {
			found = true
		}
	}
	if !found {
		t.Error("expected voice_state broadcast")
	}
}

// ─── handleVoiceMute via HandleMessageForTest ───────────────────────────────

func TestHandleVoiceMute_NotInVoice2(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "mute-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.RegisterNowForTest(c)

	payload := `{"muted":true}`
	raw, _ := json.Marshal(map[string]any{"type": "voice_mute", "payload": json.RawMessage(payload)})
	hub.HandleMessageForTest(c, raw)

	// Should receive an error about not being in a voice channel.
	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type    string `json:"type"`
			Payload struct {
				Message string `json:"message"`
			} `json:"payload"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error message when not in voice channel")
	}
}

// ─── handleVoiceDeafen not in voice ─────────────────────────────────────────

func TestHandleVoiceDeafen_NotInVoice2(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "deafen-not-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.RegisterNowForTest(c)

	payload := `{"deafened":true}`
	raw, _ := json.Marshal(map[string]any{"type": "voice_deafen", "payload": json.RawMessage(payload)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error message when not in voice channel")
	}
}

// ─── handleVoiceCamera not in voice ─────────────────────────────────────────

func TestHandleVoiceCamera_NotInVoice2(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cam-not-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.RegisterNowForTest(c)

	payload := `{"enabled":true}`
	raw, _ := json.Marshal(map[string]any{"type": "voice_camera", "payload": json.RawMessage(payload)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error message when not in voice channel")
	}
}

// ─── handleVoiceScreenshare not in voice ────────────────────────────────────

func TestHandleVoiceScreenshare_NotInVoice2(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "share-not-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.RegisterNowForTest(c)

	payload := `{"enabled":true}`
	raw, _ := json.Marshal(map[string]any{"type": "voice_screenshare", "payload": json.RawMessage(payload)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error message when not in voice channel")
	}
}

// ─── handleVoiceMute/Deafen bad payload ─────────────────────────────────────

func TestHandleVoiceMute_BadPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "mute-bad-payload")
	chanID, _ := database.CreateChannel("mute-bp-ch", "voice", "", "", 0)
	_ = database.JoinVoiceChannel(user.ID, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	ws.SetClientVoiceChID(c, chanID)
	hub.RegisterNowForTest(c)

	raw, _ := json.Marshal(map[string]any{"type": "voice_mute", "payload": json.RawMessage(`{invalid json`)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error for bad payload")
	}
}

func TestHandleVoiceDeafen_BadPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "deafen-bad-payload")
	chanID, _ := database.CreateChannel("deafen-bp-ch", "voice", "", "", 0)
	_ = database.JoinVoiceChannel(user.ID, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	ws.SetClientVoiceChID(c, chanID)
	hub.RegisterNowForTest(c)

	raw, _ := json.Marshal(map[string]any{"type": "voice_deafen", "payload": json.RawMessage(`not json`)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error for bad payload")
	}
}

// ─── handleVoiceCamera bad payload ──────────────────────────────────────────

func TestHandleVoiceCamera_BadPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cam-bad-payload")
	chanID, _ := database.CreateChannel("cam-bp-ch", "voice", "", "", 0)
	_ = database.JoinVoiceChannel(user.ID, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	ws.SetClientVoiceChID(c, chanID)
	ws.SetClientVoiceStateForTest(c, chanID, "join-token-fake")
	hub.RegisterNowForTest(c)

	raw, _ := json.Marshal(map[string]any{"type": "voice_camera", "payload": json.RawMessage(`{bad`)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error for bad payload")
	}
}

// ─── handleVoiceScreenshare bad payload ─────────────────────────────────────

func TestHandleVoiceScreenshare_BadPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "share-bad-payload")
	chanID, _ := database.CreateChannel("share-bp-ch", "voice", "", "", 0)
	_ = database.JoinVoiceChannel(user.ID, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	ws.SetClientVoiceChID(c, chanID)
	ws.SetClientVoiceStateForTest(c, chanID, "join-token-fake")
	hub.RegisterNowForTest(c)

	raw, _ := json.Marshal(map[string]any{"type": "voice_screenshare", "payload": json.RawMessage(`{bad`)})
	hub.HandleMessageForTest(c, raw)

	time.Sleep(10 * time.Millisecond)
	found := false
	for len(send) > 0 {
		msg := <-send
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error for bad payload")
	}
}

// ─── leaveVoiceChannelWithRetry empty token ─────────────────────────────────

func TestLeaveVoiceChannelWithRetry_EmptyToken(t *testing.T) {
	hub, _ := newCoverageHub(t)

	err := ws.LeaveVoiceChannelWithRetryForTest(hub, 1, 1, "")
	if err != nil {
		t.Errorf("expected nil error for empty token, got %v", err)
	}
}

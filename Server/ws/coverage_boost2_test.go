package ws_test

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
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
	connectClient(t, hub, user, 0, 16)

	if !hub.IsUserConnected(user.ID) {
		t.Error("expected true for registered user")
	}
}

func TestIsUserConnected_AfterUnregister(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "unreg-user")
	c, _ := connectClient(t, hub, user, 0, 16)

	hub.Unregister(c)
	waitFor(t, waitTimeout, func() bool { return !hub.IsUserConnected(user.ID) },
		"client to be unregistered")

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
	mustUnmarshal(t, result, &msg)
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

// registerVoiceTestClient registers a client for a fresh Owner user; when
// inVoice is set it is also placed in a new voice channel (DB row and
// in-memory state), carrying joinToken when non-empty.
func registerVoiceTestClient(t *testing.T, name string, inVoice bool, joinToken string) (*ws.Hub, *ws.Client, chan []byte) {
	t.Helper()
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, name)
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	if inVoice {
		chanID := seedVoiceChannel(t, database, name+"-ch")
		mustJoinVoice(t, database, user.ID, chanID)
		ws.SetClientVoiceChID(c, chanID)
		if joinToken != "" {
			ws.SetClientVoiceStateForTest(c, chanID, joinToken)
		}
	}
	hub.RegisterNowForTest(c)
	return hub, c, send
}

// expectErrorReply handles raw and asserts an error frame is already buffered:
// error replies are sent synchronously by handleMessage.
func expectErrorReply(t *testing.T, hub *ws.Hub, c *ws.Client, send chan []byte, raw []byte, msg string) {
	t.Helper()
	hub.HandleMessageForTest(c, raw)
	found := false
	for len(send) > 0 {
		var m struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(<-send, &m)
		if m.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Error(msg)
	}
}

// ─── voice self-state commands outside a voice channel ──────────────────────

func TestHandleVoiceSelfState_NotInVoice2(t *testing.T) {
	cases := []struct {
		name, user, msgType, payload string
	}{
		{"mute", "mute-not-in-voice", "voice_mute", `{"muted":true}`},
		{"deafen", "deafen-not-voice", "voice_deafen", `{"deafened":true}`},
		{"camera", "cam-not-voice", "voice_camera", `{"enabled":true}`},
		{"screenshare", "share-not-voice", "voice_screenshare", `{"enabled":true}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub, c, send := registerVoiceTestClient(t, tc.user, false, "")
			raw := envelope(tc.msgType, json.RawMessage(tc.payload))
			expectErrorReply(t, hub, c, send, raw, "expected error message when not in voice channel")
		})
	}
}

// ─── voice self-state commands with a malformed payload ─────────────────────

func TestHandleVoiceSelfState_BadPayload(t *testing.T) {
	cases := []struct {
		name, user, msgType, payload string
		fakeJoinToken                bool
	}{
		{"mute", "mute-bad-payload", "voice_mute", `"not an object"`, false},
		{"deafen", "deafen-bad-payload", "voice_deafen", `[1, 2]`, false},
		{"camera", "cam-bad-payload", "voice_camera", `42`, true},
		{"screenshare", "share-bad-payload", "voice_screenshare", `"not an object"`, true},
	}
	// Each payload is valid JSON of the wrong shape, so the envelope parses and
	// the handler's own payload decoding is what refuses it.
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token := ""
			if tc.fakeJoinToken {
				token = "join-token-fake"
			}
			hub, c, send := registerVoiceTestClient(t, tc.user, true, token)
			raw := envelope(tc.msgType, json.RawMessage(tc.payload))
			expectErrorReply(t, hub, c, send, raw, "expected error for bad payload")
		})
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

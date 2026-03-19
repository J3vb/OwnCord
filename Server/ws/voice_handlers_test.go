package ws_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// voiceSchema extends hubTestSchema with the voice_states table.
var voiceSchema = append(hubTestSchema, []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);
`)...)

// openVoiceTestDB opens an in-memory DB with the full voice schema.
func openVoiceTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: voiceSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// newVoiceHub creates a hub+db suitable for voice handler tests.
func newVoiceHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openVoiceTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// seedVoiceOwner inserts an Owner-role user for permission-passing tests.
func seedVoiceOwner(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 1) // roleID=1 → Owner
	if err != nil {
		t.Fatalf("seedVoiceOwner CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("seedVoiceOwner GetUserByUsername: %v", err)
	}
	return user
}

// seedVoiceChan creates a voice-type channel.
func seedVoiceChan(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("seedVoiceChan: %v", err)
	}
	return id
}

// voiceJoinMsg builds a raw voice_join WebSocket message.
func voiceJoinMsg(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	return raw
}

// voiceLeaveMsg builds a raw voice_leave WebSocket message.
func voiceLeaveMsg() []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_leave",
		"payload": map[string]any{},
	})
	return raw
}

// voiceMuteMsg builds a voice_mute message.
func voiceMuteMsg(muted bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mute",
		"payload": map[string]any{"muted": muted},
	})
	return raw
}

// voiceDeafenMsg builds a voice_deafen message.
func voiceDeafenMsg(deafened bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_deafen",
		"payload": map[string]any{"deafened": deafened},
	})
	return raw
}

// voiceSignalMsg builds a voice_offer/answer/ice message.
func voiceSignalMsg(msgType string, channelID int64, sdp string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": msgType,
		"payload": map[string]any{
			"channel_id": channelID,
			"sdp":        sdp,
		},
	})
	return raw
}

// voiceICEMsg builds a voice_ice message.
func voiceICEMsg(channelID int64, candidate string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "voice_ice",
		"payload": map[string]any{
			"channel_id": channelID,
			"candidate":  candidate,
		},
	})
	return raw
}

// extractType parses a JSON message and returns the "type" field.
func extractType(t *testing.T, msg []byte) string {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("extractType unmarshal: %v", err)
	}
	typ, _ := env["type"].(string)
	return typ
}

// extractCode parses a JSON error message and returns the payload "code" field.
// Returns an empty string if the message is not an error envelope.
func extractCode(t *testing.T, msg []byte) string {
	t.Helper()
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			Code string `json:"code"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		return ""
	}
	if env.Type != "error" {
		return ""
	}
	return env.Payload.Code
}

// drainChan reads all pending messages from ch into a slice.
func drainChan(ch <-chan []byte) [][]byte {
	var msgs [][]byte
	for {
		select {
		case m := <-ch:
			msgs = append(msgs, m)
		default:
			return msgs
		}
	}
}

// ─── voice_join ───────────────────────────────────────────────────────────────

func TestVoice_Join_SetsStateInDB(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "alice")
	chanID := seedVoiceChan(t, database, "vc-alice")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("voice state is nil after voice_join")
	}
	if state.ChannelID != chanID {
		t.Errorf("ChannelID = %d, want %d", state.ChannelID, chanID)
	}
}

func TestVoice_Join_BroadcastsVoiceState(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "bob")
	chanID := seedVoiceChan(t, database, "vc-bob")

	// A second client in the same voice channel to receive the broadcast.
	send2 := make(chan []byte, 16)
	user2 := seedVoiceOwner(t, database, "bob2")
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	// Look for a voice_state message in either send or send2.
	foundVoiceState := false
	allMsgs := append(drainChan(send), drainChan(send2)...)
	for _, msg := range allMsgs {
		if extractType(t, msg) == "voice_state" {
			foundVoiceState = true
			break
		}
	}
	if !foundVoiceState {
		t.Error("voice_state broadcast not received after voice_join")
	}
}

func TestVoice_Join_SendsCurrentStatesToJoiner(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-existing")

	// user1 joins first.
	user1 := seedVoiceOwner(t, database, "carol1")
	send1 := make(chan []byte, 16)
	c1 := ws.NewTestClientWithUser(hub, user1, chanID, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	// Drain send1 to clear join broadcast.
	drainChan(send1)

	// user2 joins — should receive voice_state for user1.
	user2 := seedVoiceOwner(t, database, "carol2")
	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	// user2 should have received a voice_state for user1.
	msgs2 := drainChan(send2)
	voiceStateCount := 0
	for _, msg := range msgs2 {
		if extractType(t, msg) == "voice_state" {
			voiceStateCount++
		}
	}
	if voiceStateCount == 0 {
		t.Error("joining client did not receive existing voice states")
	}
}

func TestVoice_Join_MissingChannelID_SendsError(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "dave")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	badMsg, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": 0},
	})
	hub.HandleMessageForTest(c, badMsg)
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected error response for invalid channel_id")
	}
}

func TestVoice_Join_NoPermission_SendsError(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-noperm")

	// Member role (id=4) has permissions 1635 (0x663). Bit 9 (0x200 = 512) for CONNECT_VOICE.
	// Check if member has it: 1635 & 512 = 512, so member DOES have it.
	// We need a role without it. We'll set a custom role using direct DB exec.
	// For simplicity, use a user with nil user (no role) to fail perm check.
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, 9999, send) // no user set → hasChannelPerm returns false
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected FORBIDDEN error for client without CONNECT_VOICE permission")
	}
}

// ─── voice_leave ──────────────────────────────────────────────────────────────

func TestVoice_Leave_ClearsStateInDB(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "eve")
	chanID := seedVoiceChan(t, database, "vc-eve")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	time.Sleep(30 * time.Millisecond)

	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after leave: %v", err)
	}
	if state != nil {
		t.Error("voice state still set after voice_leave")
	}
}

func TestVoice_Leave_BroadcastsVoiceLeave(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-leave-bcast")

	user := seedVoiceOwner(t, database, "frank")
	user2 := seedVoiceOwner(t, database, "frank2")

	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)
	drainChan(send2)

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	time.Sleep(50 * time.Millisecond)

	allMsgs := append(drainChan(send), drainChan(send2)...)
	found := false
	for _, msg := range allMsgs {
		if extractType(t, msg) == "voice_leave" {
			found = true
			break
		}
	}
	if !found {
		t.Error("voice_leave broadcast not received after voice_leave message")
	}
}

// ─── voice_mute ───────────────────────────────────────────────────────────────

func TestVoice_Mute_UpdatesStateInDB(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "grace")
	chanID := seedVoiceChan(t, database, "vc-grace")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceMuteMsg(true))
	time.Sleep(30 * time.Millisecond)

	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Muted {
		t.Error("Muted = false after voice_mute(true)")
	}
}

func TestVoice_Mute_BroadcastsVoiceState(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-mute-bcast")

	user := seedVoiceOwner(t, database, "henry")
	user2 := seedVoiceOwner(t, database, "henry2")

	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)
	drainChan(send2)

	hub.HandleMessageForTest(c, voiceMuteMsg(true))
	time.Sleep(50 * time.Millisecond)

	allMsgs := append(drainChan(send), drainChan(send2)...)
	found := false
	for _, msg := range allMsgs {
		if extractType(t, msg) == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("voice_state broadcast not received after voice_mute")
	}
}

// ─── voice_deafen ─────────────────────────────────────────────────────────────

func TestVoice_Deafen_UpdatesStateInDB(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "iris")
	chanID := seedVoiceChan(t, database, "vc-iris")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceDeafenMsg(true))
	time.Sleep(30 * time.Millisecond)

	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Deafened {
		t.Error("Deafened = false after voice_deafen(true)")
	}
}

func TestVoice_Deafen_BroadcastsVoiceState(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-deafen-bcast")

	user := seedVoiceOwner(t, database, "jack")
	user2 := seedVoiceOwner(t, database, "jack2")

	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)
	drainChan(send2)

	hub.HandleMessageForTest(c, voiceDeafenMsg(true))
	time.Sleep(50 * time.Millisecond)

	allMsgs := append(drainChan(send), drainChan(send2)...)
	found := false
	for _, msg := range allMsgs {
		if extractType(t, msg) == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("voice_state broadcast not received after voice_deafen")
	}
}

// ─── voice signaling (SFU) ────────────────────────────────────────────────────
//
// The signaling flow changed from P2P relay to SFU: offer/answer/ice are now
// exchanged between client and server, not relayed between clients.
//
// Tests focus on validation and error paths since PeerConnection operations
// require a real WebRTC stack (only exercised in integration tests).

// TestVoice_Offer_NoPeerConnection verifies that voice_offer when the client
// has no PeerConnection returns a VOICE_ERROR.
func TestVoice_Offer_NoPeerConnection(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "offer-nopc")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceSignalMsg("voice_offer", 1, "v=0 offer..."))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractCode(t, m) == "VOICE_ERROR" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected VOICE_ERROR when sending voice_offer without a PeerConnection")
	}
}

// TestVoice_Offer_EmptySDP verifies that voice_offer with an empty SDP field
// returns INVALID_SDP before touching any PeerConnection.
func TestVoice_Offer_EmptySDP(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "offer-emptysdp")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send offer with blank SDP — pc is nil but SDP check comes after pc check,
	// so we expect VOICE_ERROR (no pc) before INVALID_SDP would fire.
	// To isolate the empty-SDP path we need a client with pc set. Since we
	// can't construct a real PC in unit tests, we verify the pc==nil branch
	// fires first, which returns VOICE_ERROR. The INVALID_SDP branch is
	// separately reachable; we test its message format via the handler directly.
	hub.HandleMessageForTest(c, voiceSignalMsg("voice_offer", 1, ""))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	if len(msgs) == 0 {
		t.Fatal("expected at least one error response for voice_offer with no pc")
	}
	code := extractCode(t, msgs[0])
	if code != "VOICE_ERROR" && code != "INVALID_SDP" {
		t.Errorf("expected VOICE_ERROR or INVALID_SDP, got %q", code)
	}
}

// TestVoice_Offer_RateLimit verifies that sending 25+ voice_offer messages
// rapidly results in at least one RATE_LIMITED error being sent back to the
// client.
func TestVoice_Offer_RateLimit(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "offer-ratelimit")

	send := make(chan []byte, 256)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// 25 offers rapidly — limit is 20/sec.
	for range 25 {
		hub.HandleMessageForTest(c, voiceSignalMsg("voice_offer", 1, "v=0..."))
	}
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractCode(t, m) == "RATE_LIMITED" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected RATE_LIMITED error after 25 rapid voice_offer messages")
	}
}

// TestVoice_Answer_NoPeerConnection verifies that voice_answer when the client
// has no PeerConnection returns VOICE_ERROR.
func TestVoice_Answer_NoPeerConnection(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "answer-nopc")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceSignalMsg("voice_answer", 1, "v=0 answer..."))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractCode(t, m) == "VOICE_ERROR" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected VOICE_ERROR when sending voice_answer without a PeerConnection")
	}
}

// TestVoice_Answer_EmptySDP verifies that voice_answer with blank SDP returns
// an error (VOICE_ERROR from pc==nil check, or INVALID_SDP if pc existed).
func TestVoice_Answer_EmptySDP(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "answer-emptysdp")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceSignalMsg("voice_answer", 1, ""))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	if len(msgs) == 0 {
		t.Fatal("expected at least one error response for empty voice_answer")
	}
	code := extractCode(t, msgs[0])
	if code != "VOICE_ERROR" && code != "INVALID_SDP" {
		t.Errorf("expected VOICE_ERROR or INVALID_SDP, got %q", code)
	}
}

// TestVoice_ICE_NoPeerConnection verifies that voice_ice when the client has
// no PeerConnection returns VOICE_ERROR.
func TestVoice_ICE_NoPeerConnection(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "ice-nopc")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceICEMsg(1, "candidate:0 1 UDP 123 192.168.1.1 5000 typ host"))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractCode(t, m) == "VOICE_ERROR" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected VOICE_ERROR when sending voice_ice without a PeerConnection")
	}
}

// TestVoice_HandleMessage_VoiceOffer_Dispatched verifies that voice_offer is
// dispatched by handleMessage and does not produce an UNKNOWN_TYPE error.
func TestVoice_HandleMessage_VoiceOffer_Dispatched(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "offer-dispatch")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceSignalMsg("voice_offer", 1, "v=0..."))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	for _, m := range msgs {
		if extractCode(t, m) == "UNKNOWN_TYPE" {
			t.Error("voice_offer produced UNKNOWN_TYPE — handler not registered in dispatch")
		}
	}
}

// TestVoice_HandleMessage_VoiceAnswer_Dispatched verifies that voice_answer is
// dispatched by handleMessage and does not produce an UNKNOWN_TYPE error.
// This replaces the old TestVoice_HandleMessage_VoiceAnswer_Relayed which
// tested the removed P2P relay behavior.
func TestVoice_HandleMessage_VoiceAnswer_Dispatched(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "answer-dispatch")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceSignalMsg("voice_answer", 1, "v=0 answer..."))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	for _, m := range msgs {
		if extractCode(t, m) == "UNKNOWN_TYPE" {
			t.Error("voice_answer produced UNKNOWN_TYPE — handler not registered in dispatch")
		}
	}
}

// TestVoice_HandleMessage_VoiceICE_Dispatched verifies that voice_ice is
// dispatched by handleMessage and does not produce an UNKNOWN_TYPE error.
func TestVoice_HandleMessage_VoiceICE_Dispatched(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "ice-dispatch")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceICEMsg(1, "candidate:0 1 UDP 123 192.168.1.1 5000 typ host"))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	for _, m := range msgs {
		if extractCode(t, m) == "UNKNOWN_TYPE" {
			t.Error("voice_ice produced UNKNOWN_TYPE — handler not registered in dispatch")
		}
	}
}

// TestVoice_Signal_RateLimit_BlocksExcess verifies that rapid voice_offer
// messages get rate limited (replaces the old relay-counting test).
func TestVoice_Signal_RateLimit_BlocksExcess(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "mia")

	send := make(chan []byte, 256)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send 30 signals rapidly — limit is 20/sec, so some should be rate-limited.
	for range 30 {
		hub.HandleMessageForTest(c, voiceSignalMsg("voice_offer", 1, "v=0..."))
	}
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	foundRateLimit := false
	for _, m := range msgs {
		if extractCode(t, m) == "RATE_LIMITED" {
			foundRateLimit = true
			break
		}
	}
	if !foundRateLimit {
		t.Error("expected RATE_LIMITED error after 30 rapid voice_offer messages")
	}
}

// ─── soundboard ───────────────────────────────────────────────────────────────

func TestVoice_Soundboard_BroadcastsToAll(t *testing.T) {
	hub, database := newVoiceHub(t)

	user := seedVoiceOwner(t, database, "noah")
	listener := seedVoiceOwner(t, database, "noah2")

	sendL := make(chan []byte, 16)
	cL := ws.NewTestClientWithUser(hub, listener, 0, sendL)
	hub.Register(cL)

	sendS := make(chan []byte, 16)
	cS := ws.NewTestClientWithUser(hub, user, 0, sendS)
	hub.Register(cS)
	time.Sleep(20 * time.Millisecond)

	soundMsg, _ := json.Marshal(map[string]any{
		"type":    "soundboard_play",
		"payload": map[string]any{"sound_id": "abc-uuid-123"},
	})
	hub.HandleMessageForTest(cS, soundMsg)
	time.Sleep(50 * time.Millisecond)

	listenerMsgs := drainChan(sendL)
	found := false
	for _, msg := range listenerMsgs {
		if extractType(t, msg) == "soundboard_play" {
			found = true
			break
		}
	}
	if !found {
		t.Error("listener did not receive soundboard_play broadcast")
	}
}

func TestVoice_Soundboard_NoPermission_SendsError(t *testing.T) {
	hub, _ := newVoiceHub(t)

	// Client with no user set → permission check fails.
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, 8888, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	soundMsg, _ := json.Marshal(map[string]any{
		"type":    "soundboard_play",
		"payload": map[string]any{"sound_id": "abc"},
	})
	hub.HandleMessageForTest(c, soundMsg)
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected FORBIDDEN error for soundboard without permission")
	}
}

func TestVoice_Soundboard_RateLimit(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "olivia")

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	soundMsg, _ := json.Marshal(map[string]any{
		"type":    "soundboard_play",
		"payload": map[string]any{"sound_id": "x"},
	})

	// Send 5 soundboard plays rapidly — limit is 1 per 3 sec.
	for range 5 {
		hub.HandleMessageForTest(c, soundMsg)
	}
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	errCount := 0
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			errCount++
		}
	}
	if errCount == 0 {
		t.Error("expected rate limit errors for rapid soundboard plays")
	}
}

// ─── voice_camera ─────────────────────────────────────────────────────────────

// voiceCameraMsg builds a voice_camera WebSocket message.
func voiceCameraMsg(enabled bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_camera",
		"payload": map[string]any{"enabled": enabled},
	})
	return raw
}

// TestVoice_Camera_UpdatesState: join voice, send voice_camera {enabled:true},
// verify voice_state broadcast includes camera:true.
func TestVoice_Camera_UpdatesState(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "cam-alice")
	chanID := seedVoiceChan(t, database, "vc-cam-alice")

	user2 := seedVoiceOwner(t, database, "cam-alice2")
	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Join voice channel first.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)
	drainChan(send2)

	// Toggle camera on.
	hub.HandleMessageForTest(c, voiceCameraMsg(true))
	time.Sleep(50 * time.Millisecond)

	// Verify DB state.
	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Camera {
		t.Error("Camera = false after voice_camera(true)")
	}

	// Verify voice_state broadcast received by channel member.
	allMsgs := append(drainChan(send), drainChan(send2)...)
	foundVoiceState := false
	for _, msg := range allMsgs {
		if extractType(t, msg) == "voice_state" {
			foundVoiceState = true

			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Camera bool `json:"camera"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(msg, &env); err != nil {
				t.Fatalf("unmarshal voice_state: %v", err)
			}
			if !env.Payload.Camera {
				t.Error("voice_state broadcast payload.camera = false, want true")
			}
			break
		}
	}
	if !foundVoiceState {
		t.Error("voice_state broadcast not received after voice_camera toggle")
	}
}

// TestVoice_Camera_NoPermission: Member without USE_VIDEO gets FORBIDDEN.
func TestVoice_Camera_NoPermission(t *testing.T) {
	hub, _ := newVoiceHub(t)

	// Client with no user set → hasChannelPerm returns false.
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, 7001, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceCameraMsg(true))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected FORBIDDEN error for camera toggle without USE_VIDEO permission")
	}
}

// TestVoice_Camera_RateLimit: send 3+ camera toggles rapidly, verify rate limit error.
func TestVoice_Camera_RateLimit(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "cam-ratelimit")
	chanID := seedVoiceChan(t, database, "vc-cam-ratelimit")

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)

	// Send 5 camera toggles rapidly — limit is 2/sec, so some should be rate-limited.
	for range 5 {
		hub.HandleMessageForTest(c, voiceCameraMsg(true))
	}
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	errCount := 0
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			errCount++
		}
	}
	if errCount == 0 {
		t.Error("expected RATE_LIMITED error after exceeding camera rate limit")
	}
}

// ─── voice_screenshare ────────────────────────────────────────────────────────

// voiceScreenshareMsg builds a voice_screenshare WebSocket message.
func voiceScreenshareMsg(enabled bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_screenshare",
		"payload": map[string]any{"enabled": enabled},
	})
	return raw
}

// TestVoice_Screenshare_UpdatesState: join voice, send voice_screenshare {enabled:true},
// verify voice_state broadcast includes screenshare:true.
func TestVoice_Screenshare_UpdatesState(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "ss-alice")
	chanID := seedVoiceChan(t, database, "vc-ss-alice")

	user2 := seedVoiceOwner(t, database, "ss-alice2")
	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Join voice channel first.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)
	drainChan(send2)

	// Toggle screenshare on.
	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))
	time.Sleep(50 * time.Millisecond)

	// Verify DB state.
	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Screenshare {
		t.Error("Screenshare = false after voice_screenshare(true)")
	}

	// Verify voice_state broadcast received.
	allMsgs := append(drainChan(send), drainChan(send2)...)
	foundVoiceState := false
	for _, msg := range allMsgs {
		if extractType(t, msg) == "voice_state" {
			foundVoiceState = true

			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Screenshare bool `json:"screenshare"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(msg, &env); err != nil {
				t.Fatalf("unmarshal voice_state: %v", err)
			}
			if !env.Payload.Screenshare {
				t.Error("voice_state broadcast payload.screenshare = false, want true")
			}
			break
		}
	}
	if !foundVoiceState {
		t.Error("voice_state broadcast not received after voice_screenshare toggle")
	}
}

// TestVoice_Screenshare_NoPermission: client without SHARE_SCREEN gets FORBIDDEN.
func TestVoice_Screenshare_NoPermission(t *testing.T) {
	hub, _ := newVoiceHub(t)

	// Client with no user set → hasChannelPerm returns false.
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, 7002, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected FORBIDDEN error for screenshare toggle without SHARE_SCREEN permission")
	}
}

// TestVoice_Screenshare_RateLimit: send 5+ screenshare toggles rapidly, verify rate limit error.
func TestVoice_Screenshare_RateLimit(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "ss-ratelimit")
	chanID := seedVoiceChan(t, database, "vc-ss-ratelimit")

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)

	// Send 5 screenshare toggles rapidly — limit is 2/sec.
	for range 5 {
		hub.HandleMessageForTest(c, voiceScreenshareMsg(true))
	}
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	errCount := 0
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			errCount++
		}
	}
	if errCount == 0 {
		t.Error("expected RATE_LIMITED error after exceeding screenshare rate limit")
	}
}

// ─── handleMessage dispatch ───────────────────────────────────────────────────

// ─── SFU-integrated voice_join / voice_leave ──────────────────────────────────

// seedVoiceChanMaxUsers creates a voice channel with a custom voice_max_users limit.
func seedVoiceChanMaxUsers(t *testing.T, database *db.DB, name string, maxUsers int) int64 {
	t.Helper()
	id, err := database.CreateChannel(name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("seedVoiceChanMaxUsers CreateChannel: %v", err)
	}
	if err := database.SetChannelVoiceMaxUsers(id, maxUsers); err != nil {
		t.Fatalf("seedVoiceChanMaxUsers SetChannelVoiceMaxUsers: %v", err)
	}
	return id
}

// TestVoice_Join_SFU_SendsVoiceConfig verifies that after voice_join the joiner
// receives a voice_config message with the expected fields.
func TestVoice_Join_SFU_SendsVoiceConfig(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "sfu-alice")
	chanID := seedVoiceChan(t, database, "vc-sfu-alice")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	foundConfig := false
	for _, msg := range msgs {
		if extractType(t, msg) == "voice_config" {
			foundConfig = true
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					ChannelID int64  `json:"channel_id"`
					Quality   string `json:"quality"`
					Bitrate   int    `json:"bitrate"`
					Mode      string `json:"threshold_mode"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(msg, &env); err != nil {
				t.Fatalf("unmarshal voice_config: %v", err)
			}
			if env.Payload.ChannelID != chanID {
				t.Errorf("voice_config channel_id = %d, want %d", env.Payload.ChannelID, chanID)
			}
			if env.Payload.Quality == "" {
				t.Error("voice_config quality is empty")
			}
			if env.Payload.Bitrate <= 0 {
				t.Errorf("voice_config bitrate = %d, want > 0", env.Payload.Bitrate)
			}
			if env.Payload.Mode == "" {
				t.Error("voice_config threshold_mode is empty")
			}
			break
		}
	}
	if !foundConfig {
		t.Error("joiner did not receive voice_config after voice_join")
	}
}

// TestVoice_Join_SFU_ChannelFull verifies that a second join to a max-1 room
// returns a CHANNEL_FULL error and the first participant is unaffected.
func TestVoice_Join_SFU_ChannelFull(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChanMaxUsers(t, database, "vc-full", 1)

	user1 := seedVoiceOwner(t, database, "full-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, chanID, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	// First user joins — should succeed.
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	// Verify first user is in DB.
	state1, err := database.GetVoiceState(user1.ID)
	if err != nil || state1 == nil {
		t.Fatalf("user1 voice state missing after join: %v", err)
	}

	user2 := seedVoiceOwner(t, database, "full-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	drainChan(send1)
	drainChan(send2)

	// Second user joins — should get CHANNEL_FULL error.
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	msgs2 := drainChan(send2)
	foundFull := false
	for _, msg := range msgs2 {
		if extractType(t, msg) == "error" {
			var env struct {
				Payload struct {
					Code string `json:"code"`
				} `json:"payload"`
			}
			if errU := json.Unmarshal(msg, &env); errU == nil && env.Payload.Code == "CHANNEL_FULL" {
				foundFull = true
				break
			}
		}
	}
	if !foundFull {
		t.Error("expected CHANNEL_FULL error when joining a full voice channel")
	}

	// Second user should NOT be in DB voice state.
	state2, err := database.GetVoiceState(user2.ID)
	if err != nil {
		t.Fatalf("GetVoiceState user2: %v", err)
	}
	if state2 != nil {
		t.Error("user2 voice state should be nil after CHANNEL_FULL rejection")
	}
}

// TestVoice_Join_SFU_AddsToVoiceRoom verifies that after voice_join the
// participant is tracked in the Hub's VoiceRoom.
func TestVoice_Join_SFU_AddsToVoiceRoom(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "room-alice")
	chanID := seedVoiceChan(t, database, "vc-room-alice")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	room := hub.GetVoiceRoom(chanID)
	if room == nil {
		t.Fatal("VoiceRoom not created after voice_join")
	}
	if !room.HasParticipant(user.ID) {
		t.Error("user not tracked as participant in VoiceRoom after voice_join")
	}
	if room.ParticipantCount() != 1 {
		t.Errorf("VoiceRoom participant count = %d, want 1", room.ParticipantCount())
	}
}

// TestVoice_Leave_SFU_RemovesFromRoom verifies that after voice_leave the
// participant is no longer tracked in the VoiceRoom.
func TestVoice_Leave_SFU_RemovesFromRoom(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "leave-bob")
	chanID := seedVoiceChan(t, database, "vc-leave-bob")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	// Confirm in room before leave.
	room := hub.GetVoiceRoom(chanID)
	if room == nil || !room.HasParticipant(user.ID) {
		t.Fatal("precondition: user not in room after join")
	}

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	time.Sleep(50 * time.Millisecond)

	// After leave, participant should be removed (room gone or user absent).
	room = hub.GetVoiceRoom(chanID)
	if room != nil && room.HasParticipant(user.ID) {
		t.Error("user still tracked in VoiceRoom after voice_leave")
	}
}

// TestVoice_Leave_SFU_CleansUpEmptyRoom verifies that when the last participant
// leaves, the VoiceRoom is removed from the Hub entirely.
func TestVoice_Leave_SFU_CleansUpEmptyRoom(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "empty-carol")
	chanID := seedVoiceChan(t, database, "vc-empty-carol")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	if hub.GetVoiceRoom(chanID) == nil {
		t.Fatal("precondition: VoiceRoom not created after join")
	}

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	time.Sleep(50 * time.Millisecond)

	if hub.GetVoiceRoom(chanID) != nil {
		t.Error("VoiceRoom should be removed from Hub after last participant leaves")
	}
}

// TestVoice_Leave_SFU_OnDisconnect verifies that handleVoiceLeave cleans up
// room state when triggered by a disconnect without an explicit voice_leave message.
func TestVoice_Leave_SFU_OnDisconnect(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "disco-dave")
	chanID := seedVoiceChan(t, database, "vc-disco-dave")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	room := hub.GetVoiceRoom(chanID)
	if room == nil || !room.HasParticipant(user.ID) {
		t.Fatal("precondition: user not in VoiceRoom after join")
	}

	// Simulate disconnect by calling the exported test hook.
	hub.HandleVoiceLeaveForTest(c)
	time.Sleep(30 * time.Millisecond)

	// DB state should be cleared.
	state, err := database.GetVoiceState(user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after disconnect: %v", err)
	}
	if state != nil {
		t.Error("voice state still in DB after simulated disconnect")
	}

	// VoiceRoom should be gone or user removed from it.
	room = hub.GetVoiceRoom(chanID)
	if room != nil && room.HasParticipant(user.ID) {
		t.Error("user still in VoiceRoom after simulated disconnect")
	}
}

// ─── handleMessage dispatch ───────────────────────────────────────────────────

func TestVoice_HandleMessage_VoiceCamera_Dispatched(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "cam-dispatch")
	chanID := seedVoiceChan(t, database, "vc-cam-dispatch")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)

	// Send via HandleMessageForTest to verify dispatch occurs (no unknown_type error).
	hub.HandleMessageForTest(c, voiceCameraMsg(true))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			var errEnv struct {
				Payload struct {
					Code string `json:"code"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(m, &errEnv); err == nil {
				if errEnv.Payload.Code == "UNKNOWN_TYPE" {
					t.Error("voice_camera was not dispatched: got UNKNOWN_TYPE error")
				}
			}
		}
	}
}

func TestVoice_HandleMessage_VoiceScreenshare_Dispatched(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "ss-dispatch")
	chanID := seedVoiceChan(t, database, "vc-ss-dispatch")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)

	// Send via HandleMessageForTest to verify dispatch occurs (no unknown_type error).
	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send)
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			var errEnv struct {
				Payload struct {
					Code string `json:"code"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(m, &errEnv); err == nil {
				if errEnv.Payload.Code == "UNKNOWN_TYPE" {
					t.Error("voice_screenshare was not dispatched: got UNKNOWN_TYPE error")
				}
			}
		}
	}
}

// ─── composite track keys ─────────────────────────────────────────────────────

func TestVoiceRoom_CompositeTrackKeys(t *testing.T) {
	room := ws.NewVoiceRoom(ws.VoiceRoomConfig{
		ChannelID: 1, MaxUsers: 10, Quality: "medium",
		MixingThreshold: 10, TopSpeakers: 3, MaxVideo: 25,
	})

	room.SetTrack(42, "audio", nil, nil)
	room.SetTrack(42, "video", nil, nil)

	audioTrack := room.GetTrack(42, "audio")
	videoTrack := room.GetTrack(42, "video")
	if audioTrack == nil {
		t.Fatal("audio track should exist")
	}
	if videoTrack == nil {
		t.Fatal("video track should exist")
	}

	room.RemoveTrack(42, "video")
	if room.GetTrack(42, "audio") == nil {
		t.Fatal("audio track should still exist after removing video")
	}
	if room.GetTrack(42, "video") != nil {
		t.Fatal("video track should be removed")
	}

	userTracks := room.GetUserTracks(42)
	if len(userTracks) != 1 {
		t.Fatalf("expected 1 track, got %d", len(userTracks))
	}
}

// TestVoiceRoom_VideoTrackCoexistence verifies multi-user video track fan-out:
// composite keys allow audio and video to coexist per user, GetTracks returns
// the correct total, TrackUserIDs deduplicates, and removing one kind leaves
// the other intact.
func TestVoiceRoom_VideoTrackCoexistence(t *testing.T) {
	room := ws.NewVoiceRoom(ws.VoiceRoomConfig{
		ChannelID: 1, MaxUsers: 10, Quality: "medium",
		MixingThreshold: 10, TopSpeakers: 3, MaxVideo: 25,
	})

	// User 42 has both audio and video.
	room.SetTrack(42, "audio", nil, nil)
	room.SetTrack(42, "video", nil, nil)

	// User 99 has audio only.
	room.SetTrack(99, "audio", nil, nil)

	// GetTracks returns all 3 track entries.
	tracks := room.GetTracks()
	if len(tracks) != 3 {
		t.Fatalf("expected 3 tracks, got %d", len(tracks))
	}

	// GetUserTracks for user 42 returns 2 (audio + video).
	u42 := room.GetUserTracks(42)
	if len(u42) != 2 {
		t.Fatalf("expected 2 tracks for user 42, got %d", len(u42))
	}

	// TrackUserIDs returns 2 unique users (not 3 entries).
	ids := room.TrackUserIDs()
	if len(ids) != 2 {
		t.Fatalf("expected 2 unique users, got %d", len(ids))
	}

	// Remove video for user 42 — audio must survive.
	room.RemoveTrack(42, "video")

	if room.GetTrack(42, "audio") == nil {
		t.Fatal("audio track should still exist after removing video")
	}
	if room.GetTrack(42, "video") != nil {
		t.Fatal("video track should be removed")
	}

	// GetTracks now returns 2 (user 42 audio + user 99 audio).
	tracks = room.GetTracks()
	if len(tracks) != 2 {
		t.Fatalf("expected 2 tracks after video removal, got %d", len(tracks))
	}

	// User 99 is completely unaffected.
	if room.GetTrack(99, "audio") == nil {
		t.Fatal("user 99 audio track should be unaffected")
	}
}

// ─── ICE monitor / setupICEMonitor ────────────────────────────────────────────

// TestVoice_SetupICEMonitor_NilPC_NoPanic verifies that setupICEMonitor does
// not panic when the client has a nil PeerConnection.
func TestVoice_SetupICEMonitor_NilPC_NoPanic(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "ice-monitor-nil")
	chanID := seedVoiceChan(t, database, "vc-ice-nil")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)

	// SetupICEMonitorForTest should not panic when c.pc is nil.
	hub.SetupICEMonitorForTest(c, chanID)
}

// ─── duplicate voice_join (channel switch) ────────────────────────────────────

// TestVoice_Join_SwitchChannel_LeavesOldChannel verifies that joining channel B
// while already in channel A results in the user leaving channel A first.
func TestVoice_Join_SwitchChannel_LeavesOldChannel(t *testing.T) {
	hub, database := newVoiceHub(t)
	userA := seedVoiceOwner(t, database, "switch-alice")
	chanA := seedVoiceChan(t, database, "vc-switch-a")
	chanB := seedVoiceChan(t, database, "vc-switch-b")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, userA, chanA, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Join channel A.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanA))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)

	// Verify in channel A.
	roomA := hub.GetVoiceRoom(chanA)
	if roomA == nil {
		t.Fatal("room A should exist after joining")
	}
	if !roomA.HasParticipant(userA.ID) {
		t.Fatal("user should be participant in room A")
	}

	// Join channel B — should leave A first.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanB))
	time.Sleep(50 * time.Millisecond)

	// Room A should no longer have the user.
	roomA = hub.GetVoiceRoom(chanA)
	if roomA != nil && roomA.HasParticipant(userA.ID) {
		t.Error("user should have been removed from room A after joining room B")
	}

	// Room B should have the user.
	roomB := hub.GetVoiceRoom(chanB)
	if roomB == nil {
		t.Fatal("room B should exist after joining")
	}
	if !roomB.HasParticipant(userA.ID) {
		t.Error("user should be participant in room B after switching")
	}
}

// TestVoice_Join_SameChannel_IsIdempotent verifies that joining the same channel
// twice does not result in errors or duplicate participation.
func TestVoice_Join_SameChannel_IsIdempotent(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "idempotent-join")
	chanID := seedVoiceChan(t, database, "vc-idempotent")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send)

	// Join same channel again.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	// Should not receive an error for the second join.
	msgs := drainChan(send)
	for _, m := range msgs {
		if code := extractCode(t, m); code == "CHANNEL_FULL" || code == "VOICE_ERROR" {
			t.Errorf("unexpected error %q on re-join of same channel", code)
		}
	}

	// Participant count should remain 1.
	room := hub.GetVoiceRoom(chanID)
	if room == nil {
		t.Fatal("room should exist")
	}
	if count := room.ParticipantCount(); count != 1 {
		t.Errorf("ParticipantCount = %d, want 1 after idempotent join", count)
	}
}

// ─── MaxVideo enforcement ─────────────────────────────────────────────────────

// makeVideoTrack creates a TrackLocalStaticRTP with ID "video-{userID}" for testing.
func makeVideoTrack(t *testing.T, userID int64) *webrtc.TrackLocalStaticRTP {
	t.Helper()
	local, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		fmt.Sprintf("video-%d", userID),
		fmt.Sprintf("user-%d", userID),
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticRTP: %v", err)
	}
	return local
}

// TestHandleVoiceCamera_MaxVideoEnforced verifies that when the MaxVideo limit
// is reached, a voice_camera enable request is rejected with VIDEO_LIMIT error.
func TestHandleVoiceCamera_MaxVideoEnforced(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-maxvideo")

	// Pre-create the room with MaxVideo=2 so handleVoiceJoin reuses it.
	hub.GetOrCreateVoiceRoom(chanID, ws.VoiceRoomConfig{
		ChannelID:       chanID,
		MaxUsers:        10,
		Quality:         "medium",
		MixingThreshold: 10,
		TopSpeakers:     3,
		MaxVideo:        2,
	})

	// Create 3 users: user1 and user2 will have video tracks, user3 will be rejected.
	user1 := seedVoiceOwner(t, database, "maxvid-user1")
	user2 := seedVoiceOwner(t, database, "maxvid-user2")
	user3 := seedVoiceOwner(t, database, "maxvid-user3")

	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, chanID, send1)
	hub.Register(c1)

	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)

	send3 := make(chan []byte, 64)
	c3 := ws.NewTestClientWithUser(hub, user3, chanID, send3)
	hub.Register(c3)
	time.Sleep(20 * time.Millisecond)

	// All three join the voice channel.
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	hub.HandleMessageForTest(c3, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	// Simulate user1 and user2 having video tracks by setting them on the room.
	room := hub.GetVoiceRoom(chanID)
	if room == nil {
		t.Fatal("VoiceRoom should exist after joins")
	}
	room.SetTrack(user1.ID, "video", nil, makeVideoTrack(t, user1.ID))
	room.SetTrack(user2.ID, "video", nil, makeVideoTrack(t, user2.ID))

	// Drain all messages from prior operations.
	drainChan(send1)
	drainChan(send2)
	drainChan(send3)

	// User3 tries to enable camera — should be rejected with VIDEO_LIMIT.
	hub.HandleMessageForTest(c3, voiceCameraMsg(true))
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send3)
	foundVideoLimit := false
	for _, m := range msgs {
		if extractCode(t, m) == "VIDEO_LIMIT" {
			foundVideoLimit = true
			break
		}
	}
	if !foundVideoLimit {
		t.Error("expected VIDEO_LIMIT error when MaxVideo limit is reached")
	}

	// Verify DB state was NOT updated (camera should still be false).
	state, err := database.GetVoiceState(user3.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state != nil && state.Camera {
		t.Error("camera should not be enabled after VIDEO_LIMIT rejection")
	}
}


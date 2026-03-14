package ws_test

import (
	"encoding/json"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// voiceSchema extends hubTestSchema with the voice_states table.
var voiceSchema = append(hubTestSchema, []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted      INTEGER NOT NULL DEFAULT 0,
    deafened   INTEGER NOT NULL DEFAULT 0,
    speaking   INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now'))
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
	t.Cleanup(func() { database.Close() })

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
	raw, _ := json.Marshal(map[string]interface{}{
		"type":    "voice_join",
		"payload": map[string]interface{}{"channel_id": channelID},
	})
	return raw
}

// voiceLeaveMsg builds a raw voice_leave WebSocket message.
func voiceLeaveMsg() []byte {
	raw, _ := json.Marshal(map[string]interface{}{
		"type":    "voice_leave",
		"payload": map[string]interface{}{},
	})
	return raw
}

// voiceMuteMsg builds a voice_mute message.
func voiceMuteMsg(muted bool) []byte {
	raw, _ := json.Marshal(map[string]interface{}{
		"type":    "voice_mute",
		"payload": map[string]interface{}{"muted": muted},
	})
	return raw
}

// voiceDeafenMsg builds a voice_deafen message.
func voiceDeafenMsg(deafened bool) []byte {
	raw, _ := json.Marshal(map[string]interface{}{
		"type":    "voice_deafen",
		"payload": map[string]interface{}{"deafened": deafened},
	})
	return raw
}

// voiceSignalMsg builds a voice_offer/answer/ice message.
func voiceSignalMsg(msgType string, channelID int64, sdp string) []byte {
	raw, _ := json.Marshal(map[string]interface{}{
		"type": msgType,
		"payload": map[string]interface{}{
			"channel_id": channelID,
			"sdp":        sdp,
		},
	})
	return raw
}

// voiceICEMsg builds a voice_ice message.
func voiceICEMsg(channelID int64, candidate string) []byte {
	raw, _ := json.Marshal(map[string]interface{}{
		"type": "voice_ice",
		"payload": map[string]interface{}{
			"channel_id": channelID,
			"candidate":  candidate,
		},
	})
	return raw
}

// extractType parses a JSON message and returns the "type" field.
func extractType(t *testing.T, msg []byte) string {
	t.Helper()
	var env map[string]interface{}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("extractType unmarshal: %v", err)
	}
	typ, _ := env["type"].(string)
	return typ
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

	badMsg, _ := json.Marshal(map[string]interface{}{
		"type":    "voice_join",
		"payload": map[string]interface{}{"channel_id": 0},
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

	// Member role (id=4) has permissions 1049089. Bit 9 (0x200 = 512) for CONNECT_VOICE.
	// Check if member has it: 1049089 & 512 = 512, so member DOES have it.
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

// ─── voice signaling relay ────────────────────────────────────────────────────

func TestVoice_Signal_RelaysToOtherChannelMembers(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-signal")

	sender := seedVoiceOwner(t, database, "kate")
	receiver := seedVoiceOwner(t, database, "kate2")
	outsider := seedVoiceOwner(t, database, "kate3")

	sendR := make(chan []byte, 16)
	cR := ws.NewTestClientWithUser(hub, receiver, chanID, sendR)
	hub.Register(cR)

	sendO := make(chan []byte, 16)
	cO := ws.NewTestClientWithUser(hub, outsider, 999, sendO) // different channel
	hub.Register(cO)

	sendS := make(chan []byte, 16)
	cS := ws.NewTestClientWithUser(hub, sender, chanID, sendS)
	hub.Register(cS)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cS, voiceSignalMsg("voice_offer", chanID, "v=0..."))
	time.Sleep(50 * time.Millisecond)

	// Receiver in same channel should get the signal.
	receiverMsgs := drainChan(sendR)
	found := false
	for _, msg := range receiverMsgs {
		if extractType(t, msg) == "voice_offer" {
			found = true
			break
		}
	}
	if !found {
		t.Error("receiver in channel did not receive voice_offer relay")
	}

	// Outsider in different channel should NOT get it.
	outsiderMsgs := drainChan(sendO)
	for _, msg := range outsiderMsgs {
		if extractType(t, msg) == "voice_offer" {
			t.Error("outsider received voice_offer, should not have")
		}
	}

	// Sender should NOT receive their own signal.
	senderMsgs := drainChan(sendS)
	for _, msg := range senderMsgs {
		if extractType(t, msg) == "voice_offer" {
			t.Error("sender received their own voice_offer, should not have")
		}
	}
}

func TestVoice_Signal_ICERelayed(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-ice")

	sender := seedVoiceOwner(t, database, "leo")
	receiver := seedVoiceOwner(t, database, "leo2")

	sendR := make(chan []byte, 16)
	cR := ws.NewTestClientWithUser(hub, receiver, chanID, sendR)
	hub.Register(cR)

	sendS := make(chan []byte, 16)
	cS := ws.NewTestClientWithUser(hub, sender, chanID, sendS)
	hub.Register(cS)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cS, voiceICEMsg(chanID, "candidate:..."))
	time.Sleep(50 * time.Millisecond)

	receiverMsgs := drainChan(sendR)
	found := false
	for _, msg := range receiverMsgs {
		if extractType(t, msg) == "voice_ice" {
			found = true
			break
		}
	}
	if !found {
		t.Error("receiver did not receive relayed voice_ice")
	}
}

func TestVoice_Signal_RateLimit_BlocksExcess(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-ratelimit")

	sender := seedVoiceOwner(t, database, "mia")
	receiver := seedVoiceOwner(t, database, "mia2")

	sendR := make(chan []byte, 256)
	cR := ws.NewTestClientWithUser(hub, receiver, chanID, sendR)
	hub.Register(cR)

	sendS := make(chan []byte, 256)
	cS := ws.NewTestClientWithUser(hub, sender, chanID, sendS)
	hub.Register(cS)
	time.Sleep(20 * time.Millisecond)

	// Send 30 signals rapidly — limit is 20/sec, so some should be dropped.
	for i := 0; i < 30; i++ {
		hub.HandleMessageForTest(cS, voiceSignalMsg("voice_offer", chanID, "v=0..."))
	}
	time.Sleep(50 * time.Millisecond)

	receivedCount := len(drainChan(sendR))
	if receivedCount >= 30 {
		t.Errorf("received %d signals, expected fewer due to rate limit", receivedCount)
	}

	// Sender should receive at least one RATE_LIMITED error.
	senderMsgs := drainChan(sendS)
	foundError := false
	for _, msg := range senderMsgs {
		if extractType(t, msg) == "error" {
			foundError = true
			break
		}
	}
	if !foundError {
		t.Error("expected RATE_LIMITED error to sender after exceeding signal rate limit")
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

	soundMsg, _ := json.Marshal(map[string]interface{}{
		"type":    "soundboard_play",
		"payload": map[string]interface{}{"sound_id": "abc-uuid-123"},
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

	soundMsg, _ := json.Marshal(map[string]interface{}{
		"type":    "soundboard_play",
		"payload": map[string]interface{}{"sound_id": "abc"},
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

	soundMsg, _ := json.Marshal(map[string]interface{}{
		"type":    "soundboard_play",
		"payload": map[string]interface{}{"sound_id": "x"},
	})

	// Send 5 soundboard plays rapidly — limit is 1 per 3 sec.
	for i := 0; i < 5; i++ {
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

// ─── handleMessage dispatch ───────────────────────────────────────────────────

func TestVoice_HandleMessage_VoiceAnswer_Relayed(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-answer")

	sender := seedVoiceOwner(t, database, "pedro")
	receiver := seedVoiceOwner(t, database, "pedro2")

	sendR := make(chan []byte, 16)
	cR := ws.NewTestClientWithUser(hub, receiver, chanID, sendR)
	hub.Register(cR)

	sendS := make(chan []byte, 16)
	cS := ws.NewTestClientWithUser(hub, sender, chanID, sendS)
	hub.Register(cS)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cS, voiceSignalMsg("voice_answer", chanID, "v=0 answer..."))
	time.Sleep(50 * time.Millisecond)

	receiverMsgs := drainChan(sendR)
	found := false
	for _, msg := range receiverMsgs {
		if extractType(t, msg) == "voice_answer" {
			found = true
			break
		}
	}
	if !found {
		t.Error("receiver did not receive relayed voice_answer")
	}
}

package ws_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
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
    server_muted    INTEGER NOT NULL DEFAULT 0,
    server_deafened INTEGER NOT NULL DEFAULT 0,
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
// It injects a test LiveKit client so voice_join passes the livekit!=nil guard.
func newVoiceHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openVoiceTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter, nil)

	// Inject a test LiveKit client with non-default credentials.
	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-12345",
		LiveKitAPISecret: "test-api-secret-67890abcdef",
		LiveKitURL:       "ws://localhost:7880",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub.SetLiveKit(lk)

	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// seedVoiceOwner inserts an Owner-role user for permission-passing tests.
func seedVoiceOwner(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(context.Background(), username, "hash", 1) // roleID=1 → Owner
	if err != nil {
		t.Fatalf("seedVoiceOwner CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("seedVoiceOwner GetUserByUsername: %v", err)
	}
	return user
}

// seedVoiceChan creates a voice-type channel.
func seedVoiceChan(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	state, err := database.GetVoiceState(context.Background(), user.ID)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	// The second channel member must receive the voice_state broadcast.
	if receiveMsgOfType(send2, "voice_state", waitTimeout) == nil {
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
	waitRegistered(t, hub, c1)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))

	// Drain send1 to clear join broadcast.
	drainChanTimeout(send1, 30*time.Millisecond)

	// user2 joins — should receive voice_state for user1.
	user2 := seedVoiceOwner(t, database, "carol2")
	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)
	waitRegistered(t, hub, c2)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))

	// user2 should have received a voice_state for user1.
	msgs2 := drainChanTimeout(send2, 50*time.Millisecond)
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
	waitRegistered(t, hub, c)

	badMsg, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": 0},
	})
	hub.HandleMessageForTest(c, badMsg)

	msgs := drainChanTimeout(send, 30*time.Millisecond)
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

// TestVoice_Join_RejectsNonVoiceChannel locks the fix for v030: a voice_join
// targeting a text (or other non-voice, non-dm) channel must be refused
// before any state is persisted — hasChannelAccess only knows CONNECT_VOICE,
// not channel type, so without an explicit type check a crafted voice_join
// for a text channel would otherwise mint a LiveKit room and voice_state
// broadcast for a channel the UI can never render.
func TestVoice_Join_RejectsNonVoiceChannel(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "text-join")
	chanID, err := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	if code := receiveErrorCode(send, waitTimeout); code != "BAD_REQUEST" {
		t.Fatalf("error code = %q, want BAD_REQUEST", code)
	}
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state != nil {
		t.Error("voice_states row persisted for a voice_join against a text channel")
	}
}

func TestVoice_Join_NoPermission_SendsError(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-noperm")

	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, 9999, send) // no user set → hasChannelPerm returns false
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	msgs := drainChanTimeout(send, 30*time.Millisecond)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	hub.HandleMessageForTest(c, voiceLeaveMsg())

	state, err := database.GetVoiceState(context.Background(), user.ID)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	// Consume the join's voice_state broadcast so only the leave remains.
	if receiveMsgOfType(send2, "voice_state", waitTimeout) == nil {
		t.Fatal("no voice_state broadcast after voice_join")
	}
	drainChan(send)
	drainChan(send2)

	hub.HandleMessageForTest(c, voiceLeaveMsg())

	if receiveMsgOfType(send2, "voice_leave", waitTimeout) == nil {
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	hub.HandleMessageForTest(c, voiceMuteMsg(true))

	state, err := database.GetVoiceState(context.Background(), user.ID)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	// Consume the join's voice_state broadcast so the next one seen is the mute's.
	if receiveMsgOfType(send2, "voice_state", waitTimeout) == nil {
		t.Fatal("no voice_state broadcast after voice_join")
	}
	drainChan(send)
	drainChan(send2)

	hub.HandleMessageForTest(c, voiceMuteMsg(true))

	found := receiveMsgOfType(send2, "voice_state", waitTimeout) != nil
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	hub.HandleMessageForTest(c, voiceDeafenMsg(true))

	state, err := database.GetVoiceState(context.Background(), user.ID)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	// Consume the join's voice_state broadcast so the next one seen is the deafen's.
	if receiveMsgOfType(send2, "voice_state", waitTimeout) == nil {
		t.Fatal("no voice_state broadcast after voice_join")
	}
	drainChan(send)
	drainChan(send2)

	hub.HandleMessageForTest(c, voiceDeafenMsg(true))

	found := receiveMsgOfType(send2, "voice_state", waitTimeout) != nil
	if !found {
		t.Error("voice_state broadcast not received after voice_deafen")
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
	waitRegistered(t, hub, c)

	// Join voice channel first; consume the join's voice_state broadcast so
	// the payload check below sees the camera toggle's broadcast.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	if receiveMsgOfType(send2, "voice_state", waitTimeout) == nil {
		t.Fatal("no voice_state broadcast after voice_join")
	}
	drainChan(send)
	drainChan(send2)

	// Toggle camera on.
	hub.HandleMessageForTest(c, voiceCameraMsg(true))

	// Verify DB state.
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Camera {
		t.Error("Camera = false after voice_camera(true)")
	}

	// Verify voice_state broadcast received by channel member.
	foundVoiceState := false
	if payload := receiveMsgOfType(send2, "voice_state", waitTimeout); payload != nil {
		foundVoiceState = true
		if cam, _ := payload["camera"].(bool); !cam {
			t.Error("voice_state broadcast payload.camera = false, want true")
		}
	}
	if !foundVoiceState {
		t.Error("voice_state broadcast not received after voice_camera toggle")
	}
}

// TestVoice_Camera_DisableAllowedAfterPermissionRevoked locks the fix for
// v033: only the enable direction is gated on USE_VIDEO, mirroring
// handleVoiceMuteV2/handleVoiceDeafenV2's asymmetric gate. If disable were
// still gated too, a moderator revoking USE_VIDEO mid-call would leave
// voice_states.camera stuck at 1 — permanently burning a voice_max_video slot
// — because the user could never send a voice_camera{enabled:false} that
// passes the permission check.
func TestVoice_Camera_DisableAllowedAfterPermissionRevoked(t *testing.T) {
	hub, database := newVoiceHub(t)

	// A custom role carrying USE_VIDEO (the test schema's default Member role
	// does not, unlike production's migration 007).
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (100, 'hasvideo', NULL, ?, 5, 0)`,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.UseVideo,
	); err != nil {
		t.Fatalf("seed hasvideo role: %v", err)
	}
	user := seedVoiceUserWithRole(t, database, "cam-revoked", 100)
	chanID := seedVoiceChan(t, database, "vc-cam-revoked")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	hub.HandleMessageForTest(c, voiceCameraMsg(true))
	drainChanTimeout(send, 30*time.Millisecond)

	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Camera {
		t.Fatal("camera should be enabled before the permission is revoked")
	}

	// Revoke USE_VIDEO mid-call by reassigning to a role that lacks it.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (101, 'novideo', NULL, ?, 5, 0)`,
		permissions.ReadMessages|permissions.ConnectVoice,
	); err != nil {
		t.Fatalf("seed novideo role: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET role_id = 101 WHERE id = ?`, user.ID); err != nil {
		t.Fatalf("reassign user role: %v", err)
	}

	hub.HandleMessageForTest(c, voiceCameraMsg(false))

	msgs := drainChanTimeout(send, 30*time.Millisecond)
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			t.Fatalf("unexpected error disabling camera after permission revocation: %s", extractCode(t, m))
		}
	}
	state, err = database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after disable: %v", err)
	}
	if state == nil || state.Camera {
		t.Error("camera still enabled after voice_camera(false), permission revocation must not block disabling")
	}
}

// assertStreamPermissionRefused fails unless msgs carry a FORBIDDEN error
// naming perm. A bare "an error arrived" check is not enough here: the stream
// handlers refuse an un-joined client with VOICE_ERROR "not in a voice channel"
// long before the permission gate runs, which is exactly how the camera and
// screenshare permission tests used to pass without ever reaching it.
func assertStreamPermissionRefused(t *testing.T, msgs [][]byte, perm string) {
	t.Helper()
	for _, m := range msgs {
		if extractCode(t, m) == ws.ErrCodeForbidden &&
			strings.Contains(extractMessage(t, m), perm) {
			return
		}
	}
	got := make([]string, 0, len(msgs))
	for _, m := range msgs {
		got = append(got, extractType(t, m)+"/"+extractCode(t, m)+"/"+extractMessage(t, m))
	}
	t.Errorf("expected FORBIDDEN error naming %s, got %v", perm, got)
}

// TestVoice_Camera_NoPermission: a member already in voice whose role lacks
// USE_VIDEO is refused with FORBIDDEN and stays off camera.
func TestVoice_Camera_NoPermission(t *testing.T) {
	hub, database := newVoiceHub(t)

	// Role 4 (Member) carries CONNECT_VOICE but neither USE_VIDEO nor
	// SHARE_SCREEN, so voice_join succeeds and only the toggle is denied.
	user := seedVoiceUserWithRole(t, database, "cam-noperm", 4)
	chanID := seedVoiceChan(t, database, "vc-cam-noperm")
	c, send := joinVoice(t, hub, user, chanID)

	hub.HandleMessageForTest(c, voiceCameraMsg(true))

	assertStreamPermissionRefused(t, drainChanTimeout(send, 30*time.Millisecond), "USE_VIDEO")

	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || state.Camera {
		t.Error("camera enabled despite the missing USE_VIDEO permission")
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	// Send 5 camera toggles rapidly — limit is 2/sec, so some should be rate-limited.
	for range 5 {
		hub.HandleMessageForTest(c, voiceCameraMsg(true))
	}

	msgs := drainChanTimeout(send, 50*time.Millisecond)
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
	waitRegistered(t, hub, c)

	// Join voice channel first; consume the join's voice_state broadcast so
	// the payload check below sees the screenshare toggle's broadcast.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	if receiveMsgOfType(send2, "voice_state", waitTimeout) == nil {
		t.Fatal("no voice_state broadcast after voice_join")
	}
	drainChan(send)
	drainChan(send2)

	// Toggle screenshare on.
	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))

	// Verify DB state.
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Screenshare {
		t.Error("Screenshare = false after voice_screenshare(true)")
	}

	// Verify voice_state broadcast received.
	foundVoiceState := false
	if payload := receiveMsgOfType(send2, "voice_state", waitTimeout); payload != nil {
		foundVoiceState = true
		if ss, _ := payload["screenshare"].(bool); !ss {
			t.Error("voice_state broadcast payload.screenshare = false, want true")
		}
	}
	if !foundVoiceState {
		t.Error("voice_state broadcast not received after voice_screenshare toggle")
	}
}

// TestVoice_Screenshare_DisableAllowedAfterPermissionRevoked locks the fix
// for v082: only the enable direction is gated on SHARE_SCREEN, mirroring
// handleVoiceMuteV2/handleVoiceDeafenV2's asymmetric gate. If disable were
// still gated too, a moderator revoking SHARE_SCREEN mid-share would leave
// voice_states.screenshare stuck at 1, so every subsequent voice_state kept
// advertising a stream nobody can watch.
func TestVoice_Screenshare_DisableAllowedAfterPermissionRevoked(t *testing.T) {
	hub, database := newVoiceHub(t)

	// A custom role carrying SHARE_SCREEN (the test schema's default Member
	// role does not, unlike production's migration 007).
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (200, 'hasscreenshare', NULL, ?, 5, 0)`,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.ShareScreen,
	); err != nil {
		t.Fatalf("seed hasscreenshare role: %v", err)
	}
	user := seedVoiceUserWithRole(t, database, "ss-revoked", 200)
	chanID := seedVoiceChan(t, database, "vc-ss-revoked")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))
	drainChanTimeout(send, 30*time.Millisecond)

	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || !state.Screenshare {
		t.Fatal("screenshare should be enabled before the permission is revoked")
	}

	// Revoke SHARE_SCREEN mid-share by reassigning to a role that lacks it.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (102, 'noscreenshare', NULL, ?, 5, 0)`,
		permissions.ReadMessages|permissions.ConnectVoice,
	); err != nil {
		t.Fatalf("seed noscreenshare role: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET role_id = 102 WHERE id = ?`, user.ID); err != nil {
		t.Fatalf("reassign user role: %v", err)
	}

	hub.HandleMessageForTest(c, voiceScreenshareMsg(false))

	msgs := drainChanTimeout(send, 30*time.Millisecond)
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			t.Fatalf("unexpected error disabling screenshare after permission revocation: %s", extractCode(t, m))
		}
	}
	state, err = database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after disable: %v", err)
	}
	if state == nil || state.Screenshare {
		t.Error("screenshare still enabled after voice_screenshare(false), permission revocation must not block disabling")
	}
}

// TestVoice_Screenshare_NoPermission: a member already in voice whose role
// lacks SHARE_SCREEN is refused with FORBIDDEN and publishes nothing.
func TestVoice_Screenshare_NoPermission(t *testing.T) {
	hub, database := newVoiceHub(t)

	user := seedVoiceUserWithRole(t, database, "ss-noperm", 4) // Member: no SHARE_SCREEN
	chanID := seedVoiceChan(t, database, "vc-ss-noperm")
	c, send := joinVoice(t, hub, user, chanID)

	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))

	assertStreamPermissionRefused(t, drainChanTimeout(send, 30*time.Millisecond), "SHARE_SCREEN")

	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || state.Screenshare {
		t.Error("screenshare enabled despite the missing SHARE_SCREEN permission")
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	// Send 5 screenshare toggles rapidly — limit is 2/sec.
	for range 5 {
		hub.HandleMessageForTest(c, voiceScreenshareMsg(true))
	}

	msgs := drainChanTimeout(send, 50*time.Millisecond)
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

func TestVoice_HandleMessage_VoiceCamera_Dispatched(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "cam-dispatch")
	chanID := seedVoiceChan(t, database, "vc-cam-dispatch")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	// Send via HandleMessageForTest to verify dispatch occurs (no unknown_type error).
	hub.HandleMessageForTest(c, voiceCameraMsg(true))

	msgs := drainChanTimeout(send, 30*time.Millisecond)
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	// Send via HandleMessageForTest to verify dispatch occurs (no unknown_type error).
	hub.HandleMessageForTest(c, voiceScreenshareMsg(true))

	msgs := drainChanTimeout(send, 30*time.Millisecond)
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

// ─── channel capacity ─────────────────────────────────────────────────────────

// seedVoiceChanMaxUsers creates a voice channel with a custom voice_max_users limit.
func seedVoiceChanMaxUsers(t *testing.T, database *db.DB, name string, maxUsers int) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("seedVoiceChanMaxUsers CreateChannel: %v", err)
	}
	if err := database.SetChannelVoiceMaxUsers(context.Background(), id, maxUsers); err != nil {
		t.Fatalf("seedVoiceChanMaxUsers SetChannelVoiceMaxUsers: %v", err)
	}
	return id
}

// TestVoice_Join_ChannelFull verifies that a second join to a max-1 room
// returns a CHANNEL_FULL error.
func TestVoice_Join_ChannelFull(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChanMaxUsers(t, database, "vc-full", 1)

	user1 := seedVoiceOwner(t, database, "full-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, chanID, send1)
	hub.Register(c1)
	waitRegistered(t, hub, c1)

	// First user joins — should succeed.
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))

	// Verify first user is in DB.
	state1, err := database.GetVoiceState(context.Background(), user1.ID)
	if err != nil || state1 == nil {
		t.Fatalf("user1 voice state missing after join: %v", err)
	}

	user2 := seedVoiceOwner(t, database, "full-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, chanID, send2)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

	drainChan(send1)
	drainChan(send2)

	// Second user joins — should get CHANNEL_FULL error.
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))

	msgs2 := drainChanTimeout(send2, 50*time.Millisecond)
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
	state2, err := database.GetVoiceState(context.Background(), user2.ID)
	if err != nil {
		t.Fatalf("GetVoiceState user2: %v", err)
	}
	if state2 != nil {
		t.Error("user2 voice state should be nil after CHANNEL_FULL rejection")
	}
}

// ─── voice_join config ────────────────────────────────────────────────────────

// TestVoice_Join_SendsVoiceConfig verifies that after voice_join the joiner
// receives a voice_config message with the expected fields.
func TestVoice_Join_SendsVoiceConfig(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "cfg-alice")
	chanID := seedVoiceChan(t, database, "vc-cfg-alice")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	msgs := drainChanTimeout(send, 50*time.Millisecond)
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
			break
		}
	}
	if !foundConfig {
		t.Error("joiner did not receive voice_config after voice_join")
	}
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
	waitRegistered(t, hub, c)

	// Join channel A.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanA))
	drainChanTimeout(send, 30*time.Millisecond)

	// Verify in channel A via DB.
	stateA, _ := database.GetVoiceState(context.Background(), userA.ID)
	if stateA == nil || stateA.ChannelID != chanA {
		t.Fatal("user should be in channel A")
	}

	// Join channel B — should leave A first.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanB))

	// DB state should show channel B.
	stateB, _ := database.GetVoiceState(context.Background(), userA.ID)
	if stateB == nil || stateB.ChannelID != chanB {
		t.Error("user should be in channel B after switching")
	}
}

// TestVoice_Join_SwitchChannel_PreservesServerMute locks the fix for v029: a
// moderator-imposed server mute/deafen must survive a channel switch. The
// switch path deletes and re-inserts the voice_states row (via
// handleVoiceLeave then JoinVoiceChannel), which would otherwise never reach
// the ON CONFLICT branch voice.sql relies on to keep server_muted sticky —
// silently lifting the mute the moment the user changes channels.
func TestVoice_Join_SwitchChannel_PreservesServerMute(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "switch-muted")
	chanA := seedVoiceChan(t, database, "vc-switch-muted-a")
	chanB := seedVoiceChan(t, database, "vc-switch-muted-b")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanA, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanA))
	drainChanTimeout(send, 30*time.Millisecond)

	if _, err := database.SetVoiceServerMute(context.Background(), user.ID, chanA, true); err != nil {
		t.Fatalf("SetVoiceServerMute: %v", err)
	}
	if _, err := database.SetVoiceServerDeafen(context.Background(), user.ID, chanA, true); err != nil {
		t.Fatalf("SetVoiceServerDeafen: %v", err)
	}

	// Switch to channel B.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanB))

	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after switch: %v", err)
	}
	if state == nil || state.ChannelID != chanB {
		t.Fatalf("user should be in channel B after switching, got %+v", state)
	}
	if !state.ServerMuted {
		t.Error("ServerMuted was cleared by the channel switch, want it to survive")
	}
	if !state.ServerDeafened {
		t.Error("ServerDeafened was cleared by the channel switch, want it to survive")
	}
}

// NOTE on v088 (BUG-088, the join/sweep ghost race): handleVoiceJoin now
// calls c.setVoiceState immediately after the DB row commits instead of after
// the permission checks and LiveKit token generation that used to follow it,
// and re-checks (channel, join token) before subscribing and broadcasting so
// an eviction that lands during the token round trip is not undone. Neither
// half is tested here: HandleMessageForTest runs the handler synchronously to
// completion on the calling goroutine, so any assertion made after it returns
// reflects only the final state and cannot distinguish the old ordering from
// the new one — a genuine repro needs a second goroutine to land inside a
// live handler call. What remains after this change is the window before the
// row commits, which only a grace-period guard in sweepStaleVoiceStates
// (hub_sweep.go, outside this batch) can close — see cross_batch.

// TestVoice_Join_SameChannel_IsIdempotent verifies that joining the same channel
// twice returns ALREADY_JOINED.
func TestVoice_Join_SameChannel_IsIdempotent(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "idempotent-join")
	chanID := seedVoiceChan(t, database, "vc-idempotent")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)

	// Join same channel again.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	// Should receive ALREADY_JOINED error.
	msgs := drainChanTimeout(send, 30*time.Millisecond)
	foundAlreadyJoined := false
	for _, m := range msgs {
		if code := extractCode(t, m); code == "ALREADY_JOINED" {
			foundAlreadyJoined = true
		}
	}
	if !foundAlreadyJoined {
		t.Error("expected ALREADY_JOINED error on re-join of same channel")
	}
}

// TestVoice_Join_AbortedSwitch_DoesNotResurrectPhantomSession pins OC-0034:
// when a voice-channel switch's pre-switch leave leaves the old voice_states
// row in place (e.g. a missing join token short-circuits the delete via
// leaveVoiceChannelWithRetry's empty-token guard in voice_leave.go),
// handleVoiceJoin aborts the switch. finishVoiceLeave has already broadcast
// voice_leave for the old channel to every client that can see it — including
// the leaver itself, which finishVoiceLeave always adds to the audience — so
// every client, this one's own session included, has already torn the old
// membership down. Restoring the client's local voice state on abort
// resurrects a session nobody else believes exists anymore. The fix is to
// leave the client's local state cleared so it agrees with the voice_leave it
// already received; the stale DB row then disagrees with every connected
// client's voiceChID and the periodic sweep reaps it.
func TestVoice_Join_AbortedSwitch_DoesNotResurrectPhantomSession(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "abort-switch-user")
	chanA := seedVoiceChan(t, database, "vc-abort-a")
	chanB := seedVoiceChan(t, database, "vc-abort-b")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanA, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Join channel A normally.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanA))
	drainChanTimeout(send, 30*time.Millisecond)

	stateA, _ := database.GetVoiceState(context.Background(), user.ID)
	if stateA == nil || stateA.ChannelID != chanA {
		t.Fatalf("user should be in channel A, got %+v", stateA)
	}

	// Simulate the repro from the finding: the client's local join token has
	// gone missing (e.g. a prior partial failure) while its voice channel ID
	// still agrees with the DB row. leaveVoiceChannelWithRetry's empty-token
	// guard then skips the DELETE entirely, so the pre-switch leave silently
	// no-ops and the old row survives.
	ws.SetClientVoiceStateForTest(c, chanA, "")

	// Attempt to switch to channel B. handleVoiceLeave runs first (broadcasts
	// voice_leave for chanA to the leaver, per finishVoiceLeave), the DB
	// delete is skipped, and handleVoiceJoin's stale-state check aborts the
	// switch.
	hub.HandleMessageForTest(c, voiceJoinMsg(chanB))

	// Confirm the abort branch actually triggered: the old row must still be
	// present in the DB.
	stillA, _ := database.GetVoiceState(context.Background(), user.ID)
	if stillA == nil || stillA.ChannelID != chanA {
		t.Fatalf("test setup broken: expected stale row in chanA, got %+v", stillA)
	}

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Errorf("aborted switch resurrected a phantom session: client voice channel = %d, want 0 (voice_leave for chanA was already broadcast to this client, including itself)", got)
	}
	if hub.SubscribedToVoiceTopicForTest(c, chanA) {
		t.Error("aborted switch re-subscribed the client to chanA's voice topic after voice_leave was already broadcast for it")
	}
}

// ─── voice leave on disconnect ────────────────────────────────────────────────

// TestVoice_Leave_OnDisconnect verifies that handleVoiceLeave cleans up
// DB state when triggered by a disconnect without an explicit voice_leave message.
func TestVoice_Leave_OnDisconnect(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "disco-dave")
	chanID := seedVoiceChan(t, database, "vc-disco-dave")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	// Simulate disconnect by calling the exported test hook.
	hub.HandleVoiceLeaveForTest(c)

	// DB state should be cleared.
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after disconnect: %v", err)
	}
	if state != nil {
		t.Error("voice state still in DB after simulated disconnect")
	}
}

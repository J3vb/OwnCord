package ws_test

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// ─── test helpers ─────────────────────────────────────────────────────────────

func openTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: hubTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

func newTestHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	return hub, database
}

// seedTestUser inserts a Member-role user and returns its ID.
func seedTestUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	id, err := database.CreateUser(username, "hash", 4)
	if err != nil {
		t.Fatalf("seedUser: %v", err)
	}
	return id
}

// seedOwnerUser inserts an Owner-role user and returns the full *db.User.
// Owner role (id=1) has all permissions (0x7FFFFFFF), so it passes all checks.
func seedOwnerUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 1) // roleID=1 → Owner
	if err != nil {
		t.Fatalf("seedOwnerUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("seedOwnerUser GetUserByUsername: %v", err)
	}
	return user
}

// seedTestChannel inserts a channel and returns its ID.
func seedTestChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(name, "text", "", "", 0)
	if err != nil {
		t.Fatalf("seedChannel: %v", err)
	}
	return id
}

// ─── Hub lifecycle ────────────────────────────────────────────────────────────

func TestNewHub_NotNil(t *testing.T) {
	hub, _ := newTestHub(t)
	if hub == nil {
		t.Fatal("NewHub returned nil")
	}
}

func TestHub_RunStops(t *testing.T) {
	hub, _ := newTestHub(t)
	done := make(chan struct{})
	go func() {
		hub.Run()
		close(done)
	}()
	// Give the goroutine a moment to start, then stop the hub.
	time.Sleep(10 * time.Millisecond)
	hub.Stop()
	select {
	case <-done:
		// ok
	case <-time.After(2 * time.Second):
		t.Error("hub.Run() did not stop after hub.Stop()")
	}
}

// ─── Register / Unregister ────────────────────────────────────────────────────

func TestHub_RegisterIncrementsCount(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "alice")
	send := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, userID, send))

	time.Sleep(20 * time.Millisecond)
	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d, want 1", hub.ClientCount())
	}
}

func TestHub_UnregisterDecrementsCount(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "bob")
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, userID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.Unregister(c)
	time.Sleep(20 * time.Millisecond)
	if hub.ClientCount() != 0 {
		t.Errorf("ClientCount = %d, want 0", hub.ClientCount())
	}
}

func TestHub_RegisterSameUserTwice(t *testing.T) {
	// Second registration for same userID should replace the first.
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "carol")
	send1 := make(chan []byte, 4)
	send2 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, userID, send1))
	hub.Register(ws.NewTestClient(hub, userID, send2))
	time.Sleep(30 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after double register, want 1", hub.ClientCount())
	}
}

// ─── BroadcastToAll ───────────────────────────────────────────────────────────

func TestHub_BroadcastToAll_DeliversToAllClients(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "dave")
	u2 := seedTestUser(t, database, "eve")
	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	hub.Register(ws.NewTestClient(hub, u2, s2))
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"presence","payload":{}}`)
	hub.BroadcastToAll(msg)
	time.Sleep(20 * time.Millisecond)

	assertReceived(t, s1, msg, "client 1")
	assertReceived(t, s2, msg, "client 2")
}

func TestHub_BroadcastToAll_NoClients(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	// Should not panic.
	hub.BroadcastToAll([]byte(`{}`))
}

// ─── BroadcastToChannel ───────────────────────────────────────────────────────

func TestHub_BroadcastToChannel_OnlySendsToChannelMembers(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "general")
	u1 := seedTestUser(t, database, "frank")
	u2 := seedTestUser(t, database, "grace")

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClientWithChannel(hub, u1, chID, s1)
	c2 := ws.NewTestClientWithChannel(hub, u2, 999, s2) // different channel

	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"chat_message","payload":{}}`)
	hub.BroadcastToChannel(chID, msg)
	time.Sleep(20 * time.Millisecond)

	assertReceived(t, s1, msg, "channel member")
	assertNotReceived(t, s2, "non-member")
}

func TestHub_BroadcastToChannel_ZeroChannelSendsToAll(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "henry")
	s1 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"presence","payload":{}}`)
	hub.BroadcastToChannel(0, msg)
	time.Sleep(20 * time.Millisecond)

	assertReceived(t, s1, msg, "client")
}

// ─── SendToUser ───────────────────────────────────────────────────────────────

func TestHub_SendToUser_ExistingClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "ivan")
	send := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, userID, send))
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"chat_send_ok","payload":{}}`)
	ok := hub.SendToUser(userID, msg)
	if !ok {
		t.Error("SendToUser returned false for existing client")
	}
	time.Sleep(20 * time.Millisecond)
	assertReceived(t, send, msg, "target user")
}

func TestHub_SendToUser_MissingClient(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	ok := hub.SendToUser(9999, []byte(`{}`))
	if ok {
		t.Error("SendToUser should return false for absent client")
	}
}

// ─── Message dispatch ─────────────────────────────────────────────────────────

func TestHub_HandleMessage_UnknownType_SendsError(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "julia")
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, userID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw := []byte(`{"type":"totally_unknown","payload":{}}`)
	hub.HandleMessageForTest(c, raw)
	time.Sleep(20 * time.Millisecond)

	select {
	case got := <-send:
		var resp map[string]any
		if err := json.Unmarshal(got, &resp); err != nil {
			t.Fatalf("unmarshal response: %v", err)
		}
		if resp["type"] != "error" {
			t.Errorf("type = %q, want 'error'", resp["type"])
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("expected error response for unknown message type")
	}
}

func TestHub_HandleMessage_InvalidJSON(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "kim")
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, userID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, []byte(`NOT JSON`))
	time.Sleep(20 * time.Millisecond)

	select {
	case got := <-send:
		var resp map[string]any
		if err := json.Unmarshal(got, &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if resp["type"] != "error" {
			t.Errorf("type = %q, want 'error'", resp["type"])
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("expected error response for invalid JSON")
	}
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

func TestHub_ChatSend_RateLimit(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "larry")
	chID := seedTestChannel(t, database, "rl-test")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	payload := map[string]any{
		"channel_id": chID,
		"content":    "hi",
	}
	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": payload,
	})

	// Send 12 messages rapidly — 11th and beyond should be rate-limited.
	for range 12 {
		hub.HandleMessageForTest(c, raw)
	}
	time.Sleep(100 * time.Millisecond)

	// Drain all messages, count errors.
	errCount := 0
	drainLoop:
	for {
		select {
		case got := <-send:
			var resp map[string]any
			if err := json.Unmarshal(got, &resp); err == nil {
				if resp["type"] == "error" {
					errCount++
				}
			}
		default:
			break drainLoop
		}
	}
	if errCount == 0 {
		t.Error("expected at least one rate-limit error response")
	}
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

func TestHub_ConcurrentRegisterUnregister(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			username := fmt.Sprintf("user%d", i)
			userID := seedTestUser(t, database, username)
			send := make(chan []byte, 4)
			c := ws.NewTestClient(hub, userID, send)
			hub.Register(c)
			time.Sleep(5 * time.Millisecond)
			hub.Unregister(c)
		}(i)
	}
	wg.Wait()
	time.Sleep(50 * time.Millisecond)
	if hub.ClientCount() != 0 {
		t.Errorf("expected 0 clients after concurrent churn, got %d", hub.ClientCount())
	}
}

// ─── GetClient ───────────────────────────────────────────────────────────────

func TestHub_GetClient(t *testing.T) {
	hub, _ := newTestHub(t)
	send := make(chan []byte, 256)
	client := ws.NewTestClient(hub, 42, send)
	hub.Register(client)
	go hub.Run()
	defer hub.Stop()
	time.Sleep(10 * time.Millisecond)

	got := hub.GetClient(42)
	if got == nil {
		t.Fatal("GetClient(42) returned nil")
	}

	got2 := hub.GetClient(999)
	if got2 != nil {
		t.Fatal("GetClient(999) should return nil")
	}
}

// ─── assertion helpers ────────────────────────────────────────────────────────

func assertReceived(t *testing.T, ch <-chan []byte, want []byte, label string) {
	t.Helper()
	select {
	case got := <-ch:
		if string(got) != string(want) {
			t.Errorf("%s: got %q, want %q", label, got, want)
		}
	case <-time.After(500 * time.Millisecond):
		t.Errorf("%s: did not receive expected message within timeout", label)
	}
}

func assertNotReceived(t *testing.T, ch <-chan []byte, label string) {
	t.Helper()
	select {
	case got := <-ch:
		t.Errorf("%s: received unexpected message: %q", label, got)
	case <-time.After(100 * time.Millisecond):
		// ok — nothing received
	}
}

// ─── Voice room lifecycle ─────────────────────────────────────────────────────

func TestHub_SetSFU_NilSafe(t *testing.T) {
	hub, _ := newTestHub(t)
	// Setting a nil SFU must not panic.
	hub.SetSFU(nil)
}

func TestHub_GetOrCreateVoiceRoom_CreatesNew(t *testing.T) {
	hub, _ := newTestHub(t)
	cfg := ws.VoiceRoomConfig{ChannelID: 42, MaxUsers: 10, Quality: "medium"}

	room := hub.GetOrCreateVoiceRoom(42, cfg)
	if room == nil {
		t.Fatal("GetOrCreateVoiceRoom returned nil")
	}
}

func TestHub_GetOrCreateVoiceRoom_ReturnsSameRoom(t *testing.T) {
	hub, _ := newTestHub(t)
	cfg := ws.VoiceRoomConfig{ChannelID: 99, MaxUsers: 5, Quality: "low"}

	r1 := hub.GetOrCreateVoiceRoom(99, cfg)
	r2 := hub.GetOrCreateVoiceRoom(99, cfg)
	if r1 != r2 {
		t.Error("GetOrCreateVoiceRoom should return the same room on subsequent calls")
	}
}

func TestHub_GetOrCreateVoiceRoom_DifferentChannels(t *testing.T) {
	hub, _ := newTestHub(t)
	cfg1 := ws.VoiceRoomConfig{ChannelID: 1, Quality: "low"}
	cfg2 := ws.VoiceRoomConfig{ChannelID: 2, Quality: "high"}

	r1 := hub.GetOrCreateVoiceRoom(1, cfg1)
	r2 := hub.GetOrCreateVoiceRoom(2, cfg2)
	if r1 == r2 {
		t.Error("different channel IDs must produce distinct rooms")
	}
}

func TestHub_GetVoiceRoom_ReturnsNilWhenAbsent(t *testing.T) {
	hub, _ := newTestHub(t)
	room := hub.GetVoiceRoom(404)
	if room != nil {
		t.Errorf("GetVoiceRoom: want nil for absent channel, got %v", room)
	}
}

func TestHub_GetVoiceRoom_ReturnsRoomAfterCreate(t *testing.T) {
	hub, _ := newTestHub(t)
	cfg := ws.VoiceRoomConfig{ChannelID: 7, Quality: "medium"}
	hub.GetOrCreateVoiceRoom(7, cfg)

	room := hub.GetVoiceRoom(7)
	if room == nil {
		t.Fatal("GetVoiceRoom: want non-nil after GetOrCreateVoiceRoom, got nil")
	}
}

func TestHub_RemoveVoiceRoom_NoopWhenAbsent(t *testing.T) {
	hub, _ := newTestHub(t)
	// Must not panic on removal of non-existent room.
	hub.RemoveVoiceRoom(999)
}

func TestHub_RemoveVoiceRoom_RemovesRoom(t *testing.T) {
	hub, _ := newTestHub(t)
	cfg := ws.VoiceRoomConfig{ChannelID: 55, Quality: "low"}
	hub.GetOrCreateVoiceRoom(55, cfg)

	hub.RemoveVoiceRoom(55)
	if hub.GetVoiceRoom(55) != nil {
		t.Error("GetVoiceRoom: want nil after RemoveVoiceRoom")
	}
}

func TestHub_CloseAllVoiceRooms_ClearsAll(t *testing.T) {
	hub, _ := newTestHub(t)
	for _, id := range []int64{10, 20, 30} {
		hub.GetOrCreateVoiceRoom(id, ws.VoiceRoomConfig{ChannelID: id, Quality: "medium"})
	}

	hub.CloseAllVoiceRooms()

	for _, id := range []int64{10, 20, 30} {
		if hub.GetVoiceRoom(id) != nil {
			t.Errorf("GetVoiceRoom(%d): want nil after CloseAllVoiceRooms", id)
		}
	}
}

func TestHub_CloseAllVoiceRooms_EmptyIsNoop(t *testing.T) {
	hub, _ := newTestHub(t)
	// Must not panic when no rooms exist.
	hub.CloseAllVoiceRooms()
}

func TestHub_VoiceRooms_ConcurrentAccess(t *testing.T) {
	hub, _ := newTestHub(t)
	var wg sync.WaitGroup

	// Concurrent creates and reads must not race.
	for i := range int64(20) {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			cfg := ws.VoiceRoomConfig{ChannelID: id, Quality: "medium"}
			hub.GetOrCreateVoiceRoom(id, cfg)
			hub.GetVoiceRoom(id)
			hub.RemoveVoiceRoom(id)
		}(i)
	}
	wg.Wait()
}

// ─── GracefulStop ─────────────────────────────────────────────────────────────

func TestHub_GracefulStop_StopsHub(t *testing.T) {
	hub, _ := newTestHub(t)
	done := make(chan struct{})
	go func() {
		hub.Run()
		close(done)
	}()
	time.Sleep(10 * time.Millisecond)

	hub.GracefulStop()

	select {
	case <-done:
		// ok — hub stopped
	case <-time.After(2 * time.Second):
		t.Error("hub.Run() did not stop after GracefulStop()")
	}
}

func TestHub_GracefulStop_ClosesAllVoiceRooms(t *testing.T) {
	hub, _ := newTestHub(t)
	for _, id := range []int64{100, 200, 300} {
		hub.GetOrCreateVoiceRoom(id, ws.VoiceRoomConfig{ChannelID: id, Quality: "low"})
	}
	go hub.Run()

	hub.GracefulStop()
	time.Sleep(20 * time.Millisecond)

	for _, id := range []int64{100, 200, 300} {
		if hub.GetVoiceRoom(id) != nil {
			t.Errorf("GetVoiceRoom(%d): expected nil after GracefulStop", id)
		}
	}
}

func TestHub_GracefulStop_NoRooms_NoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	// Must not panic with zero voice rooms.
	hub.GracefulStop()
}

// ─── CleanupVoiceForChannel ───────────────────────────────────────────────────

func TestHub_CleanupVoiceForChannel_RemovesRoom(t *testing.T) {
	hub, _ := newTestHub(t)
	chID := int64(55)
	hub.GetOrCreateVoiceRoom(chID, ws.VoiceRoomConfig{ChannelID: chID, Quality: "medium"})

	hub.CleanupVoiceForChannel(chID)

	if hub.GetVoiceRoom(chID) != nil {
		t.Error("expected room to be nil after CleanupVoiceForChannel")
	}
}

func TestHub_CleanupVoiceForChannel_NoRoom_NoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	// Must not panic when channel has no voice room.
	hub.CleanupVoiceForChannel(9999)
}

func TestHub_CleanupVoiceForChannel_BroadcastsVoiceLeave(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "cleanup-vc")
	u1 := seedTestUser(t, database, "cleanup-user1")
	u2 := seedTestUser(t, database, "cleanup-user2")

	send1 := make(chan []byte, 16)
	send2 := make(chan []byte, 16)
	c1 := ws.NewTestClientWithChannel(hub, u1, chID, send1)
	c2 := ws.NewTestClientWithChannel(hub, u2, chID, send2)
	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	room := hub.GetOrCreateVoiceRoom(chID, ws.VoiceRoomConfig{ChannelID: chID, Quality: "medium"})
	if err := room.AddParticipant(u1); err != nil {
		t.Fatalf("AddParticipant u1: %v", err)
	}
	if err := room.AddParticipant(u2); err != nil {
		t.Fatalf("AddParticipant u2: %v", err)
	}

	hub.CleanupVoiceForChannel(chID)
	time.Sleep(50 * time.Millisecond)

	// At least one of the clients must receive a voice_leave.
	allMsgs := append(drainChan(send1), drainChan(send2)...)
	found := false
	for _, msg := range allMsgs {
		var env map[string]any
		if err := json.Unmarshal(msg, &env); err == nil {
			if env["type"] == "voice_leave" {
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("expected voice_leave broadcast after CleanupVoiceForChannel")
	}
}

// ─── Hub.Register voice state cleanup ────────────────────────────────────────

func TestHub_Register_CleansUpOldVoiceState(t *testing.T) {
	// Use voiceHub (has voice_states table) so handleVoiceJoin succeeds.
	hub, database := newVoiceHub(t)

	user := seedVoiceOwner(t, database, "register-voice-user")
	chID := seedVoiceChan(t, database, "vc-register-voice")

	// Create the voice room and register the first client.
	room := hub.GetOrCreateVoiceRoom(chID, ws.VoiceRoomConfig{ChannelID: chID, Quality: "medium"})

	send1 := make(chan []byte, 16)
	c1 := ws.NewTestClientWithUser(hub, user, chID, send1)
	if err := room.AddParticipant(user.ID); err != nil {
		t.Fatalf("AddParticipant: %v", err)
	}
	ws.SetClientVoiceChID(c1, chID)

	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	// Register a second client for the same user — should evict the first.
	send2 := make(chan []byte, 16)
	c2 := ws.NewTestClientWithUser(hub, user, chID, send2)
	hub.Register(c2)
	time.Sleep(30 * time.Millisecond)

	// The old client's voice state in the room should be cleaned up.
	if room.HasParticipant(user.ID) {
		t.Error("expected old client's voice participation to be cleaned up after re-register")
	}
}

// hubTestSchema is the minimal schema needed for hub tests.
var hubTestSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',     '#F39C12', 1073741823,  80, 0),
    (3, 'Moderator', '#3498DB', 1048575,     60, 0),
    (4, 'Member',    NULL,      1635,     40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category         TEXT,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('server_name', 'OwnCord Server'),
    ('motd',        'Welcome!');
`)

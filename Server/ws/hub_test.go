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

// ─── BUG-122: Unfocused client must NOT receive channel-scoped broadcasts ────

func TestHub_BroadcastToChannel_SkipsUnfocusedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "secret")
	u1 := seedTestUser(t, database, "focused")
	u2 := seedTestUser(t, database, "unfocused")

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClientWithChannel(hub, u1, chID, s1) // focused on channel
	c2 := ws.NewTestClient(hub, u2, s2)                  // channelID == 0 (unfocused)

	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"chat_message","payload":{"content":"secret"}}`)
	hub.BroadcastToChannel(chID, msg)
	time.Sleep(20 * time.Millisecond)

	assertReceived(t, s1, msg, "focused client")
	assertNotReceived(t, s2, "unfocused client must NOT receive channel broadcast")
}

func TestHub_BroadcastToChannel_DeliversToVoiceClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "voice-text")
	u1 := seedTestUser(t, database, "voiceuser")

	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1) // channelID == 0
	ws.SetClientVoiceChID(c1, chID)     // but in voice on this channel

	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"chat_message","payload":{"content":"hello"}}`)
	hub.BroadcastToChannel(chID, msg)
	time.Sleep(20 * time.Millisecond)

	assertReceived(t, s1, msg, "voice client should receive channel broadcast")
}

func TestHub_BroadcastToAll_StillDeliversToUnfocusedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "globaluser")
	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1) // channelID == 0 (unfocused)

	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	msg := []byte(`{"type":"presence","payload":{"status":"online"}}`)
	hub.BroadcastToAll(msg)
	time.Sleep(20 * time.Millisecond)

	assertReceived(t, s1, msg, "unfocused client must still receive global broadcasts")
}

func TestHub_BroadcastToChannel_UnfocusedDoesNotReceiveAnyChannel(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	ch1 := seedTestChannel(t, database, "chan1")
	ch2 := seedTestChannel(t, database, "chan2")
	u1 := seedTestUser(t, database, "snooper")

	s1 := make(chan []byte, 8)
	c1 := ws.NewTestClient(hub, u1, s1) // unfocused

	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	msg1 := []byte(`{"type":"chat_message","payload":{"channel":"1"}}`)
	msg2 := []byte(`{"type":"chat_message","payload":{"channel":"2"}}`)
	hub.BroadcastToChannel(ch1, msg1)
	hub.BroadcastToChannel(ch2, msg2)
	time.Sleep(20 * time.Millisecond)

	assertNotReceived(t, s1, "unfocused client must NOT receive ch1 broadcast")
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

// assertReceived checks that a message was received and contains the same JSON
// fields as want (ignoring the "seq" field injected by broadcast delivery).
func assertReceived(t *testing.T, ch <-chan []byte, want []byte, label string) {
	t.Helper()
	select {
	case got := <-ch:
		var gotMap map[string]json.RawMessage
		if err := json.Unmarshal(got, &gotMap); err != nil {
			t.Errorf("%s: unmarshal got: %v", label, err)
			return
		}
		var wantMap map[string]json.RawMessage
		if err := json.Unmarshal(want, &wantMap); err != nil {
			t.Errorf("%s: unmarshal want: %v", label, err)
			return
		}
		// Strip seq before comparing — broadcasts have it, direct sends don't.
		delete(gotMap, "seq")
		for k, wv := range wantMap {
			gv, ok := gotMap[k]
			if !ok {
				t.Errorf("%s: missing key %q in received message", label, k)
				continue
			}
			if string(gv) != string(wv) {
				t.Errorf("%s: key %q: got %s, want %s", label, k, gv, wv)
			}
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

// ─── LiveKit lifecycle ────────────────────────────────────────────────────────

func TestHub_SetLiveKit_NilSafe(t *testing.T) {
	hub, _ := newTestHub(t)
	// Setting a nil LiveKit client must not panic.
	hub.SetLiveKit(nil)
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

func TestHub_GracefulStop_NoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	// Must not panic with no LiveKit process.
	hub.GracefulStop()
}

func TestHub_GracefulStop_Idempotent(t *testing.T) {
	// BUG-087: GracefulStop must be safe to call concurrently/twice.
	// Without sync.Once protection, double lkProcess.Stop() can panic.
	hub, _ := newTestHub(t)
	go hub.Run()

	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			hub.GracefulStop()
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		// Success: no panic from concurrent GracefulStop.
	case <-time.After(15 * time.Second):
		t.Fatal("concurrent GracefulStop calls deadlocked")
	}
}

// ─── CleanupVoiceForChannel ───────────────────────────────────────────────────

func TestHub_CleanupVoiceForChannel_NoVoiceState_NoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	// Must not panic when channel has no voice state in DB.
	hub.CleanupVoiceForChannel(9999)
}

// TestHub_Register_CleansUpOldVoiceState was removed because duplicate
// logins are now rejected at the WebSocket handshake level (commit 00bbb46)
// before hub.Register is called. The hub's register case simply overwrites
// the client map entry; voice cleanup for disconnects is handled by
// handleVoiceLeave called from readPump/ICE monitor.

// ─── sweepStaleClients ──────────────────────────────────────────────────────

func TestHub_SweepStaleClients_RemovesInactiveClients(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "stale-alice")
	u2 := seedTestUser(t, database, "fresh-bob")

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1)
	c2 := ws.NewTestClient(hub, u2, s2)

	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	ws.SetClientLastActivityForTest(c1, time.Now().Add(-2*time.Minute))
	ws.SetClientLastActivityForTest(c2, time.Now())

	hub.SweepStaleClientsForTest()
	time.Sleep(20 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after sweep, want 1", hub.ClientCount())
	}
	if hub.GetClient(u1) != nil {
		t.Error("stale client should have been removed")
	}
	if hub.GetClient(u2) == nil {
		t.Error("fresh client should still be present")
	}
}

func TestHub_SweepStaleClients_NoClientsNoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	hub.SweepStaleClientsForTest()
}

func TestHub_SweepStaleClients_AllFresh(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "fresh-carol")
	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	ws.SetClientLastActivityForTest(c1, time.Now())
	hub.SweepStaleClientsForTest()
	time.Sleep(20 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after sweep of fresh clients, want 1", hub.ClientCount())
	}
}

// ─── Session sweep (BUG-109) ──────────────────────────────────────────────

// TestHub_SweepRevokedSessions_KicksRevokedClient verifies that the periodic
// session sweep disconnects clients whose sessions have been deleted from the
// database (e.g. after logout on another device).
func TestHub_SweepRevokedSessions_KicksRevokedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	// Create two users with sessions.
	uid1, err := database.CreateUser("alice-revoke", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	uid2, err := database.CreateUser("bob-valid", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	u1, _ := database.GetUserByID(uid1)
	u2, _ := database.GetUserByID(uid2)

	token1 := "revoke-token-1"
	token2 := "valid-token-2"
	hash1 := auth.HashToken(token1)
	hash2 := auth.HashToken(token2)

	if _, err := database.CreateSession(uid1, hash1, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession 1: %v", err)
	}
	if _, err := database.CreateSession(uid2, hash2, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession 2: %v", err)
	}

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClientWithTokenHash(hub, u1, hash1, 0, s1)
	c2 := ws.NewTestClientWithTokenHash(hub, u2, hash2, 0, s2)

	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	// Delete alice's session (simulating logout from another device).
	if err := database.DeleteSession(hash1); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	// Run the session sweep.
	hub.SweepRevokedSessionsForTest()
	time.Sleep(20 * time.Millisecond)

	// Alice should be kicked, Bob should remain.
	if hub.GetClient(uid1) != nil {
		t.Error("revoked client alice should have been kicked")
	}
	if hub.GetClient(uid2) == nil {
		t.Error("valid client bob should still be connected")
	}
	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d, want 1", hub.ClientCount())
	}
}

// TestHub_SweepRevokedSessions_NoDBNoPanic verifies the sweep is a no-op
// when the hub has no database (nil-safe).
func TestHub_SweepRevokedSessions_NoDBNoPanic(t *testing.T) {
	hub := ws.NewHubForTest()
	hub.SweepRevokedSessionsForTest() // should not panic
}

// TestHub_SweepRevokedSessions_EmptyTokenHashSkipped verifies that clients
// without a token hash (e.g. test clients) are not kicked by the sweep.
func TestHub_SweepRevokedSessions_EmptyTokenHashSkipped(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	uid := seedTestUser(t, database, "no-hash-user")
	s := make(chan []byte, 4)
	c := ws.NewTestClient(hub, uid, s)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.SweepRevokedSessionsForTest()
	time.Sleep(20 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d, want 1 (client without token hash should survive)", hub.ClientCount())
	}
}

// ─── LiveKitHealthCheck ─────────────────────────────────────────────────────

func TestHub_LiveKitHealthCheck_NilReturnsError(t *testing.T) {
	hub, _ := newTestHub(t)
	ok, err := hub.LiveKitHealthCheck()
	if ok {
		t.Error("expected ok=false when LiveKit is nil")
	}
	if err == nil {
		t.Error("expected non-nil error when LiveKit is nil")
	}
}

// ─── SetLiveKitProcess ──────────────────────────────────────────────────────

func TestHub_SetLiveKitProcess(t *testing.T) {
	hub, _ := newTestHub(t)
	hub.SetLiveKitProcess(nil)
	go hub.Run()
	hub.GracefulStop()
}

// ─── VoiceSessionCount ─────────────────────────────────────────────────────

func TestHub_VoiceSessionCount(t *testing.T) {
	tests := []struct {
		name      string
		voiceChs  []int64
		wantCount int
	}{
		{"no clients", nil, 0},
		{"all in voice", []int64{100, 200, 300}, 3},
		{"none in voice", []int64{0, 0}, 0},
		{"mixed", []int64{100, 0, 200, 0}, 2},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub, database := newTestHub(t)
			go hub.Run()
			defer hub.Stop()

			for i, vch := range tc.voiceChs {
				username := fmt.Sprintf("voice-%s-%d", tc.name, i)
				uid := seedTestUser(t, database, username)
				send := make(chan []byte, 4)
				c := ws.NewTestClient(hub, uid, send)
				if vch != 0 {
					ws.SetClientVoiceChID(c, vch)
				}
				hub.Register(c)
			}
			time.Sleep(30 * time.Millisecond)

			got := hub.VoiceSessionCount()
			if got != tc.wantCount {
				t.Errorf("VoiceSessionCount() = %d, want %d", got, tc.wantCount)
			}
		})
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

CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS dm_open_state (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);
`)

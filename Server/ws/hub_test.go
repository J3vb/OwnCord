package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
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
	hub := ws.NewHub(database, limiter, nil)
	return hub, database
}

// seedTestUser inserts a Member-role user and returns its ID.
func seedTestUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, "hash", 4)
	if err != nil {
		t.Fatalf("seedUser: %v", err)
	}
	return id
}

// seedOwnerUser inserts an Owner-role user and returns the full *db.User.
// Owner role (id=1) has all permissions (0x7FFFFFFF), so it passes all checks.
func seedOwnerUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(context.Background(), username, "hash", 1) // roleID=1 → Owner
	if err != nil {
		t.Fatalf("seedOwnerUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("seedOwnerUser GetUserByUsername: %v", err)
	}
	return user
}

// seedTestChannel inserts a channel and returns its ID.
func seedTestChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, "text", "", "", 0)
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
	// Wait for the Run loop to start, then stop the hub.
	waitFor(t, waitTimeout, hub.RunningForTest, "hub Run loop to start")
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

	waitClientCount(t, hub, 1)
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
	waitRegistered(t, hub, c)

	hub.Unregister(c)
	waitClientCount(t, hub, 0)
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
	c2 := ws.NewTestClient(hub, userID, send2)
	hub.Register(ws.NewTestClient(hub, userID, send1))
	hub.Register(c2)
	// Client events are processed in order: once c2 is visible, the first
	// registration has been replaced.
	waitRegistered(t, hub, c2)

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
	c2 := ws.NewTestClient(hub, u2, s2)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	hub.Register(c2)
	waitRegistered(t, hub, c2) // in-order events: both clients registered

	msg := []byte(`{"type":"presence","payload":{}}`)
	hub.BroadcastToAll(msg)

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
	waitRegistered(t, hub, c2)

	msg := []byte(`{"type":"chat_message","payload":{}}`)
	hub.BroadcastToChannel(chID, msg)

	assertReceived(t, s1, msg, "channel member")
	assertNotReceived(t, s2, "non-member")
}

func TestHub_BroadcastToChannel_ZeroChannelSendsToAll(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "henry")
	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1)
	hub.Register(c1)
	waitRegistered(t, hub, c1)

	msg := []byte(`{"type":"presence","payload":{}}`)
	hub.BroadcastToChannel(0, msg)

	assertReceived(t, s1, msg, "client")
}

// ─── BroadcastChatBulkDeleted ─────────────────────────────────────────────────

// One chat_bulk_deleted carrying every purged id reaches the channel's
// subscribers, and nobody else — a purge must not fan out N chat_deleted events
// nor disclose ids to a client focused elsewhere.
func TestHub_BroadcastChatBulkDeleted_OneEventToChannelMembers(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "purged")
	u1 := seedTestUser(t, database, "bulk1")
	u2 := seedTestUser(t, database, "bulk2")

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	hub.Register(ws.NewTestClientWithChannel(hub, u1, chID, s1))
	c2 := ws.NewTestClientWithChannel(hub, u2, 999, s2)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

	hub.BroadcastChatBulkDeleted(chID, []int64{7, 6, 5})

	select {
	case got := <-s1:
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ChannelID int64   `json:"channel_id"`
				IDs       []int64 `json:"ids"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(got, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Type != "chat_bulk_deleted" {
			t.Errorf("type = %q, want chat_bulk_deleted", env.Type)
		}
		if env.Payload.ChannelID != chID {
			t.Errorf("channel_id = %d, want %d", env.Payload.ChannelID, chID)
		}
		if !slices.Equal(env.Payload.IDs, []int64{7, 6, 5}) {
			t.Errorf("ids = %v, want [7 6 5]", env.Payload.IDs)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("channel member did not receive chat_bulk_deleted")
	}

	assertNotReceived(t, s1, "channel member (second event)")
	assertNotReceived(t, s2, "client focused on another channel")
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
	waitRegistered(t, hub, c2)

	msg := []byte(`{"type":"chat_message","payload":{"content":"secret"}}`)
	hub.BroadcastToChannel(chID, msg)

	assertReceived(t, s1, msg, "focused client")
	assertNotReceived(t, s2, "unfocused client must NOT receive channel broadcast")
}

// Voice membership is gated on CONNECT_VOICE only, so it must never on its own
// subscribe a client to a channel's message stream — that route requires
// READ_MESSAGES (channel_focus). Registration without a READ_MESSAGES set must
// therefore deliver nothing.
func TestHub_BroadcastToChannel_NotDeliveredOnVoiceMembershipAlone(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "voice-text")
	u1 := seedTestUser(t, database, "voiceuser")

	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1) // channelID == 0
	ws.SetClientVoiceChID(c1, chID)     // but in voice on this channel

	hub.Register(c1)
	waitRegistered(t, hub, c1)

	msg := []byte(`{"type":"chat_message","payload":{"content":"hello"}}`)
	hub.BroadcastToChannel(chID, msg)

	assertNotReceived(t, s1, "voice membership alone must NOT deliver the channel message stream")
}

// The inherited voice-channel subscription follows the handshake's
// READ_MESSAGES set: a reconnecting client that may read the channel keeps live
// delivery (it never re-sends channel_focus), one that may not gets nothing.
func TestHub_RegisterNow_VoiceChannelSubscriptionFollowsReadPermission(t *testing.T) {
	tests := []struct {
		name     string
		slug     string
		readable func(chID int64) map[int64]bool
		want     bool
	}{
		{
			name:     "READ_MESSAGES on the voice channel keeps the stream",
			slug:     "readable",
			readable: func(chID int64) map[int64]bool { return map[int64]bool{chID: true} },
			want:     true,
		},
		{
			name:     "READ_MESSAGES only elsewhere denies the stream",
			slug:     "unreadable",
			readable: func(chID int64) map[int64]bool { return map[int64]bool{chID + 1000: true} },
			want:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub, database := newTestHub(t)
			go hub.Run()
			defer hub.Stop()

			chID := seedTestChannel(t, database, "voice-text-"+tc.slug)
			u1 := seedTestUser(t, database, "voiceuser-"+tc.slug)

			s1 := make(chan []byte, 4)
			c1 := ws.NewTestClient(hub, u1, s1) // channelID == 0 (no channel_focus yet)
			ws.SetClientVoiceChID(c1, chID)
			hub.RegisterNowWithReadableForTest(c1, tc.readable(chID))

			msg := []byte(`{"type":"chat_message","payload":{"content":"hello"}}`)
			hub.BroadcastToChannel(chID, msg)

			if tc.want {
				assertReceived(t, s1, msg, "voice client with READ_MESSAGES")
			} else {
				assertNotReceived(t, s1, "voice client without READ_MESSAGES")
			}
		})
	}
}

func TestHub_BroadcastToAll_StillDeliversToUnfocusedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "globaluser")
	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1) // channelID == 0 (unfocused)

	hub.Register(c1)
	waitRegistered(t, hub, c1)

	msg := []byte(`{"type":"presence","payload":{"status":"online"}}`)
	hub.BroadcastToAll(msg)

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
	waitRegistered(t, hub, c1)

	msg1 := []byte(`{"type":"chat_message","payload":{"channel":"1"}}`)
	msg2 := []byte(`{"type":"chat_message","payload":{"channel":"2"}}`)
	hub.BroadcastToChannel(ch1, msg1)
	hub.BroadcastToChannel(ch2, msg2)

	assertNotReceived(t, s1, "unfocused client must NOT receive ch1 broadcast")
}

// ─── SendToUser ───────────────────────────────────────────────────────────────

func TestHub_SendToUser_ExistingClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	userID := seedTestUser(t, database, "ivan")
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, userID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	msg := []byte(`{"type":"chat_send_ok","payload":{}}`)
	ok := hub.SendToUser(userID, msg)
	if !ok {
		t.Error("SendToUser returned false for existing client")
	}
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
	waitRegistered(t, hub, c)

	raw := []byte(`{"type":"totally_unknown","payload":{}}`)
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, []byte(`NOT JSON`))

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
	waitRegistered(t, hub, c)

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

	// Drain all messages, count errors — error replies are sent synchronously
	// by handleMessage, so they are already buffered on the send channel.
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
			waitRegistered(t, hub, c)
			hub.Unregister(c)
		}(i)
	}
	wg.Wait()
	// The hub loop drains register/unregister asynchronously; poll instead of
	// a fixed sleep, which flakes under -race on slow runners.
	waitFor(t, 5*time.Second, func() bool { return hub.ClientCount() == 0 }, "churned clients to unregister")
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
	waitRegistered(t, hub, client)

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
	waitFor(t, waitTimeout, hub.RunningForTest, "hub Run loop to start")

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
	waitRegistered(t, hub, c2)

	ws.SetClientLastActivityForTest(c1, time.Now().Add(-2*time.Minute))
	ws.SetClientLastActivityForTest(c2, time.Now())

	// sweepStaleClients kicks synchronously (kickClient) — no wait needed.
	hub.SweepStaleClientsForTest()

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
	waitRegistered(t, hub, c1)

	ws.SetClientLastActivityForTest(c1, time.Now())
	// sweepStaleClients kicks synchronously — its effects are visible on return.
	hub.SweepStaleClientsForTest()

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
	uid1, err := database.CreateUser(context.Background(), "alice-revoke", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	uid2, err := database.CreateUser(context.Background(), "bob-valid", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	u1, _ := database.GetUserByID(context.Background(), uid1)
	u2, _ := database.GetUserByID(context.Background(), uid2)

	token1 := "revoke-token-1"
	token2 := "valid-token-2"
	hash1 := auth.HashToken(token1)
	hash2 := auth.HashToken(token2)

	if _, err := database.CreateSession(context.Background(), uid1, hash1, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession 1: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid2, hash2, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession 2: %v", err)
	}

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClientWithTokenHash(hub, u1, hash1, 0, s1)
	c2 := ws.NewTestClientWithTokenHash(hub, u2, hash2, 0, s2)

	hub.Register(c1)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

	// Delete alice's session (simulating logout from another device).
	if err := database.DeleteSession(context.Background(), hash1); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	// Run the session sweep — it kicks synchronously (kickClient).
	hub.SweepRevokedSessionsForTest()

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

// TestHub_SweepRevokedSessions_KicksBannedClient verifies the sweep's batched
// session lookup carries ban status through: a client whose user was banned
// after connecting is disconnected even though its session row still exists.
func TestHub_SweepRevokedSessions_KicksBannedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	uid, err := database.CreateUser(context.Background(), "soon-banned", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	u, _ := database.GetUserByID(context.Background(), uid)

	hash := auth.HashToken("ban-sweep-token")
	if _, err := database.CreateSession(context.Background(), uid, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	s := make(chan []byte, 4)
	c := ws.NewTestClientWithTokenHash(hub, u, hash, 0, s)
	hub.Register(c)
	waitRegistered(t, hub, c)

	if err := database.BanUser(context.Background(), uid, "rule violation", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	hub.SweepRevokedSessionsForTest()

	if hub.GetClient(uid) != nil {
		t.Error("banned client should have been kicked by the session sweep")
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
	waitRegistered(t, hub, c)

	hub.SweepRevokedSessionsForTest()

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d, want 1 (client without token hash should survive)", hub.ClientCount())
	}
}

// ─── LiveKitHealthCheck ─────────────────────────────────────────────────────

func TestHub_LiveKitHealthCheck_NilReturnsError(t *testing.T) {
	hub, _ := newTestHub(t)
	ok, err := hub.LiveKitHealthCheck(context.Background())
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
				waitRegistered(t, hub, c)
			}

			got := hub.VoiceSessionCount()
			if got != tc.wantCount {
				t.Errorf("VoiceSessionCount() = %d, want %d", got, tc.wantCount)
			}
		})
	}
}

// ─── RefreshChannelVisibility ─────────────────────────────────────────────────

// drainForMsgType reads messages from send until one with the given type
// arrives or the timeout expires. Returns the decoded payload-bearing message.
func drainForMsgType(t *testing.T, send chan []byte, msgType string) map[string]any {
	t.Helper()
	deadline := time.After(500 * time.Millisecond)
	for {
		select {
		case raw := <-send:
			var msg map[string]any
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			if msg["type"] == msgType {
				return msg
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q message", msgType)
			return nil
		}
	}
}

// assertNoMsgType asserts that no message of the given type is buffered.
func assertNoMsgType(t *testing.T, send chan []byte, msgType string) {
	t.Helper()
	for {
		select {
		case raw := <-send:
			var msg map[string]any
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			if msg["type"] == msgType {
				t.Fatalf("unexpected %q message", msgType)
			}
		default:
			return
		}
	}
}

func TestRefreshChannelVisibility_TargetedSends(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "secret-room")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	owner := seedOwnerUser(t, database, "vis-owner")
	memberID := seedTestUser(t, database, "vis-member")
	member, err := database.GetUserByID(context.Background(), memberID)
	if err != nil || member == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	ownerSend := make(chan []byte, 16)
	memberSend := make(chan []byte, 16)
	ownerClient := ws.NewTestClientWithUser(hub, owner, chID, ownerSend)
	memberClient := ws.NewTestClientWithUser(hub, member, chID, memberSend)
	hub.Register(ownerClient)
	hub.Register(memberClient)
	waitRegistered(t, hub, memberClient)

	// Hide the channel from the Member role (deny ReadMessages).
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2)`,
		chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}

	hub.RefreshChannelVisibility(ch)

	// Member loses the channel; owner (admin bit) keeps it.
	drainForMsgType(t, memberSend, "channel_delete")
	drainForMsgType(t, ownerSend, "channel_create")

	// Restore visibility — the member gets the channel back.
	if _, err := database.ExecContext(context.Background(),
		`DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = 4`, chID,
	); err != nil {
		t.Fatalf("delete override: %v", err)
	}
	hub.RefreshChannelVisibility(ch)
	drainForMsgType(t, memberSend, "channel_create")
	assertNoMsgType(t, memberSend, "channel_delete")
}

// can_send used to be computed only in the ready payload, so a mid-session
// permission edit left a connected client's composer on its stale connect-time
// verdict until the socket was rebuilt. The targeted channel_create this
// fan-out sends now carries each recipient's own verdict — and because it is
// per-recipient, two clients must be able to receive different answers from
// the same RefreshChannelVisibility call.
func TestRefreshChannelVisibility_TargetedCreateCarriesPerClientCanSend(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "cansend-room")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	owner := seedOwnerUser(t, database, "cansend-owner")
	memberID := seedTestUser(t, database, "cansend-member")
	member, err := database.GetUserByID(context.Background(), memberID)
	if err != nil || member == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	ownerSend := make(chan []byte, 16)
	memberSend := make(chan []byte, 16)
	ownerClient := ws.NewTestClientWithUser(hub, owner, chID, ownerSend)
	memberClient := ws.NewTestClientWithUser(hub, member, chID, memberSend)
	hub.Register(ownerClient)
	hub.Register(memberClient)
	waitRegistered(t, hub, memberClient)

	// Member keeps READ_MESSAGES (0x0002) but loses SEND_MESSAGES (0x0001), so
	// the channel stays VISIBLE while posting is revoked — precisely the case a
	// visibility-only fan-out used to leave with a stale composer.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 1)`,
		chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}

	hub.RefreshChannelVisibility(ch)

	memberMsg := drainForMsgType(t, memberSend, "channel_create")
	memberPayload, ok := memberMsg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("member channel_create payload not an object: %#v", memberMsg["payload"])
	}
	canSend, present := memberPayload["can_send"]
	if !present {
		t.Fatal("targeted channel_create omitted can_send — the client keeps its stale connect-time verdict")
	}
	if canSend != false {
		t.Fatalf("member can_send = %v, want false (SEND_MESSAGES denied)", canSend)
	}

	// Same call, same channel, different recipient: the owner's admin bit must
	// still yield true, proving the value is resolved per client rather than
	// encoded once for the whole audience.
	ownerMsg := drainForMsgType(t, ownerSend, "channel_create")
	ownerPayload, ok := ownerMsg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("owner channel_create payload not an object: %#v", ownerMsg["payload"])
	}
	if ownerPayload["can_send"] != true {
		t.Fatalf("owner can_send = %v, want true (admin bypass)", ownerPayload["can_send"])
	}
}

func TestRefreshChannelVisibility_ForcesFullResyncForStaleResumes(t *testing.T) {
	hub, database := newTestHub(t)

	chID := seedTestChannel(t, database, "watermark-room")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	// No visibility change yet — resume is allowed regardless of seq.
	if hub.MustFullResyncForTest(1) {
		t.Error("expected replay allowed before any visibility change")
	}

	hub.SeedSeq(41)
	hub.RefreshChannelVisibility(ch)

	// Clients resuming from at/before the change must take the full path.
	if !hub.MustFullResyncForTest(41) {
		t.Error("expected forced full resync for lastSeq at the watermark")
	}
	if !hub.MustFullResyncForTest(10) {
		t.Error("expected forced full resync for lastSeq before the watermark")
	}
	// Clients that saw sequenced traffic after the change may replay.
	if hub.MustFullResyncForTest(42) {
		t.Error("expected replay allowed for lastSeq after the watermark")
	}
}

// ─── BroadcastMemberUpdate (role reassignment) ────────────────────────────────

// A role change must drop the live channel topics the new role cannot READ —
// the subscription is created once, at channel_focus, and otherwise outlives
// the authorization it was granted under. DM topics are membership-gated, not
// role-gated, so they must survive.
func TestBroadcastMemberUpdate_RevokesUnreadableSubscriptions(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	chID := seedTestChannel(t, database, "role-room")
	dmID, err := database.CreateChannel(ctx, "dm-room", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(dm): %v", err)
	}

	// Connect as Owner (reads everything) with the text channel focused.
	user := seedOwnerUser(t, database, "demote-me")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, dmID, user.ID,
	); err != nil {
		t.Fatalf("insert dm_participants: %v", err)
	}
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	// The user is a participant of this DM but has closed it (no dm_open_state
	// row), so the topic is held while being absent from the allowed set.
	hub.PubSubForTest().Subscribe(c, ws.ChannelTopic(dmID))

	// Demote to Member, with READ_MESSAGES denied to that role on the channel.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2)`, chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}
	if err := database.UpdateUserRole(ctx, user.ID, 4); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}

	hub.SeedSeq(41)
	hub.BroadcastMemberUpdate(user.ID, "member")

	msg := drainForMsgType(t, send, "channel_delete")
	payload, _ := msg["payload"].(map[string]any)
	id, _ := payload["id"].(float64)
	if int64(id) != chID {
		t.Errorf("channel_delete id = %v, want %d", payload["id"], chID)
	}

	// The socket stays up; only the unreadable topic is gone.
	if got := hub.ClientCount(); got != 1 {
		t.Fatalf("ClientCount = %d, want 1 (socket must stay up)", got)
	}
	topics := hub.PubSubForTest().TopicsForClient(user.ID)
	if slices.Contains(topics, ws.ChannelTopic(chID)) {
		t.Error("still subscribed to the revoked channel topic")
	}
	if !slices.Contains(topics, ws.ChannelTopic(dmID)) {
		t.Error("DM topic revoked by a role change (DM access is membership-gated)")
	}

	// The impact itself: channel traffic no longer reaches the demoted socket.
	// Absence assertion: bounded window for a wrongly-delivered message to
	// arrive before checking the buffer.
	hub.BroadcastToChannel(chID, []byte(`{"type":"chat_message"}`))
	time.Sleep(30 * time.Millisecond)
	assertNoMsgType(t, send, "chat_message")

	// A resume across the change must take the full-ready path.
	if !hub.MustFullResyncForTest(41) {
		t.Error("expected forced full resync for a resume at the change watermark")
	}
}

// When the new visibility cannot be resolved (DB hiccup), the socket is closed
// rather than left half-revoked: the client reconnects and rebuilds from a
// ready payload computed with the new role.
func TestBroadcastMemberUpdate_ClosesSocketWhenVisibilityUnresolved(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	chID := seedTestChannel(t, database, "hiccup-room")
	uid := seedTestUser(t, database, "hiccup-user")
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Break the override lookup computeAllowedChannels depends on.
	if _, err := database.ExecContext(ctx, `DROP TABLE channel_overrides`); err != nil {
		t.Fatalf("drop channel_overrides: %v", err)
	}

	hub.BroadcastMemberUpdate(uid, "member")

	if got := hub.ClientCount(); got != 0 {
		t.Errorf("ClientCount = %d, want 0 (socket must close when visibility is unresolved)", got)
	}
	if topics := hub.PubSubForTest().TopicsForClient(uid); len(topics) != 0 {
		t.Errorf("TopicsForClient = %v, want none", topics)
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
    ban_expires TEXT,
    identity_public_key TEXT,
    display_name TEXT,
    about TEXT,
    custom_status TEXT
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
    voice_max_video  INTEGER NOT NULL DEFAULT 0,
    nsfw             INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);

CREATE TABLE IF NOT EXISTS channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
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
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
    mentions_everyone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
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

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);
`)

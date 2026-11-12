package ws_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── test helpers ─────────────────────────────────────────────────────────────

func openTestDB(t testing.TB) *db.DB {
	t.Helper()
	return openSchemaDB(t, hubTestSchema)
}

func newTestHub(t testing.TB) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, nil)
	return hub, database
}

// seedTestUser inserts a Member-role user and returns its ID.
func seedTestUser(t testing.TB, database *db.DB, username string) int64 {
	t.Helper()
	id := mustCreateUser(t, database, username, 4)
	return id
}

// seedOwnerUser inserts an Owner-role user and returns the full *db.User.
// Owner role (id=1) has all permissions (0x7FFFFFFF), so it passes all checks.
func seedOwnerUser(t testing.TB, database *db.DB, username string) *db.User {
	t.Helper()
	return seedUserWithRole(t, database, username, 1)
}

// seedTestChannel inserts a channel and returns its ID.
func seedTestChannel(t testing.TB, database *db.DB, name string) int64 {
	t.Helper()
	return mustCreateChannel(t, database, name, "text")
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
		mustUnmarshal(t, got, &env)
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

// Voice membership can outlive READ_MESSAGES (a mid-call revocation, or a
// closed DM), so it must never on its own subscribe a client to a channel's message stream — that route requires
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
		mustUnmarshal(t, got, &resp)
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
		mustUnmarshal(t, got, &resp)
		if resp["type"] != "error" {
			t.Errorf("type = %q, want 'error'", resp["type"])
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("expected error response for invalid JSON")
	}
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

// The hub is wired with a real MessageService: the chat rate limit lives in
// SendMessage, so without one every send would be a recovered nil dereference
// and the "error" replies counted below would say nothing about rate limiting.
func TestHub_ChatSend_RateLimit(t *testing.T) {
	database := openTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, service.New(database, limiter))
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "larry")
	chID := seedTestChannel(t, database, "rl-test")
	c, send := connectClient(t, hub, user, chID, 64)

	payload := map[string]any{
		"channel_id": chID,
		"content":    "hi",
	}
	raw := envelope("chat_send", payload)

	// One real send, then exhaust the user's chat window (10 per second) so
	// the next two are refused however slowly the runner goes.
	hub.HandleMessageForTest(c, raw)
	for range 10 {
		limiter.Allow(auth.Key("chat", user.ID), 10, time.Second)
	}
	hub.HandleMessageForTest(c, raw)
	hub.HandleMessageForTest(c, raw)

	// handleMessage sends its replies synchronously, so they are already
	// buffered on the send channel.
	sendOK, rateLimited, otherErr := 0, 0, 0
drainLoop:
	for {
		select {
		case got, ok := <-send:
			if !ok {
				break drainLoop
			}
			var resp map[string]any
			if err := json.Unmarshal(got, &resp); err != nil {
				continue
			}
			switch resp["type"] {
			case "chat_send_ok":
				sendOK++
			case "error":
				payload, _ := resp["payload"].(map[string]any)
				if payload["code"] == "RATE_LIMITED" {
					rateLimited++
				} else {
					otherErr++
				}
			}
		default:
			break drainLoop
		}
	}
	if sendOK != 1 || rateLimited != 2 || otherErr != 0 {
		t.Errorf("3 sends around an exhausted window: got %d chat_send_ok, %d RATE_LIMITED, %d other errors; want 1, 2, 0",
			sendOK, rateLimited, otherErr)
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

	got := hub.ClientForTest(42)
	if got == nil {
		t.Fatal("GetClient(42) returned nil")
	}

	got2 := hub.ClientForTest(999)
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

// TestHub_NilLiveKitOption: a hub built without LiveKit (voice not
// configured) constructs fine and refuses token generation. Replaces the
// pre-B3-4 SetLiveKit nil-safety test — the setter no longer exists.
func TestHub_NilLiveKitOption(t *testing.T) {
	hub, _ := newTestHub(t)
	if _, err := hub.GenerateToken(1, "u", 1, "", false, false, false); err == nil {
		t.Fatal("GenerateToken on a voiceless hub must error")
	}
}

// TestNewHub_RequiredCollaborators pins B3-4's validation: before it,
// construction always succeeded (api tests built ws.NewHub(nil, nil, nil)
// hubs) and a missing collaborator surfaced as a later panic.
func TestNewHub_RequiredCollaborators(t *testing.T) {
	if _, err := ws.NewHub(ws.HubOptions{}); err == nil {
		t.Fatal("NewHub without DB must error")
	}
	database := openTestDB(t)
	if _, err := ws.NewHub(ws.HubOptions{DB: database}); err == nil {
		t.Fatal("NewHub without Limiter must error")
	}
	if _, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter()}); err == nil {
		t.Fatal("NewHub without a Settings reader must error")
	}
	settings := service.NewSettingsService(database)
	if _, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), Settings: settings}); err == nil {
		t.Fatal("NewHub without the reader seams must error")
	}
	// A PARTIAL seam set is refused too, not just an absent one: the bundle is
	// validated seam by seam, so a family that adds a seam cannot leave an
	// older construction site silently handing the hub a nil it will
	// dereference on the first connection that needs it.
	partial := ws.DBReaders(database)
	partial.Dispatch = nil
	if _, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), Settings: settings, Readers: partial}); err == nil {
		t.Fatal("NewHub with an incomplete reader bundle must error")
	}
	if _, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), Settings: settings, Readers: ws.DBReaders(database)}); err == nil {
		t.Fatal("NewHub without the voice store must error")
	}
	voice := service.NewVoiceService(database)
	if _, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), Settings: settings, Readers: ws.DBReaders(database), Voice: voice}); err == nil {
		t.Fatal("NewHub without the presence stamper must error")
	}
	presence := service.NewUserService(database)
	if _, err := ws.NewHub(ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), Settings: settings, Readers: ws.DBReaders(database), Voice: voice, Presence: presence}); err == nil {
		t.Fatal("NewHub without the socket authenticator must error")
	}
}

// completeHubOptions is every required collaborator present and valid — the
// baseline a test asserting on ONE bad field starts from.
//
// It exists because the negative-replay-budget case used to live at the tail
// of TestNewHub_RequiredCollaborators, where it was vacuous: that test's
// options are deliberately incomplete, so validateHubOptions returned a
// missing-collaborator error before ever reaching the budget check, and the
// assertion passed on the wrong error. Deleting the budget check outright did
// not fail it. A review bot caught it on the B3 exit scorecard, which had
// cited it as evidence.
//
// The shape is the fix: an assertion about field X must start from options
// that are valid in every OTHER field, or a later-added check upstream of X
// silently takes the assertion over.
func completeHubOptions(t *testing.T, database *db.DB) ws.HubOptions {
	t.Helper()
	return ws.HubOptions{
		DB:       database,
		Limiter:  auth.NewRateLimiter(),
		Settings: service.NewSettingsService(database),
		Readers:  ws.DBReaders(database),
		Voice:    service.NewVoiceService(database),
		Presence: service.NewUserService(database),
		Auth:     service.NewSessionService(database),
	}
}

// TestNewHub_RejectsNegativeReplayBudget pins the budget check on its own,
// from a fully valid option set, so nothing upstream can answer for it.
func TestNewHub_RejectsNegativeReplayBudget(t *testing.T) {
	database := openTestDB(t)

	// The baseline must actually construct, or every case below is vacuous
	// for the same reason the old one was.
	if _, err := ws.NewHub(completeHubOptions(t, database)); err != nil {
		t.Fatalf("the complete option set must construct, or these assertions prove nothing: %v", err)
	}

	for _, tc := range []struct {
		name       string
		ring, cold int
	}{
		{"negative ring", -1, 0},
		{"negative cold limit", 0, -1},
		{"both negative", -1, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := completeHubOptions(t, database)
			opts.ReplayRingSize = tc.ring
			opts.ReplayColdLimit = tc.cold
			if _, err := ws.NewHub(opts); err == nil {
				t.Fatalf("NewHub with ring=%d cold=%d must error", tc.ring, tc.cold)
			}
		})
	}
}

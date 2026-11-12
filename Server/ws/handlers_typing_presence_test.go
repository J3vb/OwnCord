package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── handleTyping ─────────────────────────────────────────────────────────────

// waitForClients blocks until the hub has at least n clients registered, or
// the deadline expires. Returns true if the count was reached.
func waitForClients(hub *ws.Hub, n int, deadline time.Duration) bool {
	deadlineT := time.Now().Add(deadline)
	for time.Now().Before(deadlineT) {
		if hub.ClientCount() >= n {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return hub.ClientCount() >= n
}

// TestTyping_ValidTyping_BroadcastsToOthers verifies that a typing_start event
// is delivered to other channel members but NOT to the sender.
func TestTyping_ValidTyping_BroadcastsToOthers(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "typing-chan1")

	sender := seedOwnerUser(t, database, "typing-sender1")
	watcher := seedMemberUser(t, database, "typing-watcher1")

	sendSender := make(chan []byte, 16)
	sendWatcher := make(chan []byte, 16)

	cSender := ws.NewTestClientWithUser(hub, sender, chID, sendSender)
	cWatcher := ws.NewTestClientWithUser(hub, watcher, chID, sendWatcher)

	hub.Register(cSender)
	hub.Register(cWatcher)
	// Wait until both clients are actually in the hub's client map.
	if !waitForClients(hub, 2, 500*time.Millisecond) {
		t.Fatalf("hub did not register both clients within timeout (count=%d)", hub.ClientCount())
	}
	hub.HandleMessageForTest(cSender, typingStartMsg(chID))

	// Watcher should receive a "typing" broadcast (the outbound event type from
	// buildTypingMsg is "typing", distinct from the inbound "typing_start").
	watcherMsgs := drainChanTimeout(sendWatcher, 50*time.Millisecond)
	foundTyping := false
	for _, m := range watcherMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			foundTyping = true
			break
		}
	}
	if !foundTyping {
		t.Error("watcher did not receive typing broadcast")
	}

	// Sender should NOT receive their own typing event.
	senderMsgs := drainChan(sendSender)
	for _, m := range senderMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			t.Error("sender incorrectly received their own typing event")
		}
	}
}

// TestTyping_InvalidChannelID_ReturnsBadRequest verifies that a typing_start
// with channel_id=0 returns a BAD_REQUEST error.
func TestTyping_InvalidChannelID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "typing-owner2")

	c, send := connectClient(t, hub, user, 0, 16)

	hub.HandleMessageForTest(c, typingStartMsg(0))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for channel_id=0, got %q", code)
	}
}

// TestTyping_RateLimited_SilentlyDropped verifies that a second typing_start
// within the rate-limit window is silently dropped (no error sent to client).
func TestTyping_RateLimited_SilentlyDropped(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "typing-chan3")

	sender := seedOwnerUser(t, database, "typing-sender3")
	watcher := seedMemberUser(t, database, "typing-watcher3")

	sendSender := make(chan []byte, 16)
	sendWatcher := make(chan []byte, 32)

	cSender := ws.NewTestClientWithUser(hub, sender, chID, sendSender)
	cWatcher := ws.NewTestClientWithUser(hub, watcher, chID, sendWatcher)

	hub.Register(cSender)
	hub.Register(cWatcher)
	if !waitForClients(hub, 2, 500*time.Millisecond) {
		t.Fatalf("hub did not register both clients within timeout")
	}

	// First typing event — should go through.
	hub.HandleMessageForTest(cSender, typingStartMsg(chID))
	drainChanTimeout(sendWatcher, 30*time.Millisecond)

	// Second typing event immediately — should be silently dropped.
	hub.HandleMessageForTest(cSender, typingStartMsg(chID))

	// Sender should NOT receive an error (silently dropped).
	senderMsgs := drainChanTimeout(sendSender, 50*time.Millisecond)
	for _, m := range senderMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			t.Errorf("expected silent drop for rate-limited typing, but got error: %s", m)
		}
	}

	// Watcher should NOT receive a second typing event (broadcast type is "typing").
	watcherMsgs := drainChan(sendWatcher)
	typingCount := 0
	for _, m := range watcherMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			typingCount++
		}
	}
	if typingCount > 0 {
		t.Errorf("rate-limited typing event was not dropped; watcher received %d extra typing", typingCount)
	}
}

// ─── broadcastExclude ─────────────────────────────────────────────────────────

// TestBroadcastExclude_SendsToOthersNotSelf verifies that broadcastExclude
// delivers to all channel members except the excluded user.
// This is exercised indirectly via typing_start (which calls broadcastExcludeLow).
func TestBroadcastExclude_SendsToOthersNotSelf(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "excl-chan1")

	u1 := seedOwnerUser(t, database, "excl-user1")
	u2 := seedMemberUser(t, database, "excl-user2")
	u3 := seedMemberUser(t, database, "excl-user3")

	send1 := make(chan []byte, 16)
	send2 := make(chan []byte, 16)
	send3 := make(chan []byte, 16)

	c1 := ws.NewTestClientWithUser(hub, u1, chID, send1)
	c2 := ws.NewTestClientWithUser(hub, u2, chID, send2)
	c3 := ws.NewTestClientWithUser(hub, u3, chID, send3)

	hub.Register(c1)
	hub.Register(c2)
	hub.Register(c3)
	// Wait until all three are registered in the hub's client map.
	if !waitForClients(hub, 3, 500*time.Millisecond) {
		t.Fatalf("hub did not register all 3 clients within timeout (count=%d)", hub.ClientCount())
	}

	// u1 sends a typing event — should reach u2 and u3 but NOT u1.
	hub.HandleMessageForTest(c1, typingStartMsg(chID))

	// u2 and u3 must receive the "typing" broadcast.
	for i, sendCh := range []<-chan []byte{send2, send3} {
		if receiveMsgOfType(sendCh, "typing", waitTimeout) == nil {
			t.Errorf("user%d (non-sender) did not receive typing broadcast", i+2)
		}
	}

	// u1 (sender) must NOT receive it. The fan-out that reached u2 and u3
	// has completed, so a wrongly-included copy would already be buffered.
	msgs1 := drainChan(send1)
	for _, m := range msgs1 {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			t.Error("sender (excluded user) incorrectly received their own typing event")
		}
	}
}

// TestBroadcastExclude_DifferentChannelNotReceived verifies that broadcastExclude
// does NOT deliver to clients in a different channel.
func TestBroadcastExclude_DifferentChannelNotReceived(t *testing.T) {
	hub, database := newHandlerHub(t)
	chA := seedTestChannel(t, database, "excl-chanA")
	chB := seedTestChannel(t, database, "excl-chanB")

	uA := seedOwnerUser(t, database, "excl-userA")
	uB := seedMemberUser(t, database, "excl-userB")

	sendA := make(chan []byte, 16)
	sendB := make(chan []byte, 16)

	cA := ws.NewTestClientWithUser(hub, uA, chA, sendA)
	cB := ws.NewTestClientWithUser(hub, uB, chB, sendB)

	hub.Register(cA)
	hub.Register(cB)
	if !waitForClients(hub, 2, 500*time.Millisecond) {
		t.Fatalf("hub did not register both clients within timeout")
	}

	// uA types in channel A — uB in channel B must NOT receive it.
	hub.HandleMessageForTest(cA, typingStartMsg(chA))

	msgsB := drainChanTimeout(sendB, 50*time.Millisecond)
	for _, m := range msgsB {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			t.Error("user in different channel incorrectly received typing broadcast via broadcastExclude")
		}
	}
}

// ─── handlePresence (invalid status path) ─────────────────────────────────────

// TestPresence_InvalidStatus_ReturnsBadRequest verifies that a status value
// not in the allowed set (online|idle|dnd|offline) is rejected.
func TestPresence_InvalidStatus_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "presence-bad1")

	c, send := connectClient(t, hub, user, 0, 16)

	hub.HandleMessageForTest(c, presenceUpdateMsg("afk"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid status, got %q", code)
	}
}

// TestPresence_ValidStatus_Broadcasts verifies that valid statuses are accepted
// and broadcast to all connected clients.
func TestPresence_ValidStatus_Broadcasts(t *testing.T) {
	validStatuses := []string{"online", "idle", "dnd", "offline"}
	for _, status := range validStatuses {
		t.Run(status, func(t *testing.T) {
			hub, database := newHandlerHub(t)
			user := seedOwnerUser(t, database, "presence-valid-"+status)

			c, send := connectClient(t, hub, user, 0, 16)

			hub.HandleMessageForTest(c, presenceUpdateMsg(status))

			// Must NOT receive a BAD_REQUEST error.
			msgs := drainChanTimeout(send, 50*time.Millisecond)
			for _, m := range msgs {
				var env map[string]any
				if err := json.Unmarshal(m, &env); err != nil {
					continue
				}
				if env["type"] == "error" {
					if payload, ok := env["payload"].(map[string]any); ok {
						if payload["code"] == "BAD_REQUEST" {
							t.Errorf("valid status %q was incorrectly rejected", status)
						}
					}
				}
			}
		})
	}
}

// ─── handleChannelFocus (additional edge cases) ───────────────────────────────

// TestChannelFocus_ValidFocus_UpdatesChannelID verifies that a successful
// channel_focus updates the client's tracked channel so subsequent broadcasts
// to that channel reach the client.
func TestChannelFocus_ValidFocus_UpdatesChannelID(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "focus-update1")
	chID := seedTestChannel(t, database, "focus-update-chan")

	send := make(chan []byte, 32)
	// Start client on channel 0.
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Focus on chID.
	raw := envelope("channel_focus", map[string]any{"channel_id": chID})
	hub.HandleMessageForTest(c, raw)

	// No error expected.
	msgs := drainChanTimeout(send, 50*time.Millisecond)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			t.Errorf("unexpected error on valid channel_focus: %s", m)
		}
	}

	// Now broadcast to chID — client should receive it because channel was focused.
	hub.BroadcastToChannel(chID, []byte(`{"type":"ping","payload":{}}`))

	if receiveMsgOfType(send, "ping", waitTimeout) == nil {
		t.Error("client did not receive broadcast after channel_focus updated its channelID")
	}
}

// TestChannelFocus_InvalidChannelID_NoResponse verifies that a channel_focus
// with channel_id=0 is silently ignored (no crash, no error message).
func TestChannelFocus_InvalidChannelID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "focus-invalid1")

	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("channel_focus", map[string]any{"channel_id": 0})
	hub.HandleMessageForTest(c, raw)

	// Constructor rejects channel_id <= 0 with BAD_REQUEST.
	msgs := drainChanTimeout(send, 50*time.Millisecond)
	found := false
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			found = true
		}
	}
	if !found {
		t.Error("expected BAD_REQUEST error for channel_id=0, got nothing")
	}
}

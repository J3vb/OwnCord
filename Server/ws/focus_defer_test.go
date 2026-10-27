package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func focusFrame(chID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "channel_focus",
		"id":      fmt.Sprintf("req-%d", chID),
		"payload": map[string]any{"channel_id": chID},
	})
	return raw
}

// newFocusHub builds a hub with real services, one Owner user and n channels,
// and a client whose context the caller controls.
func newFocusHub(t *testing.T, n int) (*Hub, *Client, []int64, context.CancelFunc) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	limiter := auth.NewRateLimiter()
	hub := newTestHub(t, database, limiter, service.New(database, limiter))

	uid, err := database.CreateUser(context.Background(), "fastswitch", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), "fastswitch")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	chans := make([]int64, 0, n)
	for i := range n {
		id, err := database.CreateChannel(context.Background(), fmt.Sprintf("fs-%d", i), "text", "", "", i)
		if err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		chans = append(chans, id)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	send := make(chan []byte, 64)
	c := &Client{hub: hub, ctx: ctx, userID: uid, user: user, send: send, sendHigh: send, sendLow: send}
	return hub, c, chans, cancel
}

func subscribed(h *Hub, c *Client, ch int64) bool {
	for _, tp := range h.pubsub.TopicsForUser(c.userID) {
		if tp == ChannelTopic(ch) {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func drainActive(c *Client) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.focusDrainActive
}

func TestChannelFocusBurst_LandsOnLastChannel(t *testing.T) {
	hub, c, chans, _ := newFocusHub(t, 6)
	for _, id := range chans {
		hub.HandleMessageForTest(c, focusFrame(id))
	}
	last, fifth := chans[5], chans[4]
	waitFor(t, "client to land on the 6th channel", func() bool { return c.getChannelID() == last })
	waitFor(t, "subscription to the 6th channel", func() bool { return subscribed(hub, c, last) })
	if subscribed(hub, c, fifth) {
		t.Error("client must have left the 5th channel's topic")
	}
	waitFor(t, "drain goroutine to exit", func() bool { return !drainActive(c) })
}

// Two deferrals in a row: only the newest intent may land.
func TestChannelFocusBurst_NewestDeferredWins(t *testing.T) {
	hub, c, chans, _ := newFocusHub(t, 7)
	for _, id := range chans { // 6th and 7th are both deferred
		hub.HandleMessageForTest(c, focusFrame(id))
	}
	waitFor(t, "client to land on the 7th channel", func() bool { return c.getChannelID() == chans[6] })
	waitFor(t, "drain goroutine to exit", func() bool { return !drainActive(c) })
	if subscribed(hub, c, chans[5]) {
		t.Error("superseded deferred channel must not stay subscribed")
	}
}

// A focus applied by the normal path supersedes a pending deferred intent, so
// the drain finds nothing to apply and a stale channel cannot overwrite it.
func TestChannelFocusBurst_AppliedFocusClearsPending(t *testing.T) {
	hub, c, chans, _ := newFocusHub(t, 7)
	hub.deferChannelFocus(c, chans[5], "req-defer", true)
	hub.applyFocusResult(c, MsgTypeChannelFocus, chans[6])
	c.mu.Lock()
	pending := c.pendingFocusChID
	c.mu.Unlock()
	if pending != 0 {
		t.Fatalf("pendingFocusChID = %d, want 0 after a newer applied focus", pending)
	}
	waitFor(t, "drain goroutine to exit", func() bool { return !drainActive(c) })
	if got := c.getChannelID(); got != chans[6] {
		t.Fatalf("channel = %d, want %d", got, chans[6])
	}
	if subscribed(hub, c, chans[5]) {
		t.Error("stale deferred channel must not be subscribed")
	}
}

func TestChannelFocusBurst_DisconnectStopsDrain(t *testing.T) {
	hub, c, chans, cancel := newFocusHub(t, 6)
	for _, id := range chans {
		hub.HandleMessageForTest(c, focusFrame(id))
	}
	if !drainActive(c) {
		t.Fatal("6th frame should have started a drain goroutine")
	}
	cancel()
	waitFor(t, "drain goroutine to exit after disconnect", func() bool { return !drainActive(c) })
	time.Sleep(2 * focusDrainInterval)
	if subscribed(hub, c, chans[5]) || c.getChannelID() == chans[5] {
		t.Error("deferred focus must not apply after the client disconnected")
	}
}

// A newer in-budget focus that fails (here: a channel that does not exist)
// still supersedes the pending deferred one, so the user is never moved back
// to a channel they only passed through.
func TestChannelFocusBurst_FailedFocusSupersedesPending(t *testing.T) {
	hub, c, chans, _ := newFocusHub(t, 1)
	hub.deferChannelFocus(c, chans[0], "req-defer", true)
	hub.HandleMessageForTest(c, focusFrame(999_999))
	waitFor(t, "drain goroutine to exit", func() bool { return !drainActive(c) })
	if subscribed(hub, c, chans[0]) || c.getChannelID() == chans[0] {
		t.Error("deferred focus must not land after a newer focus frame")
	}
}

// A deferred read:false focus must stay read:false when the drain applies it:
// it subscribes without marking the channel read, while a deferred default
// focus does mark it.
func TestDeferredFocus_KeepsReadFlag(t *testing.T) {
	hub, c, chans, _ := newFocusHub(t, 2)
	ctx := context.Background()
	if _, err := hub.db.CreateMessage(ctx, chans[0], c.userID, "unread", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := hub.db.CreateMessage(ctx, chans[1], c.userID, "unread", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	hub.deferChannelFocus(c, chans[0], "req-noread", false)
	waitFor(t, "read:false focus to land", func() bool { return c.getChannelID() == chans[0] })
	waitFor(t, "drain goroutine to exit", func() bool { return !drainActive(c) })
	if _, _, found, err := hub.db.GetReadState(ctx, c.userID, chans[0]); err != nil || found {
		t.Errorf("deferred read:false focus wrote a read state (found=%v err=%v)", found, err)
	}

	hub.deferChannelFocus(c, chans[1], "req-read", true)
	waitFor(t, "default focus to land", func() bool { return c.getChannelID() == chans[1] })
	waitFor(t, "drain goroutine to exit", func() bool { return !drainActive(c) })
	if _, _, found, err := hub.db.GetReadState(ctx, c.userID, chans[1]); err != nil || !found {
		t.Errorf("deferred default focus left no read state (found=%v err=%v)", found, err)
	}
}

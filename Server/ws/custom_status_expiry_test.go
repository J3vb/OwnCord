package ws

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type expiryFrame struct {
	Type    string `json:"type"`
	Payload struct {
		UserID       int64   `json:"user_id"`
		Status       string  `json:"status"`
		CustomStatus *string `json:"custom_status"`
	} `json:"payload"`
}

func decodeExpiryFrame(t testing.TB, raw []byte) expiryFrame {
	t.Helper()
	var f expiryFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("unmarshal frame: %v", err)
	}
	return f
}

// drainBroadcast returns every broadcast queued so far, in enqueue order.
func drainBroadcast(h *Hub) []broadcastMsg {
	var out []broadcastMsg
	for {
		select {
		case bm := <-h.broadcast:
			out = append(out, bm)
		default:
			return out
		}
	}
}

func newExpiryHub(c *Client) *Hub {
	return &Hub{
		broadcast: make(chan broadcastMsg, 1024),
		clients:   map[int64][]*Client{c.userID: {c}},
		stop:      make(chan struct{}),
	}
}

func newExpiryClient(status string, text string, tag string) *Client {
	c := &Client{userID: 7, send: make(chan []byte, 16)}
	s := text
	c.presence.Store(&livePresence{status: status, customStatus: &s, customStatusExpiresAt: tag})
	return c
}

func TestVisibleCustomStatus(t *testing.T) {
	txt := "x"
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		text    *string
		expires string
		want    bool
	}{
		{"no text", nil, "2099-01-01T00:00:00Z", false},
		{"no expiry", &txt, "", true},
		{"future", &txt, "2026-10-15T12:00:01Z", true},
		{"exactly now", &txt, "2026-10-15T12:00:00Z", false},
		{"past", &txt, "2026-10-15T11:59:59Z", false},
		{"unparseable keeps text", &txt, "garbage", true},
	}
	for _, tc := range cases {
		if got := visibleCustomStatus(tc.text, tc.expires, now) != nil; got != tc.want {
			t.Errorf("%s: visible = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestCustomStatusExpired_BroadcastsNullPresence(t *testing.T) {
	const tag = "2026-10-15T12:00:00Z"
	t.Run("visible", func(t *testing.T) {
		c := newExpiryClient(db.StatusDND, "lunch", tag)
		h := newExpiryHub(c)
		h.CustomStatusExpired(7, tag)

		frames := drainBroadcast(h)
		if len(frames) != 1 || frames[0].excludeUserID != 0 {
			t.Fatalf("broadcasts = %+v, want one global frame", frames)
		}
		f := decodeExpiryFrame(t, frames[0].msg)
		if f.Type != MsgTypePresence || f.Payload.UserID != 7 || f.Payload.Status != db.StatusDND || f.Payload.CustomStatus != nil {
			t.Fatalf("frame = %+v, want dnd presence with null custom_status", f)
		}
		if p := c.livePresence(); p.status != db.StatusDND || p.customStatus != nil || p.customStatusExpiresAt != "" {
			t.Fatalf("live presence = %+v, want status kept and status text cleared", p)
		}
	})
	t.Run("invisible splits", func(t *testing.T) {
		c := newExpiryClient(db.StatusInvisible, "secret", tag)
		h := newExpiryHub(c)
		h.CustomStatusExpired(7, tag)

		frames := drainBroadcast(h)
		if len(frames) != 1 || frames[0].excludeUserID != 7 {
			t.Fatalf("broadcasts = %+v, want one frame excluding the owner", frames)
		}
		pub := decodeExpiryFrame(t, frames[0].msg)
		if pub.Payload.Status != db.StatusOffline || pub.Payload.CustomStatus != nil {
			t.Fatalf("public frame = %+v, want offline with null custom_status", pub)
		}
		select {
		case raw := <-c.send:
			self := decodeExpiryFrame(t, raw)
			if self.Payload.Status != db.StatusInvisible || self.Payload.CustomStatus != nil {
				t.Fatalf("owner frame = %+v, want invisible with null custom_status", self)
			}
		default:
			t.Fatal("the invisible owner was not sent their own frame")
		}
	})
}

func TestCustomStatusExpired_SupersededTagIsNoop(t *testing.T) {
	c := newExpiryClient(db.StatusOnline, "new", "2026-10-15T13:00:00Z")
	h := newExpiryHub(c)
	// A connect presence queued for this user must survive a stale clear.
	h.queuePresenceNoTimer(7, pendingPresence{status: db.StatusOnline})

	h.CustomStatusExpired(7, "2026-10-15T12:00:00Z")

	if frames := drainBroadcast(h); len(frames) != 0 {
		t.Fatalf("a superseded tag sent %d frames, want none", len(frames))
	}
	if p := c.livePresence(); p.customStatus == nil || *p.customStatus != "new" {
		t.Fatalf("live presence = %+v, want the newer status untouched", p)
	}
	h.presenceMu.Lock()
	_, queued := h.presenceQueue[7]
	h.presenceMu.Unlock()
	if !queued {
		t.Fatal("a stale clear dropped the queued connect presence")
	}
	// No client, and a client that has not stamped a presence yet: both no-ops.
	h.CustomStatusExpired(99, "x")
	h.clients[8] = []*Client{{userID: 8}}
	h.CustomStatusExpired(8, "x")
}

// queuePresenceNoTimer fills the coalescer without arming its flush timer.
func (h *Hub) queuePresenceNoTimer(userID int64, p pendingPresence) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	if h.presenceQueue == nil {
		h.presenceQueue = make(map[int64]pendingPresence)
	}
	h.presenceQueue[userID] = p
	h.presenceFlushArmed = true
}

// A set landing in the same instant as the old status's expiry: whichever side
// wins, the observer's last frame for the user must be what the database
// holds, never a null laid over the newer text.
//
// This only probabilistically catches a missing tag check (the interleaving has
// to land); TestCustomStatusExpired_SupersededTagIsNoop is the deterministic
// guard for it.
func TestCustomStatusExpired_RaceWithPresenceUpdate(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "racer", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	str := func(s string) *string { return &s }

	for round := range 200 {
		const oldTag, newTag = "2026-10-15T12:00:00Z", "2026-10-15T12:30:00Z"
		if err := database.UpdateUserPresence(ctx, uid, db.StatusOnline, str("old"), str(oldTag)); err != nil {
			t.Fatal(err)
		}
		c := &Client{userID: uid, send: make(chan []byte, 16)}
		c.presence.Store(&livePresence{status: db.StatusOnline, customStatus: str("old"), customStatusExpiresAt: oldTag})
		h := newExpiryHub(c)

		var wg sync.WaitGroup
		start := make(chan struct{})
		wg.Add(2)
		go func() { // the expirer
			defer wg.Done()
			<-start
			ok, err := database.ClearCustomStatusIfExpiry(ctx, uid, oldTag)
			if err != nil {
				t.Error(err)
				return
			}
			if ok {
				h.CustomStatusExpired(uid, oldTag)
			}
		}()
		go func() { // presence_update with a new status
			defer wg.Done()
			<-start
			if err := database.UpdateUserPresence(ctx, uid, db.StatusOnline, str("new"), str(newTag)); err != nil {
				t.Error(err)
				return
			}
			// handleMessageApply stores the live presence, then emits.
			c.setLivePresence(db.StatusOnline, str("new"), newTag)
			h.EmitEvents(ctx, presenceEvents(uid, db.StatusOnline, str("new"), nil, nil))
		}()
		close(start)
		wg.Wait()

		stored, err := database.GetUserByID(ctx, uid)
		if err != nil {
			t.Fatal(err)
		}
		frames := drainBroadcast(h)
		if len(frames) == 0 {
			t.Fatalf("round %d: no frames", round)
		}
		last := decodeExpiryFrame(t, frames[len(frames)-1].msg)
		switch {
		case stored.CustomStatus == nil && last.Payload.CustomStatus != nil,
			stored.CustomStatus != nil && (last.Payload.CustomStatus == nil || *last.Payload.CustomStatus != *stored.CustomStatus):
			t.Fatalf("round %d: last frame custom_status = %v, database = %v", round, last.Payload.CustomStatus, stored.CustomStatus)
		}
	}
}

// A same-account reconnect that replaces the client between the expirer's
// lookup and presenceMu must not let the detached client's matching tag send a
// null over the replacement's own status.
func TestCustomStatusExpired_ReplacedClientIsNoop(t *testing.T) {
	old := newExpiryClient(db.StatusOnline, "old", "2026-10-15T12:00:00Z")
	h := newExpiryHub(old)
	replacement := newExpiryClient(db.StatusOnline, "new", "")
	customStatusExpiredLookupHook = func(h *Hub) {
		h.mu.Lock()
		h.clients[7] = []*Client{replacement}
		h.mu.Unlock()
	}
	t.Cleanup(func() { customStatusExpiredLookupHook = nil })

	h.CustomStatusExpired(7, "2026-10-15T12:00:00Z")

	if frames := drainBroadcast(h); len(frames) != 0 {
		t.Fatalf("a replaced client sent %d frames, want none", len(frames))
	}
	if p := replacement.livePresence(); p.customStatus == nil || *p.customStatus != "new" {
		t.Fatalf("replacement presence = %+v, want untouched", p)
	}
}

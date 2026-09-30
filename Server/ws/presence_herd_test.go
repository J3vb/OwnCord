package ws

// presence_herd_test.go — P5-S03. A connect herd of existing members used to
// fan one member_join and one presence frame per arrival out to every
// connected client: N² frames on the 256-slot normal queue, so a client that
// could not drain fast enough was kicked, and its reconnect fed the herd
// (291–451 kicks at 500 sockets, data/dp-p2t8/presence-overflow.md). The
// arrivals now ride one presence_batch per coalescing window.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// herdClient is a headless connection with the production queue sizes that
// never drains until the herd is over — the worst case for the overflow.
func herdClient(ctx context.Context, h *Hub, user *db.User) *Client {
	c := newClient(h, nil, user, "", 0, ctx)
	c.roleName = "member"
	return c
}

// applyPresenceFrames folds a client's queued frames into its presence view,
// the way the client's handlers do.
func applyPresenceFrames(t *testing.T, view map[int64]string, frames [][]byte) {
	t.Helper()
	for _, raw := range frames {
		var f struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame: %v", err)
		}
		switch f.Type {
		case MsgTypePresence:
			var p presencePayload
			_ = json.Unmarshal(f.Payload, &p)
			view[p.UserID] = p.Status
		case MsgTypePresenceBatch:
			var p struct {
				Updates []presencePayload `json:"updates"`
				Full    bool              `json:"full"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			if p.Full {
				for uid := range view {
					view[uid] = db.StatusOffline
				}
			}
			for _, u := range p.Updates {
				view[u.UserID] = u.Status
			}
		}
	}
}

func drain(ch chan []byte) [][]byte {
	var out [][]byte
	for {
		select {
		case m, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, m)
		default:
			return out
		}
	}
}

func TestPresenceHerd_500ConnectsInOneSecond_NoKicks(t *testing.T) {
	if testing.Short() {
		t.Skip("herd simulation")
	}
	database := newTeardownTestDB(t)
	ctx := context.Background()
	h := newTestHub(t, database, nil, nil)
	go h.Run()
	t.Cleanup(h.Stop)

	const n = 500
	users := make([]*db.User, n)
	for i := range users {
		id, err := database.CreateUser(ctx, fmt.Sprintf("herd-%03d", i), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		// An existing member: has connected before, so last_seen is set.
		if err := database.UpdateUserStatus(ctx, id, db.StatusOffline); err != nil {
			t.Fatalf("UpdateUserStatus: %v", err)
		}
		if users[i], err = database.GetUserByID(ctx, id); err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
	}

	clients := make([]*Client, n)
	views := make([]map[int64]string, n)
	start := time.Now()
	for i, u := range users {
		c := herdClient(ctx, h, u)
		h.registerNow(c, nil)
		c.user.Status = db.StatusOnline
		c.setLiveStatus(db.StatusOnline)
		// The ready payload: every connected member as the hub sees them.
		views[i] = h.liveStatuses()
		h.announceFreshConnect(c)
		clients[i] = c
		time.Sleep(time.Until(start.Add(time.Duration(i+1) * time.Second / n)))
	}

	// Two windows for the last arrivals to flush, then a dispatch barrier.
	time.Sleep(2 * presenceCoalesceWindow)
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	if got := h.bpQueueDisconnects.Load(); got != 0 {
		t.Fatalf("backpressure_queue_disconnects = %d, want 0", got)
	}
	for i, c := range clients {
		applyPresenceFrames(t, views[i], drain(c.send))
		for _, u := range users {
			if views[i][u.ID] != db.StatusOnline {
				t.Fatalf("client %d sees user %d as %q, want online", i, u.ID, views[i][u.ID])
			}
		}
	}
}

package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// The replay pipeline after an erasure (data-lifecycle O5): frames the
// subject produced sit in the ring buffer and, with a slow flush interval,
// in the persister's queue; the erasure's member_ban is one more frame
// naming them. With the hub installed on the runner, the erasure must leave
// none of them — not in the ring, not in the store, and the queued ones
// must not be written back after the purge.
func TestErasure_PurgesTheReplayPipeline(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubWith(t, ws.HubOptions{DB: database, Limiter: limiter, Services: svc})
	// A flush interval no test waits for: only the barrier writes the rows.
	persister := ws.NewEventPersister(database, 256, 64, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	persister.Start(ctx)
	t.Cleanup(func() { persister.Stop(context.Background()) })
	hub.SetEventPersister(persister)
	hub.SetEventStore(database)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	svc.Erasure.SetHub(hub)

	if _, err := database.CreateUser(ctx, "replay-other-owner", "hash", 1); err != nil {
		t.Fatal(err)
	}
	subject := seedCoverageOwner(t, database, "replay-subject")
	observer := seedCoverageOwner(t, database, "replay-observer")
	chID := seedTestChannel(t, database, "replay-chan")
	subjectSend := make(chan []byte, 64)
	observerSend := make(chan []byte, 64)
	sc := ws.NewTestClientWithUser(hub, subject, chID, subjectSend)
	oc := ws.NewTestClientWithUser(hub, observer, chID, observerSend)
	hub.Register(sc)
	hub.Register(oc)
	waitRegistered(t, hub, sc)
	waitRegistered(t, hub, oc)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": map[string]any{"channel_id": chID, "content": "erase me from replay"},
	})
	hub.HandleMessageForTest(sc, raw)
	waitFor(t, waitTimeout, func() bool { return namedInRing(hub, subject.ID) > 0 }, "the subject's chat frame to reach the ring buffer")
	// The observer's own frame is the control: it must survive the purge.
	otherRaw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": map[string]any{"channel_id": chID, "content": "observer stays"},
	})
	hub.HandleMessageForTest(oc, otherRaw)
	waitFor(t, waitTimeout, func() bool { return namedInRing(hub, observer.ID) > 0 }, "the observer's chat frame to reach the ring buffer")
	if n := countEventsNaming(t, database, subject.ID); n != 0 {
		t.Fatalf("events persisted before any flush = %d, want 0 (the frame is queued)", n)
	}

	if err := svc.Erasure.Erase(ctx, subject.ID); err != nil {
		t.Fatalf("Erase: %v", err)
	}

	// The observer saw the member_ban live.
	waitFor(t, waitTimeout, func() bool { return sawType(observerSend, "member_ban") }, "the observer to receive member_ban")
	// Nothing naming the subject is left in either tier, the member_ban
	// included; the queued chat frame was flushed and deleted, not lost in
	// flight to be written back later.
	if n := namedInRing(hub, subject.ID); n != 0 {
		t.Errorf("ring buffer still holds %d frames naming the subject", n)
	}
	if n := countEventsNaming(t, database, subject.ID); n != 0 {
		t.Errorf("events table still holds %d rows naming the subject", n)
	}
	if err := persister.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if n := countEventsNaming(t, database, subject.ID); n != 0 {
		t.Errorf("a later flush wrote %d rows naming the subject back", n)
	}
	// The observer's own frame survived the purge, in both tiers.
	if n := countEventsNaming(t, database, observer.ID); n != 1 {
		t.Errorf("events naming the observer = %d, want 1", n)
	}
	if n := namedInRing(hub, observer.ID); n != 1 {
		t.Errorf("ring frames naming the observer = %d, want 1", n)
	}
}

func namedInRing(hub *ws.Hub, uid int64) int {
	n := 0
	for _, frame := range hub.ReplayBuffer().AllFramesForTest() {
		if ws.EventNamesUserForTest(frame, uid) {
			n++
		}
	}
	return n
}

func countEventsNaming(t *testing.T, database *db.DB, uid int64) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM events WHERE `+db.EventNamesUserPredicate, uid).Scan(&n); err != nil {
		t.Fatalf("count events: %v", err)
	}
	return n
}

// sawType drains ch without blocking and reports whether a frame of the
// given type was among what has arrived so far.
func sawType(ch <-chan []byte, want string) bool {
	for {
		select {
		case msg := <-ch:
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg, &env) == nil && env.Type == want {
				return true
			}
		default:
			return false
		}
	}
}

func TestEventPersister_FlushIsABarrier(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	p := ws.NewEventPersister(database, 16, 8, time.Hour)
	// Not started: nothing to wait for.
	if err := p.Flush(context.Background()); err != nil {
		t.Fatalf("Flush before Start: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p.Start(ctx)
	for i := 1; i <= 3; i++ {
		p.Enqueue(int64(i), "typing", 0, []byte(`{"seq":`+string(rune('0'+i))+`,"type":"typing","payload":{"user_id":7}}`))
	}
	var before int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&before)
	if before != 0 {
		t.Fatalf("rows before the barrier = %d, want 0 (hour-long flush interval)", before)
	}
	if err := p.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	var after int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&after)
	if after != 3 {
		t.Errorf("rows after the barrier = %d, want 3", after)
	}
	p.Stop(context.Background())
	if err := p.Flush(ctx); err != nil {
		t.Errorf("Flush after Stop = %v, want nil", err)
	}
	persisted, _, _, _ := p.Stats()
	if persisted != 3 {
		t.Errorf("persisted = %d, want 3", persisted)
	}
}

func TestEventRingBuffer_RemoveWhere(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	for i := uint64(1); i <= 6; i++ {
		rb.Push(i, 0, []byte{byte(i)})
	}
	removed := rb.RemoveWhere(func(data []byte) bool { return data[0]%2 == 0 })
	if removed != 3 {
		t.Fatalf("removed = %d, want 3 (seq 2, 4 and 6)", removed)
	}
	// EventsSince is strictly after its argument and refuses the oldest
	// slot itself, so replay from seq 2.
	got := rb.EventsSince(2)
	if len(got) != 2 || got[0][0] != 3 || got[1][0] != 5 {
		t.Errorf("EventsSince(2) = %v, want [3 5]", got)
	}
	if rb.OldestSeq() != 1 || rb.NewestSeq() != 6 {
		t.Errorf("coverage window = %d..%d, want 1..6 (slots keep their seq)", rb.OldestSeq(), rb.NewestSeq())
	}
	if filtered := rb.EventsSinceFiltered(2, map[int64]bool{}); len(filtered) != 2 {
		t.Errorf("EventsSinceFiltered = %d frames, want 2", len(filtered))
	}
	if all := rb.AllFramesForTest(); len(all) != 3 {
		t.Errorf("frames held = %d, want 3", len(all))
	}
	if rb.RemoveWhere(func([]byte) bool { return true }) != 3 {
		t.Errorf("second RemoveWhere should drop the remaining 3")
	}
	if got := rb.EventsSince(2); len(got) != 0 {
		t.Errorf("EventsSince after emptying = %v, want none", got)
	}
}

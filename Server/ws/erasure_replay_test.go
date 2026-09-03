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
	removed := rb.RemoveWhere(func(data []byte) bool { return data[0] == 4 })
	if removed != 1 {
		t.Fatalf("removed = %d, want 1 (seq 4)", removed)
	}
	// A range crossing the cleared slot cannot be replayed: nil, the full
	// ready. A range entirely after it still replays.
	if got := rb.EventsSince(2); got != nil {
		t.Errorf("EventsSince(2) across the cleared slot = %v, want nil", got)
	}
	if got := rb.EventsSinceFiltered(2, map[int64]bool{}); got != nil {
		t.Errorf("EventsSinceFiltered(2) across the cleared slot = %v, want nil", got)
	}
	got := rb.EventsSince(4)
	if len(got) != 2 || got[0][0] != 5 || got[1][0] != 6 {
		t.Errorf("EventsSince(4) = %v, want [5 6]", got)
	}
	if rb.OldestSeq() != 1 || rb.NewestSeq() != 6 {
		t.Errorf("coverage window = %d..%d, want 1..6 (slots keep their seq)", rb.OldestSeq(), rb.NewestSeq())
	}
	if all := rb.AllFramesForTest(); len(all) != 5 {
		t.Errorf("frames held = %d, want 5", len(all))
	}
	if rb.RemoveWhere(func([]byte) bool { return true }) != 5 {
		t.Errorf("second RemoveWhere should drop the remaining 5")
	}
	if got := rb.EventsSince(6); got == nil || len(got) != 0 {
		t.Errorf("EventsSince(newest) after emptying = %v, want an empty replay (caught up)", got)
	}
}

// After a purge, a client that has not acked past the purge watermark takes
// the full ready: the ring replay over the cleared slot returns nil and
// mustFullResync reports true — the erased member never lingers on a
// reconnecting client. And a producer that reaches the hub after the purge
// with a frame naming the erased user is dropped, not sequenced.
func TestErasure_PurgeForcesFullResyncAndDropsLateFrames(t *testing.T) {
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

	if _, err := database.CreateUser(ctx, "resync-other-owner", "hash", 1); err != nil {
		t.Fatal(err)
	}
	subject := seedCoverageOwner(t, database, "resync-subject")
	observer := seedCoverageOwner(t, database, "resync-observer")
	chID := seedTestChannel(t, database, "resync-chan")
	subjectSend := make(chan []byte, 64)
	observerSend := make(chan []byte, 64)
	sc := ws.NewTestClientWithUser(hub, subject, chID, subjectSend)
	oc := ws.NewTestClientWithUser(hub, observer, chID, observerSend)
	hub.Register(sc)
	hub.Register(oc)
	waitRegistered(t, hub, sc)
	waitRegistered(t, hub, oc)

	chat := func(c *ws.Client, content string) {
		raw, _ := json.Marshal(map[string]any{"type": "chat_send", "payload": map[string]any{"channel_id": chID, "content": content}})
		hub.HandleMessageForTest(c, raw)
	}
	chat(oc, "observer before")
	chat(oc, "observer again")
	waitFor(t, waitTimeout, func() bool { return namedInRing(hub, observer.ID) >= 2 }, "the observer's frames in the ring")
	// A client that acked the observer's frames but not the subject's.
	// (EventsSince is strictly after its argument and refuses the oldest
	// slot itself, so the ack sits on the second frame.)
	lastSeq := hub.CurrentSeqForTest()
	chat(sc, "subject before")
	waitFor(t, waitTimeout, func() bool { return namedInRing(hub, subject.ID) > 0 }, "the subject's frame in the ring")
	if hub.MustFullResyncForTest(lastSeq) {
		t.Fatal("full resync forced before any purge")
	}
	if got := hub.ReplayBuffer().EventsSince(lastSeq); got == nil {
		t.Fatal("replay from the oldest slot unavailable before the purge")
	}

	if err := svc.Erasure.Erase(ctx, subject.ID); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	waitFor(t, waitTimeout, func() bool { return sawType(observerSend, "member_ban") }, "member_ban at the observer")

	if !hub.MustFullResyncForTest(lastSeq) {
		t.Error("a client resuming from before the purge is not forced to a full ready")
	}
	if hub.MustFullResyncForTest(hub.CurrentSeqForTest()) {
		t.Error("a client caught up past the purge is forced to a full ready")
	}
	if got := hub.ReplayBuffer().EventsSince(lastSeq); got != nil {
		t.Errorf("replay across the cleared slot = %d frames, want nil", len(got))
	}
	if got := hub.ReplayBuffer().EventsSinceFiltered(lastSeq, map[int64]bool{chID: true}); got != nil {
		t.Errorf("filtered replay across the cleared slot = %d frames, want nil", len(got))
	}

	// The late producer: a frame naming the erased user arrives after the
	// purge. It must not be sequenced, buffered or persisted.
	before := hub.CurrentSeqForTest()
	late, _ := json.Marshal(map[string]any{"type": "chat_message", "payload": map[string]any{"channel_id": chID, "user": map[string]any{"id": subject.ID}, "content": "late"}})
	hub.BroadcastToAll(late)
	harmless, _ := json.Marshal(map[string]any{"type": "typing", "payload": map[string]any{"channel_id": chID, "user_id": observer.ID}})
	hub.BroadcastToAll(harmless)
	waitFor(t, waitTimeout, func() bool { return hub.CurrentSeqForTest() > before }, "the harmless frame to be sequenced")
	if hub.CurrentSeqForTest() != before+1 {
		t.Errorf("seq advanced by %d, want 1 (the late frame naming the erased user must not take a seq)", hub.CurrentSeqForTest()-before)
	}
	if n := namedInRing(hub, subject.ID); n != 0 {
		t.Errorf("ring holds %d frames naming the erased user after the late broadcast", n)
	}
	if err := persister.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countEventsNaming(t, database, subject.ID); n != 0 {
		t.Errorf("events table holds %d rows naming the erased user after the late broadcast", n)
	}
}

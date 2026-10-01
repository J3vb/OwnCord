package ws

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// TestGracefulStopContext_IdleSkipsNoticeWait locks the idle fast path: with
// nobody connected there is no one to hear the restart notice, so shutdown
// must not sleep the 5s countdown.
func TestGracefulStopContext_IdleSkipsNoticeWait(t *testing.T) {
	h := &Hub{stop: make(chan struct{})}
	start := time.Now()
	h.GracefulStopContext(context.Background(), RestartReasonShutdown)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("idle GracefulStop took %v, want fast (no notice sleep)", elapsed)
	}
}

// TestGracefulStopContext_BudgetBoundsNoticeWait locks the shutdown-budget
// contract: with clients connected, the notice wait ends when the caller's
// context expires instead of always burning the full 5 seconds.
func TestGracefulStopContext_BudgetBoundsNoticeWait(t *testing.T) {
	send := make(chan []byte, 8)
	h := &Hub{stop: make(chan struct{})}
	c := &Client{hub: h, send: send, sendHigh: send, sendLow: send}
	h.clients = map[int64]*Client{1: c}
	h.pubsub = NewPubSub()
	h.pubsub.Subscribe(c, TopicGlobal)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	h.GracefulStopContext(ctx, RestartReasonShutdown)
	elapsed := time.Since(start)
	if elapsed >= 5*time.Second {
		t.Fatalf("GracefulStopContext ignored the ctx budget (took %v)", elapsed)
	}
	if !c.isSendClosed() {
		t.Fatal("client connection was not closed by GracefulStopContext")
	}
}

// TestGracefulStopContext_StopsLiveKitAfterSocketsClose locks the teardown
// order: a client must hear the notice and lose its socket while LiveKit is
// still up, so it leaves voice on the drop instead of reconnecting to a room
// whose server has already gone.
func TestGracefulStopContext_StopsLiveKitAfterSocketsClose(t *testing.T) {
	send := make(chan []byte, 8)
	h := &Hub{stop: make(chan struct{}), broadcast: make(chan broadcastMsg, 8)}
	c := &Client{hub: h, send: send, sendHigh: send, sendLow: send}
	h.clients = map[int64]*Client{1: c}
	h.pubsub = NewPubSub()
	h.pubsub.Subscribe(c, TopicGlobal)

	var stopped, noticeQueued, socketClosed bool
	h.lkProcess = &LiveKitProcess{cancel: func() {
		stopped = true
		noticeQueued = len(h.broadcast) > 0
		socketClosed = c.isSendClosed()
	}}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	h.GracefulStopContext(ctx, RestartReasonUpdate)

	if !stopped {
		t.Fatal("GracefulStopContext never stopped LiveKit")
	}
	if !noticeQueued {
		t.Fatal("LiveKit stopped before the restart notice was sent")
	}
	if !socketClosed {
		t.Fatal("LiveKit stopped while the client socket was still open")
	}
}

// A client whose readPump teardown has already unregistered it, but not yet
// queued its own disconnect stamp, is still stamped by the conn-writes close
// step: the stop's user set is taken when the stop begins, so the user ends
// offline with last_seen at stop time (P5-S07).
func TestGracefulStopContext_StoppedUsersSurviveTeardownUnregister(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "voice", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET status = 'online', last_seen = datetime('now', '-2 days') WHERE id = ?`, uid); err != nil {
		t.Fatalf("seed: %v", err)
	}

	send := make(chan []byte, 8)
	h := &Hub{stop: make(chan struct{}), broadcast: make(chan broadcastMsg, 8)}
	c := &Client{hub: h, userID: uid, send: send, sendHigh: send, sendLow: send}
	h.clients = map[int64]*Client{uid: c}
	h.pubsub = NewPubSub()
	h.pubsub.Subscribe(c, TopicGlobal)

	stopCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	h.GracefulStopContext(stopCtx, RestartReasonShutdown)
	// readPump's teardown: unregistered, then blocked before its own stamp.
	h.unregisterNow(c)

	w := service.NewConnWrites(database)
	users := service.NewUserService(database)
	users.SetConnWrites(w)
	for _, id := range h.StoppedUserIDs() {
		_ = users.StampDisconnect(ctx, id)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	var status string
	var fresh bool
	if err := database.QueryRowContext(ctx,
		`SELECT status, last_seen > datetime('now', '-1 minute') FROM users WHERE id = ?`, uid).Scan(&status, &fresh); err != nil {
		t.Fatalf("read user: %v", err)
	}
	if status != "offline" || !fresh {
		t.Fatalf("after stop: status %q fresh last_seen %v, want offline and true", status, fresh)
	}
}

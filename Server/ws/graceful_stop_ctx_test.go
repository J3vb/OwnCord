package ws

import (
	"context"
	"testing"
	"time"
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

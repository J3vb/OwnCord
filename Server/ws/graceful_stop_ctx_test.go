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
	h.GracefulStopContext(context.Background())
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
	h.GracefulStopContext(ctx)
	elapsed := time.Since(start)
	if elapsed >= 5*time.Second {
		t.Fatalf("GracefulStopContext ignored the ctx budget (took %v)", elapsed)
	}
	if !c.isSendClosed() {
		t.Fatal("client connection was not closed by GracefulStopContext")
	}
}

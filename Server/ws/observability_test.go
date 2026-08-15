package ws

import (
	"testing"
	"time"
)

// TestBackpressureStats_CountsPerPolicy locks the aggregate counters onto the
// three distinct overflow policies: normal overflow disconnects, high-priority
// overflow falls back then disconnects, low-priority overflow silently drops.
func TestBackpressureStats_CountsPerPolicy(t *testing.T) {
	h := &Hub{}
	c := &Client{
		hub:      h,
		send:     make(chan []byte, 1),
		sendHigh: make(chan []byte, 1),
		sendLow:  make(chan []byte, 1),
	}

	// Low priority: first fills the buffer, second silently drops.
	c.sendLowMsg([]byte("a"))
	c.sendLowMsg([]byte("b"))

	// High priority: first fills sendHigh; second falls back into send (room);
	// third finds both full → fallback counted, then disconnect counted.
	c.sendHighMsg([]byte("c"))
	c.sendHighMsg([]byte("d"))
	c.sendHighMsg([]byte("e"))

	qd, hf, ld := h.BackpressureStats()
	if ld != 1 {
		t.Errorf("lowDrops = %d, want 1", ld)
	}
	if hf != 2 {
		t.Errorf("highFallbacks = %d, want 2", hf)
	}
	if qd != 1 {
		t.Errorf("queueDisconnects = %d, want 1", qd)
	}
	if !c.isSendClosed() {
		t.Error("client should be disconnected after high+normal overflow")
	}

	// A hub-less client must not panic on any overflow path.
	loner := &Client{send: make(chan []byte), sendHigh: make(chan []byte), sendLow: make(chan []byte)}
	loner.sendLowMsg([]byte("x"))
	loner.sendMsg([]byte("y"))
}

// TestDispatchAlive_FlipsOnStop locks the /health liveness contract: alive
// before Run, alive while running, dead once Run has returned.
func TestDispatchAlive_FlipsOnStop(t *testing.T) {
	h := &Hub{
		stop:         make(chan struct{}),
		clientEvents: make(chan clientEvent, 1),
		broadcast:    make(chan broadcastMsg, 1),
	}
	if !h.DispatchAlive() {
		t.Fatal("hub must report alive before Run starts")
	}
	done := make(chan struct{})
	go func() { h.Run(); close(done) }()
	h.Stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after Stop")
	}
	if h.DispatchAlive() {
		t.Fatal("hub must report dead after Run returns")
	}
}

// TestPanicBreaker_CallsFatalFn locks the supervisor-restart contract: three
// dispatch-loop panics inside the 60s window stop the hub AND invoke fatalFn
// (os.Exit(1) in production), so a supervisor can restart the process instead
// of the outage staying invisible.
func TestPanicBreaker_CallsFatalFn(t *testing.T) {
	h := &Hub{
		stop:         make(chan struct{}),
		clientEvents: make(chan clientEvent, 1),
		broadcast:    make(chan broadcastMsg, 3),
	}
	fatal := make(chan struct{})
	h.fatalFn = func() { close(fatal) }

	// replayBuf is nil, so deliverBroadcast panics on Push — inside the
	// closure whose deferred seqMu unlock keeps the lock state clean across
	// the recover, unlike a hand-rolled unlock would.
	bad := broadcastMsg{channelID: 0, msg: []byte(`{"type":"x"}`)}
	h.broadcast <- bad
	h.broadcast <- bad
	h.broadcast <- bad

	done := make(chan struct{})
	go func() { h.Run(); close(done) }()

	select {
	case <-fatal:
	case <-time.After(5 * time.Second):
		t.Fatal("fatalFn was not called after 3 panics")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after the breaker tripped")
	}
	if h.DispatchAlive() {
		t.Fatal("hub must report dead after the breaker tripped")
	}
}

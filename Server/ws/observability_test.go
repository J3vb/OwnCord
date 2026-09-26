package ws

import (
	"context"
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
	h.broadcastDrops.Add(1)
	if got := h.DeliveryDropCount(); got != 2 {
		t.Errorf("DeliveryDropCount = %d, want 2 (one broadcast drop plus one queue disconnect, no low-priority drop)", got)
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

// TestDone_ClosesOnlyOnceDispatchHasExited locks the join the app's hub close
// step relies on. GracefulStopContext only signals the loop: called before the
// Run goroutine has been scheduled (an early start failure right after the hub
// stage), it returns with the loop still to come, so DispatchAlive is still
// true. Done is what closes only after Run has returned.
func TestDone_ClosesOnlyOnceDispatchHasExited(t *testing.T) {
	h := &Hub{
		stop:         make(chan struct{}),
		runDone:      make(chan struct{}),
		clientEvents: make(chan clientEvent, 1),
		broadcast:    make(chan broadcastMsg, 1),
	}
	h.GracefulStopContext(context.Background())
	select {
	case <-h.Done():
		t.Fatal("Done closed before Run ever ran")
	default:
	}
	if !h.DispatchAlive() {
		t.Fatal("DispatchAlive is false before Run ran — GracefulStopContext is not what ends the loop")
	}

	go h.Run()
	select {
	case <-h.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done did not close after a stopped hub's Run")
	}
	if h.DispatchAlive() {
		t.Fatal("Done closed while DispatchAlive was still true")
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

	// Each frame makes deliverBroadcast panic through the dispatch-side NSFW
	// hook. It must be an explicit panic, not a nil dereference: on Windows a
	// recovered nil dereference is a hardware exception whose frame can land
	// below a small goroutine stack and corrupt the heap (golang/go#81238).
	// The hook is package-global, so it fires only for this test's channel.
	const panicChannelID = int64(81238)
	nsfwDispatchResolveRaceHook = func(channelID int64) {
		if channelID == panicChannelID {
			panic("injected dispatch panic")
		}
	}
	t.Cleanup(func() { nsfwDispatchResolveRaceHook = nil })
	bad := broadcastMsg{nsfwChannelID: panicChannelID, msg: []byte(`{"type":"x"}`)}
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

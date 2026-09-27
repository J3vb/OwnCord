//go:build windows

package ws

import (
	"testing"
	"time"
)

// syntheticMemoryFault is the runtime.Error a nil dereference panics with.
// The test panics with it rather than dereferencing nil: recovering a real
// fault on Windows can corrupt the test binary's heap (golang/go#81238).
type syntheticMemoryFault struct{}

func (syntheticMemoryFault) RuntimeError() {}
func (syntheticMemoryFault) Error() string {
	return "runtime error: invalid memory address or nil pointer dereference"
}

// TestPanicBreaker_HardwareFaultExitsOnFirstPanic pins SRE-08's Windows rule:
// a nil-dereference runtime.Error inside the dispatch loop is a hardware fault
// (golang/go#81238) and must exit for a supervisor restart on the FIRST
// occurrence, not wait for the three-panic breaker — the heap may already be
// corrupt. The classifier (stackutil.Recovered) is what makes this Windows
// only; the matching test on Linux lives in stackutil and asserts the panic
// stays recoverable there.
func TestPanicBreaker_HardwareFaultExitsOnFirstPanic(t *testing.T) {
	const panicChannelID = int64(81239)
	h := &Hub{
		stop:         make(chan struct{}),
		clientEvents: make(chan clientEvent, 1),
		broadcast:    make(chan broadcastMsg, 1),
	}
	fatal := make(chan struct{})
	h.fatalFn = func() { close(fatal) }

	nsfwDispatchResolveRaceHook = func(channelID int64) {
		if channelID == panicChannelID {
			panic(syntheticMemoryFault{})
		}
	}
	t.Cleanup(func() { nsfwDispatchResolveRaceHook = nil })

	h.broadcast <- broadcastMsg{nsfwChannelID: panicChannelID, msg: []byte(`{"type":"x"}`)}

	done := make(chan struct{})
	go func() { h.Run(); close(done) }()

	select {
	case <-fatal:
	case <-time.After(5 * time.Second):
		t.Fatal("fatalFn was not called after a single hardware fault")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after the hardware fault")
	}
}

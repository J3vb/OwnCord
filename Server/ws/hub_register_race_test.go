package ws

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestRegisterNow_ReplacementNeverLosesAConcurrentGlobalBroadcast locks the
// invariant serve.go's handleReconnect actually depends on: registerNow
// stripping the replaced connection's pub/sub subscriptions and re-subscribing
// the new one is itself two separate PubSub-lock acquisitions (UnsubscribeAll,
// then Subscribe), so calling it bare gives no atomicity guarantee against a
// concurrent deliverBroadcast — a global broadcast landing between those two
// acquisitions finds no subscriber for the user, and since deliverBroadcast
// already stamped it with a seq and pushed it to the replay buffer, it is
// unrecoverable: the resuming client's replay snapshot was taken even earlier,
// and the client only tracks max(seq), so the hole is silent and permanent.
//
// handleReconnect closes this by re-reading the replay tail and calling
// registerNow inside the SAME h.seqMu critical section deliverBroadcast uses
// for its entire body (seq allocation, replay push, and publish) — mutual
// exclusion on seqMu, not a narrowed timing window, is what actually
// eliminates the race. This test reproduces that exact pattern directly on
// Hub (without importing serve.go) and asserts it holds under real
// concurrency; a bare, unsynchronized registerNow call is deliberately NOT
// what is asserted here, since hub.go alone cannot provide that guarantee —
// only the seqMu-holding caller can.
func TestRegisterNow_ReplacementNeverLosesAConcurrentGlobalBroadcast(t *testing.T) {
	h := newEmitTestHub()
	go h.Run()
	defer h.Stop()

	const userID = int64(1)
	const iterations = 300

	old := NewTestClient(h, userID, make(chan []byte, 8))
	h.mu.Lock()
	h.clients[userID] = old
	h.mu.Unlock()
	h.pubsub.Subscribe(old, TopicGlobal)

	for i := 0; i < iterations; i++ {
		replacement := NewTestClient(h, userID, make(chan []byte, 8))
		replacement.lastSeq = 1 // network reconnect path

		payload := fmt.Sprintf(`{"type":"server_restart","marker":%d}`, i)
		// deliverBroadcast wraps every payload with an injected leading
		// "seq" field (wrapWithSeq splices `{"seq":N,` in after the opening
		// brace), so the frame that actually reaches a subscriber is never
		// byte-equal to payload. Match on a brace-free fragment that survives
		// the splice instead.
		marker := fmt.Sprintf(`"marker":%d}`, i)

		done := make(chan struct{})
		go func() {
			// Mirrors serve.go's handleReconnect: registerNow runs inside
			// h.seqMu, the same lock deliverBroadcast holds for its whole
			// critical section, so the two can never interleave.
			h.seqMu.Lock()
			h.registerNow(replacement, nil)
			h.seqMu.Unlock()
			close(done)
		}()
		h.BroadcastToAll([]byte(payload))
		<-done

		if !received(old.send, marker, 200*time.Millisecond) &&
			!received(replacement.send, marker, 200*time.Millisecond) {
			t.Fatalf("iteration %d: broadcast %q reached neither the replaced nor the replacement connection", i, payload)
		}

		old = replacement
	}
}

// received drains ch for up to timeout looking for a message containing want,
// returning true the moment it's found. Any other messages seen (e.g. from a
// previous iteration still in flight) are discarded. registerNow closes the
// replaced connection's send channel before this runs, and a closed buffered
// channel keeps yielding any messages queued before the close — but once
// drained, further receives return the zero value immediately without
// blocking, so a plain single-value receive would spin here for the whole
// timeout instead of reporting "channel closed and drained" right away.
func received(ch chan []byte, want string, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return false
			}
			if strings.Contains(string(msg), want) {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

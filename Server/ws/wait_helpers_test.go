package ws_test

// wait_helpers_test.go holds condition-based waiting helpers shared by the
// ws_test files. They replace fixed time.Sleep pacing with polling (for state)
// or blocking receives (for channels), making the suite faster and less flaky.
//
// Semantics guide:
//   - waitFor / waitRegistered / waitClientCount: wait-for-effect — return as
//     soon as the condition holds, fail the test after the timeout.
//   - waitMsgOfType: blocking scan of a channel for a message of a given
//     envelope type (wait-for-effect); returns nil on timeout.
//
// For bounded-window collection ("all messages that arrive within d",
// including absence-over-a-set assertions) use drainChanTimeout from
// coverage_helpers_test.go — it always waits the full window, matching the
// old sleep+drain behavior.

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

const (
	// waitTimeout bounds all wait-for-effect helpers. Generous on purpose:
	// it is only ever paid in full when a test is about to fail.
	waitTimeout = 2 * time.Second
	// waitPoll is the polling interval for state-based waits.
	waitPoll = time.Millisecond
)

// waitFor polls cond every waitPoll until it returns true or timeout elapses,
// failing the test with msg on timeout.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", timeout, msg)
		}
		time.Sleep(waitPoll)
	}
}

// waitRegistered blocks until c is the hub's registered client for its user,
// i.e. the async Register round-trip through the hub loop has completed.
// Because client events are processed in order, waiting on the most recently
// registered client also guarantees all earlier Register calls completed.
func waitRegistered(t *testing.T, hub *ws.Hub, c *ws.Client) {
	t.Helper()
	waitFor(t, waitTimeout, func() bool {
		return hub.GetClient(ws.ClientUserIDForTest(c)) == c
	}, "client to be registered with the hub")
}

// waitClientCount blocks until the hub's client count equals n.
func waitClientCount(t *testing.T, hub *ws.Hub, n int) {
	t.Helper()
	waitFor(t, waitTimeout, func() bool {
		return hub.ClientCount() == n
	}, "hub client count to settle")
}

// waitMsgOfType reads ch until a message whose envelope "type" equals msgType
// arrives, returning the raw message, or nil once timeout expires.
func waitMsgOfType(ch <-chan []byte, msgType string, timeout time.Duration) []byte {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case m := <-ch:
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(m, &env) == nil && env.Type == msgType {
				return m
			}
		case <-timer.C:
			return nil
		}
	}
}

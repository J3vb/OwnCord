package ws

import (
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

const budgetReplyText = "too many messages, slow down"

func newBudgetHub(t *testing.T) *Hub {
	t.Helper()
	return newTestHub(t, newTeardownTestDB(t), auth.NewRateLimiter(), nil)
}

// countBudgetReplies drains send and counts the inbound-budget refusals.
func countBudgetReplies(send chan []byte) int {
	n := 0
	for {
		select {
		case frame := <-send:
			if strings.Contains(string(frame), budgetReplyText) {
				n++
			}
		default:
			return n
		}
	}
}

func strikesOf(c *Client) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.invalidCount
}

// A burst well above anything a real client sends, spread over two sockets of
// one account, passes the budget untouched.
func TestInboundBudget_NormalBurstPasses(t *testing.T) {
	h := newBudgetHub(t)
	sendA, sendB := make(chan []byte, 512), make(chan []byte, 512)
	a, b := NewTestClient(h, 7, sendA), NewTestClient(h, 7, sendB)

	for i := range 200 {
		c := a
		if i%2 == 1 {
			c = b
		}
		h.handleMessage(c, []byte(`{"type":"ping"}`))
	}

	if n := countBudgetReplies(sendA) + countBudgetReplies(sendB); n != 0 {
		t.Fatalf("normal burst met the inbound budget %d times", n)
	}
	if a.isSendClosed() || b.isSendClosed() {
		t.Fatal("a normal burst closed a socket")
	}
}

// Past the budget a frame is answered RATE_LIMITED without being decoded, the
// budget is shared by the account's sockets, and repeated overruns close the
// socket through the strike limit.
func TestInboundBudget_OverrunRepliesRateLimitedThenCloses(t *testing.T) {
	h := newBudgetHub(t)
	sendA, sendB := make(chan []byte, 1024), make(chan []byte, 64)
	a, b := NewTestClient(h, 9, sendA), NewTestClient(h, 9, sendB)

	for range inboundFrameLimit {
		h.handleMessage(a, []byte(`{"type":"ping"}`))
	}
	if n := countBudgetReplies(sendA); n != 0 {
		t.Fatalf("frames inside the budget were refused %d times", n)
	}

	// The second socket shares the spent budget.
	h.handleMessage(b, []byte(`{"type":"ping"}`))
	if n := countBudgetReplies(sendB); n != 1 {
		t.Fatalf("second socket of the account: budget replies = %d, want 1", n)
	}
	if !strings.Contains(string(buildErrorMsg(ErrCodeRateLimited, budgetReplyText)), ErrCodeRateLimited) {
		t.Fatal("budget reply does not carry RATE_LIMITED")
	}

	for i := 1; i < frameStrikeLimit; i++ {
		if a.isSendClosed() {
			t.Fatalf("socket closed after %d overruns, want %d", i-1, frameStrikeLimit)
		}
		h.handleMessage(a, []byte(`{"type":"ping"}`))
	}
	if a.isSendClosed() {
		t.Fatal("socket closed before the strike limit")
	}
	h.handleMessage(a, []byte(`{"type":"ping"}`))
	if !a.isSendClosed() {
		t.Fatalf("socket still open after %d consecutive overruns", frameStrikeLimit)
	}
}

// An unknown type or an unparseable payload is refused but is no strike, so a
// newer app's unknown frames never close the socket; invalid JSON counts, and a
// frame that parses into a known command clears the count.
func TestFrameStrikes_OnlyInvalidJSONAndOverrunsCount(t *testing.T) {
	h := newBudgetHub(t)
	send := make(chan []byte, 256)
	c := NewTestClient(h, 11, send)

	for range 3 * frameStrikeLimit {
		h.handleMessage(c, []byte(`{"type":"no_such_type"}`))
	}
	h.handleMessage(c, []byte(`{"type":"channel_focus","payload":{"channel_id":"x"}}`))
	if got := strikesOf(c); got != 0 {
		t.Fatalf("unknown types and a bad payload left strikes = %d, want 0", got)
	}
	if c.isSendClosed() {
		t.Fatal("unknown-type frames closed the socket")
	}

	for range frameStrikeLimit - 1 {
		h.handleMessage(c, []byte(`not json`))
	}
	if got := strikesOf(c); got != frameStrikeLimit-1 {
		t.Fatalf("strikes = %d, want %d", got, frameStrikeLimit-1)
	}
	h.handleMessage(c, []byte(`{"type":"ping"}`))
	if got := strikesOf(c); got != 0 {
		t.Fatalf("a parsed command left strikes = %d, want 0", got)
	}

	for range frameStrikeLimit {
		h.handleMessage(c, []byte(`not json`))
	}
	if !c.isSendClosed() {
		t.Fatalf("socket still open after %d invalid JSON frames", frameStrikeLimit)
	}
}

// The refused-frame warning is logged once per interval per connection; the
// rest are only counted.
func TestFrameStrikes_WarningThrottledPerConnection(t *testing.T) {
	h := newBudgetHub(t)
	c := NewTestClient(h, 13, make(chan []byte, 64))
	other := NewTestClient(h, 13, make(chan []byte, 64))

	for range 5 {
		h.handleMessage(c, []byte(`{"type":"no_such_type"}`))
	}
	h.handleMessage(other, []byte(`not json`))

	c.mu.Lock()
	skipped, logged := c.skippedStrikeLogs, !c.lastStrikeLog.IsZero()
	c.mu.Unlock()
	if !logged || skipped != 4 {
		t.Fatalf("first connection: logged=%v skipped=%d, want logged and 4 skipped", logged, skipped)
	}
	other.mu.Lock()
	otherSkipped, otherLogged := other.skippedStrikeLogs, !other.lastStrikeLog.IsZero()
	other.mu.Unlock()
	if !otherLogged || otherSkipped != 0 {
		t.Fatalf("second connection: logged=%v skipped=%d, want its own first line logged", otherLogged, otherSkipped)
	}
}

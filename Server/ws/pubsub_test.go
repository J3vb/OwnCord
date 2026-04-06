package ws

import (
	"sort"
	"sync"
	"testing"
	"time"
)

func newTestPubSub() *PubSub {
	return NewPubSub()
}

func makeTestClient(userID int64) *Client {
	return &Client{
		userID:   userID,
		send:     make(chan []byte, 16),
		sendHigh: make(chan []byte, 16),
		sendLow:  make(chan []byte, 16),
	}
}

// ─── Subscribe / Unsubscribe ─────────────────────────────────────────────────

func TestPubSub_Subscribe(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(1)

	ps.Subscribe(c, "channel:42")

	if n := ps.SubscriberCount("channel:42"); n != 1 {
		t.Fatalf("SubscriberCount = %d, want 1", n)
	}
}

func TestPubSub_SubscribeIdempotent(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(1)

	ps.Subscribe(c, "channel:42")
	ps.Subscribe(c, "channel:42") // duplicate

	if n := ps.SubscriberCount("channel:42"); n != 1 {
		t.Fatalf("SubscriberCount = %d after double subscribe, want 1", n)
	}
}

func TestPubSub_Unsubscribe(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(1)

	ps.Subscribe(c, "channel:42")
	ps.Unsubscribe(c, "channel:42")

	if n := ps.SubscriberCount("channel:42"); n != 0 {
		t.Fatalf("SubscriberCount = %d after unsubscribe, want 0", n)
	}
}

func TestPubSub_UnsubscribeNonExistent(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(1)

	// Should not panic.
	ps.Unsubscribe(c, "channel:99")
}

func TestPubSub_UnsubscribeAll(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(1)

	ps.Subscribe(c, "channel:1")
	ps.Subscribe(c, "channel:2")
	ps.Subscribe(c, TopicGlobal)

	ps.UnsubscribeAll(c)

	if n := ps.SubscriberCount("channel:1"); n != 0 {
		t.Fatalf("channel:1 still has %d subscribers", n)
	}
	if n := ps.SubscriberCount("channel:2"); n != 0 {
		t.Fatalf("channel:2 still has %d subscribers", n)
	}
	if n := ps.SubscriberCount(TopicGlobal); n != 0 {
		t.Fatalf("global still has %d subscribers", n)
	}
	if topics := ps.TopicsForClient(1); len(topics) != 0 {
		t.Fatalf("client still has topics: %v", topics)
	}
}

func TestPubSub_UnsubscribeAllEmpty(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(99)

	// Should not panic on client with no subscriptions.
	ps.UnsubscribeAll(c)
}

// ─── Publish ─────────────────────────────────────────────────────────────────

func TestPubSub_Publish(t *testing.T) {
	ps := newTestPubSub()
	c1 := makeTestClient(1)
	c2 := makeTestClient(2)
	c3 := makeTestClient(3) // not subscribed

	ps.Subscribe(c1, "channel:42")
	ps.Subscribe(c2, "channel:42")

	msg := []byte(`{"type":"chat"}`)
	delivered := ps.Publish("channel:42", msg, 0)

	if delivered != 2 {
		t.Fatalf("delivered = %d, want 2", delivered)
	}

	assertChanMsg(t, c1.send, msg)
	assertChanMsg(t, c2.send, msg)
	assertChanEmpty(t, c3.send)
}

func TestPubSub_PublishExclude(t *testing.T) {
	ps := newTestPubSub()
	c1 := makeTestClient(1)
	c2 := makeTestClient(2)

	ps.Subscribe(c1, "channel:42")
	ps.Subscribe(c2, "channel:42")

	msg := []byte(`{"type":"typing"}`)
	delivered := ps.Publish("channel:42", msg, 1) // exclude user 1

	if delivered != 1 {
		t.Fatalf("delivered = %d, want 1", delivered)
	}

	assertChanEmpty(t, c1.send)
	assertChanMsg(t, c2.send, msg)
}

func TestPubSub_PublishEmptyTopic(t *testing.T) {
	ps := newTestPubSub()

	delivered := ps.Publish("channel:999", []byte(`{}`), 0)
	if delivered != 0 {
		t.Fatalf("delivered = %d for empty topic, want 0", delivered)
	}
}

func TestPubSub_PublishGlobal(t *testing.T) {
	ps := newTestPubSub()
	c1 := makeTestClient(1)
	c2 := makeTestClient(2)

	ps.Subscribe(c1, TopicGlobal)
	ps.Subscribe(c2, TopicGlobal)

	msg := []byte(`{"type":"presence"}`)
	delivered := ps.PublishGlobal(msg)

	if delivered != 2 {
		t.Fatalf("delivered = %d, want 2", delivered)
	}

	assertChanMsg(t, c1.send, msg)
	assertChanMsg(t, c2.send, msg)
}

func TestPubSub_PublishLow(t *testing.T) {
	ps := newTestPubSub()
	c1 := makeTestClient(1)
	// c2 has a tiny low-priority buffer that we pre-fill.
	c2 := &Client{userID: 2, send: make(chan []byte, 16), sendHigh: make(chan []byte, 4), sendLow: make(chan []byte, 1)}

	ps.Subscribe(c1, "channel:1")
	ps.Subscribe(c2, "channel:1")

	// Fill c2's low-priority buffer so it drops.
	c2.sendLow <- []byte(`filler`)

	msg := []byte(`{"type":"typing"}`)
	delivered := ps.PublishLow("channel:1", msg, 0)

	// Both get counted (sendLowMsg counts the attempt), but c2's message was dropped.
	if delivered != 2 {
		t.Fatalf("delivered = %d, want 2", delivered)
	}
	assertChanMsg(t, c1.sendLow, msg)
	// c2's sendLow only has the filler, not the typing msg.
	assertChanMsg(t, c2.sendLow, []byte(`filler`))
	assertChanEmpty(t, c2.sendLow)
}

func TestPubSub_PublishHigh(t *testing.T) {
	ps := newTestPubSub()
	c1 := makeTestClient(1)
	c2 := makeTestClient(2)

	ps.Subscribe(c1, UserTopic(1))
	ps.Subscribe(c2, UserTopic(1))

	msg := []byte(`{"type":"dm"}`)
	delivered := ps.PublishHigh(UserTopic(1), msg, 0)

	if delivered != 2 {
		t.Fatalf("delivered = %d, want 2", delivered)
	}
	assertChanMsg(t, c1.sendHigh, msg)
	assertChanMsg(t, c2.sendHigh, msg)
}

// ─── TopicsForClient ─────────────────────────────────────────────────────────

func TestPubSub_TopicsForClient(t *testing.T) {
	ps := newTestPubSub()
	c := makeTestClient(1)

	ps.Subscribe(c, TopicGlobal)
	ps.Subscribe(c, "channel:10")
	ps.Subscribe(c, UserTopic(1))

	topics := ps.TopicsForClient(1)
	sort.Slice(topics, func(i, j int) bool { return topics[i] < topics[j] })

	expected := []Topic{"channel:10", TopicGlobal, UserTopic(1)}
	if len(topics) != len(expected) {
		t.Fatalf("topics = %v, want %v", topics, expected)
	}
	for i := range expected {
		if topics[i] != expected[i] {
			t.Fatalf("topics[%d] = %q, want %q", i, topics[i], expected[i])
		}
	}
}

// ─── Topic helpers ───────────────────────────────────────────────────────────

func TestChannelTopic(t *testing.T) {
	if got := ChannelTopic(42); got != "channel:42" {
		t.Fatalf("ChannelTopic(42) = %q", got)
	}
}

func TestVoiceTopic(t *testing.T) {
	if got := VoiceTopic(7); got != "voice:7" {
		t.Fatalf("VoiceTopic(7) = %q", got)
	}
}

func TestUserTopic(t *testing.T) {
	if got := UserTopic(123); got != "user:123" {
		t.Fatalf("UserTopic(123) = %q", got)
	}
}

// ─── Concurrency safety ─────────────────────────────────────────────────────

func TestPubSub_ConcurrentAccess(t *testing.T) {
	ps := newTestPubSub()
	const N = 50

	var wg sync.WaitGroup
	wg.Add(N * 3) // subscribe + publish + unsubscribe

	for i := 0; i < N; i++ {
		c := makeTestClient(int64(i))
		go func() {
			defer wg.Done()
			ps.Subscribe(c, "channel:1")
		}()
		go func() {
			defer wg.Done()
			ps.Publish("channel:1", []byte(`{"x":1}`), 0)
		}()
		go func(c *Client) {
			defer wg.Done()
			ps.UnsubscribeAll(c)
		}(c)
	}

	wg.Wait()
	// No panics or data races = pass. (Run with -race.)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func assertChanMsg(t *testing.T, ch <-chan []byte, want []byte) {
	t.Helper()
	select {
	case got := <-ch:
		if string(got) != string(want) {
			t.Errorf("got %q, want %q", got, want)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("expected message but channel was empty")
	}
}

func assertChanEmpty(t *testing.T, ch <-chan []byte) {
	t.Helper()
	select {
	case msg := <-ch:
		t.Errorf("expected empty channel but got %q", msg)
	default:
		// ok
	}
}

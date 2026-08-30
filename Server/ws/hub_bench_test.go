package ws_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// quietLogs points the default logger at io.Discard for the duration of b, and
// restores it afterwards so no other test in this package sees a different one.
//
// Not cosmetic: `go test` prints a benchmark's name and padding BEFORE it runs
// the function, so every line the hub logs (registerNow emits one INFO per
// registration) lands between the name and the result figures. benchstat then
// reads the log text where the iteration count should be and drops the whole
// benchmark from the baseline — silently, since the numbers still appear on a
// line of their own.
//
// The handler is left at its default level rather than raised above Info, so
// the record is still formatted and only the write is discarded — closer to a
// production sink than switching the log off would be.
func quietLogs(b *testing.B) {
	b.Helper()
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Cleanup(func() { slog.SetDefault(prev) })
}

// BenchmarkReconnectStorm is hub_sim_test.go's reconnect-transfer step over 50
// live clients: one op resumes every client once, each resume preceded by a
// global broadcast so its 8-frame replay is real and the registration races
// nothing but the seqMu it takes. Item 6 collects the baseline; run with
//
//	go test -run '^$' -bench ReconnectStorm -benchmem ./ws/
func BenchmarkReconnectStorm(b *testing.B) {
	quietLogs(b)
	hub, database := newTestHub(b)
	const n = 50
	payload := []byte(`{"type":"sim","bench":true}`)
	newConn := func(u *db.User, lastSeq uint64) *ws.Client {
		return ws.NewSimClientForTest(hub, u, 0, lastSeq, make(chan []byte, 256), make(chan []byte, 64), make(chan []byte, 64))
	}
	users := make([]*db.User, n)
	conns := make([]*ws.Client, n)
	for i := range n {
		users[i] = seedOwnerUser(b, database, fmt.Sprintf("storm-%d", i))
		conns[i] = newConn(users[i], 0)
		hub.RegisterNowForTest(conns[i])
	}
	for range 16 { // so every watermark below sits inside the ring
		hub.DeliverBroadcastForTest(0, nil, payload)
	}
	allowed := map[int64]bool{}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		for i := range n {
			seq := hub.DeliverBroadcastForTest(0, nil, payload)
			nc := newConn(users[i], seq-8)
			if _, ok := hub.ReconnectRegisterForTest(nc, seq-8, allowed); !ok {
				b.Fatalf("resume from %d refused a replay", seq-8)
			}
			hub.UnregisterNowForTest(conns[i])
			conns[i] = nc
		}
	}
}

// BenchmarkPermissionInvalidation is the permission/visibility refresh an admin
// role or channel-override edit triggers: RefreshChannelVisibility re-resolves
// CanViewChannel and the per-recipient can_send verdict for every connected
// client from its CURRENT role — on a bare hub (no PermissionService) that is
// two live lookups each — and addresses each client its own channel_create or
// channel_delete. The per-iteration receive is that fan-out's own cost, not
// scaffolding: the call is level-triggered, so every client is sent exactly one
// frame every time, and an undrained queue would overflow into the disconnect
// path instead of the path being measured.
func BenchmarkPermissionInvalidation(b *testing.B) {
	quietLogs(b)
	hub, database := newTestHub(b)
	const n = 50
	chID := seedTestChannel(b, database, "invalidation")
	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		b.Fatalf("GetChannel: %v", err)
	}
	sends := make([]chan []byte, n)
	for i := range n {
		user := seedOwnerUser(b, database, fmt.Sprintf("invalidate-%d", i))
		sends[i] = make(chan []byte, 4)
		hub.RegisterNowForTest(ws.NewTestClientWithUser(hub, user, 0, sends[i]))
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		hub.RefreshChannelVisibility(ch)
		for _, s := range sends {
			if msg := <-s; len(msg) == 0 {
				b.Fatal("a client's send queue was closed: the refresh overflowed it")
			}
		}
	}
}

// BenchmarkBroadcastFanout is one sequenced global broadcast to 100 registered
// headless clients through deliverBroadcast — seq allocation under seqMu, the
// replay-ring push and the pub/sub publish that copies the frame into every
// subscriber's queue. Each iteration drains all 100 queues so the fan-out never
// degrades into sendMsg's buffer-full disconnect path.
func BenchmarkBroadcastFanout(b *testing.B) {
	quietLogs(b)
	hub, database := newTestHub(b)
	const n = 100
	payload := []byte(`{"type":"chat_message","payload":{"channel_id":1,"content":"bench"}}`)
	sends := make([]chan []byte, n)
	for i := range n {
		user := seedOwnerUser(b, database, fmt.Sprintf("fanout-%d", i))
		sends[i] = make(chan []byte, 4)
		hub.RegisterNowForTest(ws.NewTestClientWithUser(hub, user, 0, sends[i]))
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if hub.DeliverBroadcastForTest(0, nil, payload) == 0 {
			b.Fatal("broadcast allocated no seq")
		}
		for _, s := range sends {
			if msg := <-s; len(msg) == 0 {
				b.Fatal("a client's send queue was closed: the fan-out overflowed it")
			}
		}
	}
}

// BenchmarkReplaySelection is the buffer-tier resume scan: EventsSince over a
// ring buffer filled to the hub's own capacity (NewEventRingBuffer(1000) in
// NewHub), from a watermark halfway back — the selection walks all 1000 entries
// whatever the watermark is, and copies out the 500 above it.
func BenchmarkReplaySelection(b *testing.B) {
	const size = 1000
	rb := ws.NewEventRingBuffer(size)
	payload := []byte(`{"seq":0,"type":"chat_message","payload":{"channel_id":1,"content":"bench"}}`)
	for i := range size {
		rb.Push(uint64(i+1), 0, payload) //nolint:gosec // loop index, never negative
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if got := rb.EventsSince(size / 2); len(got) != size/2 {
			b.Fatalf("EventsSince returned %d frames, want %d", len(got), size/2)
		}
	}
}

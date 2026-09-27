package ws

// serve_pumps_ping_test.go — CLI-01: the server's protocol Ping keeps a peer
// that answers Pings alive without any app-level traffic, and closes a peer
// that stops answering. Both run through ServeWS with a real auth handshake.
// The intervals are scaled down; the ratios are what production gives
// (12 intervals ≈ 5 minutes, stale timeout 3 intervals, close ≤ 2 intervals).

import (
	"context"
	"testing"
	"time"
)

const testPingInterval = 300 * time.Millisecond

func scalePingTimings(t *testing.T) {
	t.Helper()
	prevPing, prevStale := pingInterval, staleClientTimeout
	pingInterval, staleClientTimeout = testPingInterval, 3*testPingInterval
	t.Cleanup(func() { pingInterval, staleClientTimeout = prevPing, prevStale })
}

func registeredClient(hub *Hub, uid int64) *Client {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	return hub.clients[uid]
}

func TestServeWS_PongOnlyPeerOutlivesStaleSweep(t *testing.T) {
	scalePingTimings(t)
	hub, uid, token, srvURL := sessionReplacedFixture(t)
	conn := connectDevice(t, context.Background(), hub, uid, srvURL, token)
	c := registeredClient(hub, uid)

	// The peer sends nothing; its Read loop only answers the server's Pings.
	peerCtx, peerCancel := context.WithCancel(context.Background())
	peerDone := make(chan struct{})
	go func() {
		defer close(peerDone)
		for {
			if _, _, err := conn.Read(peerCtx); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		peerCancel()
		<-peerDone
	})

	for range 12 {
		time.Sleep(testPingInterval)
		hub.sweepStaleClients()
		if registeredClient(hub, uid) != c {
			t.Fatal("stale sweep dropped a peer that answers every Ping")
		}
	}
	c.mu.Lock()
	received := c.msgsReceived
	c.mu.Unlock()
	if received != 0 {
		t.Fatalf("a Pong counted as a received message: msgsReceived=%d", received)
	}
}

func TestServeWS_SilentPeerClosed(t *testing.T) {
	scalePingTimings(t)
	hub, uid, token, srvURL := sessionReplacedFixture(t)
	// After the handshake the peer never reads, so it never answers a Ping —
	// a half-open socket. No stale sweep runs here: only the Ping can close it.
	connectDevice(t, context.Background(), hub, uid, srvURL, token)

	start := time.Now()
	for registeredClient(hub, uid) != nil {
		if time.Since(start) > 20*testPingInterval {
			t.Fatal("server kept a peer that never answers a Ping")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Due at 2 intervals; the slack absorbs -race scheduling.
	if took := time.Since(start); took > 6*testPingInterval {
		t.Fatalf("silent peer closed after %v, want about %v", took, 2*testPingInterval)
	}
}

package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
)

// countingLiveKit returns a client whose room service counts each RPC and holds
// it until release is closed (nil release answers at once).
func countingLiveKit(t *testing.T, status int, release <-chan struct{}) (*LiveKitClient, *atomic.Int64) {
	t.Helper()
	body, err := proto.Marshal(&livekit.ListRoomsResponse{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		if release != nil {
			<-release
		}
		if status != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"code":"internal","msg":"boom"}`))
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	c, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + srv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	return c, &calls
}

// A burst of callers on a cold cache shares one probe.
func TestCachedHealthCheck_ConcurrentCallersShareOneProbe(t *testing.T) {
	release := make(chan struct{})
	c, calls := countingLiveKit(t, http.StatusOK, release)

	const n = 25
	var wg sync.WaitGroup
	results := make(chan bool, n)
	for range n {
		wg.Go(func() {
			ok, _ := c.CachedHealthCheck(context.Background())
			results <- ok
		})
	}
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	close(results)

	if got := calls.Load(); got != 1 {
		t.Fatalf("ListRooms calls = %d for %d concurrent callers, want 1", got, n)
	}
	for ok := range results {
		if !ok {
			t.Fatal("a caller sharing a healthy probe got false")
		}
	}
}

// The verdict is reused inside the TTL and re-probed after it; a failure is
// cached the same way and keeps its reason.
func TestCachedHealthCheck_ReusesVerdictUntilTTL(t *testing.T) {
	c, calls := countingLiveKit(t, http.StatusInternalServerError, nil)
	now := time.Now()
	c.health.now = func() time.Time { return now }

	ok, err := c.CachedHealthCheck(context.Background())
	if ok || err == nil {
		t.Fatalf("first check = %v, %v; want false with a reason", ok, err)
	}
	now = now.Add(liveKitHealthTTL - time.Millisecond)
	ok, err2 := c.CachedHealthCheck(context.Background())
	if ok || err2 == nil || calls.Load() != 1 {
		t.Fatalf("inside the TTL: ok=%v err=%v calls=%d; want the cached failure and 1 call", ok, err2, calls.Load())
	}
	now = now.Add(time.Millisecond)
	if _, _ = c.CachedHealthCheck(context.Background()); calls.Load() != 2 {
		t.Fatalf("calls after the TTL = %d, want 2", calls.Load())
	}
}

// A caller whose context ends stops waiting; the probe still finishes and fills
// the cache for the next caller.
func TestCachedHealthCheck_CallerCancelDoesNotFailTheProbe(t *testing.T) {
	release := make(chan struct{})
	c, calls := countingLiveKit(t, http.StatusOK, release)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.CachedHealthCheck(ctx)
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller err = %v, want context.Canceled", err)
	}
	close(release)
	deadline = time.Now().Add(2 * time.Second)
	for {
		if _, _, hit := c.health.fresh(); hit {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the detached probe never stored its verdict")
		}
		time.Sleep(time.Millisecond)
	}
	ok, err := c.CachedHealthCheck(context.Background())
	if !ok || err != nil || calls.Load() != 1 {
		t.Fatalf("after the probe: ok=%v err=%v calls=%d; want the cached healthy verdict and 1 call", ok, err, calls.Load())
	}
}

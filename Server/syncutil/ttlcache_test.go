package syncutil

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestTTLCache(t *testing.T) {
	now := time.Unix(1000, 0)
	c := &TTLCache[int]{Now: func() time.Time { return now }}
	calls := 0
	load := func() (int, error) { calls++; return calls * 10, nil }

	if v, _ := c.Get(time.Minute, load); v != 10 {
		t.Fatalf("first = %d", v)
	}
	now = now.Add(59 * time.Second)
	if v, _ := c.Get(time.Minute, load); v != 10 || calls != 1 {
		t.Fatalf("hit within TTL: v=%d calls=%d", v, calls)
	}
	now = now.Add(2 * time.Second)
	if v, _ := c.Get(time.Minute, load); v != 20 || calls != 2 {
		t.Fatalf("refresh after TTL: v=%d calls=%d", v, calls)
	}

	// A failed refresh is returned and not cached: the next call retries.
	now = now.Add(2 * time.Minute)
	boom := errors.New("boom")
	if _, err := c.Get(time.Minute, func() (int, error) { calls++; return 0, boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if v, err := c.Get(time.Minute, load); err != nil || v != calls*10 {
		t.Fatalf("after error: v=%d err=%v", v, err)
	}
}

func TestTTLCache_ConcurrentMissesShareOneLoad(t *testing.T) {
	var c TTLCache[int]
	var mu sync.Mutex
	loads := 0
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			_, _ = c.Get(time.Minute, func() (int, error) {
				mu.Lock()
				loads++
				mu.Unlock()
				time.Sleep(10 * time.Millisecond)
				return 1, nil
			})
		})
	}
	wg.Wait()
	if loads != 1 {
		t.Fatalf("loads = %d, want 1", loads)
	}
}

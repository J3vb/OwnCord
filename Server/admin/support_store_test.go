package admin

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testBundleStore(t *testing.T) *supportBundles {
	t.Helper()
	s := newSupportBundles(nil, "test", nil, nil, nil)
	t.Cleanup(func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, v := range s.snapshots {
			v.expiry.Stop()
		}
	})
	return s
}

func TestSupportStore_BoundsExpiryAndSingleUse(t *testing.T) {
	s := testBundleStore(t)
	now := time.Now()
	s.now = func() time.Time { return now }
	for i := range supportMaxSnapshots {
		id := fmt.Sprintf("id-%d", i)
		if !s.save(supportSnapshot{preview: supportPreview{ID: id, SHA256: "hash", ExpiresAt: now.Add(supportTTL)}, actor: 1, session: id}) {
			t.Fatal("could not fill store")
		}
	}
	if s.save(supportSnapshot{preview: supportPreview{ID: "extra"}, session: "extra"}) {
		t.Fatal("snapshot bound exceeded")
	}
	if !s.save(supportSnapshot{preview: supportPreview{ID: "replacement", SHA256: "hash", ExpiresAt: now.Add(supportTTL)}, actor: 1, session: "id-0"}) {
		t.Fatal("same session must replace its preview without extra memory")
	}
	if _, ok := s.take("id-0", "hash", "id-0", 1); ok {
		t.Fatal("replaced preview remained valid")
	}
	if _, ok := s.take("replacement", "hash", "id-0", 2); ok {
		t.Fatal("actor binding missing")
	}
	var won atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, ok := s.take("replacement", "hash", "id-0", 1); ok {
				won.Add(1)
			}
		})
	}
	wg.Wait()
	if won.Load() != 1 {
		t.Fatalf("concurrent confirmations succeeded %d times", won.Load())
	}
	now = now.Add(supportTTL)
	if _, ok := s.take("id-1", "hash", "id-1", 1); ok {
		t.Fatal("expired preview accepted")
	}
	if !s.reserve() {
		t.Fatal("could not reserve builder")
	}
	if s.reserve() {
		t.Fatal("more than one concurrent builder admitted")
	}
	s.release()
	if len(s.snapshots) != 0 {
		t.Fatal("expired previews not reclaimed")
	}
}

func TestSupportEventTimeline_UsesFixedCodesAndDropsMalformedFields(t *testing.T) {
	rb := NewRingBuffer(10)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rb.Write(LogEntry{Timestamp: now, Level: "ERROR", Message: "livekit: process exited unexpectedly", Attrs: `{"error":"Bearer private-token"}`})
	rb.Write(LogEntry{Timestamp: now, Level: "private-token", Message: "private-token", Source: "private-token"})
	rb.Write(LogEntry{Timestamp: "private-token", Level: "ERROR", Message: "private-token"})
	events := supportEvents(rb)
	if len(events) != 2 || events[0].Event != "livekit_process_exited" || events[1].Level != "unspecified" || events[1].Event != "log_event" {
		t.Fatalf("unexpected sanitized timeline: %+v", events)
	}
}

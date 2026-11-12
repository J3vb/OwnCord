package externalcontent

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestResultCache_LongKeysTinyImagesStayBounded(t *testing.T) {
	const limit = 64 << 10
	c := newResultCache(limit, time.Hour)
	long := strings.Repeat("u", 1500)
	for i := range 5000 {
		c.put(imageEntry(fmt.Sprintf("image:%d/%s", i, long), "image/png", []byte{1}))
	}
	maxEntries := limit / int(entryWeight("image:0000/"+long, 1))
	if got := len(c.entries); got > maxEntries+1 {
		t.Fatalf("entries = %d, want about %d at most", got, maxEntries)
	}
	if c.bytes > limit || c.bytes < 0 || c.order.Len() != len(c.entries) {
		t.Fatalf("accounting off: bytes=%d list=%d map=%d", c.bytes, c.order.Len(), len(c.entries))
	}
}

func TestImageEntry_DropsOversizedBackingArray(t *testing.T) {
	body := make([]byte, 10, 1<<20)
	e := imageEntry("k", "image/png", body)
	if cap(e.image) > 2*len(body) {
		t.Fatalf("kept a %d-byte backing array for %d bytes", cap(e.image), len(body))
	}
	if e.size != entryWeight("k", 10) {
		t.Fatalf("size = %d", e.size)
	}
}

func TestResultCache_PutDropsExpiredFromOldestEnd(t *testing.T) {
	c := newResultCache(1<<20, time.Minute)
	now := time.Unix(0, 0)
	c.now = func() time.Time { return now }
	c.put(&cacheEntry{key: "old1", size: 10})
	c.put(&cacheEntry{key: "old2", size: 10})
	now = now.Add(30 * time.Second)
	c.put(&cacheEntry{key: "mid", size: 10})
	now = now.Add(45 * time.Second) // old1 and old2 expired, mid not
	c.put(&cacheEntry{key: "new", size: 10})
	if len(c.entries) != 2 || c.bytes != 20 {
		t.Fatalf("entries=%d bytes=%d, want 2 and 20", len(c.entries), c.bytes)
	}
	if _, ok := c.entries["old1"]; ok {
		t.Fatal("expired entry kept")
	}
}

func TestResultCache_OversizedEntryLeavesAccountingSound(t *testing.T) {
	c := newResultCache(100, time.Minute)
	c.put(&cacheEntry{key: "a", size: 60})
	c.put(&cacheEntry{key: "a", size: 500}) // replaces, too big to keep
	if len(c.entries) != 0 || c.bytes != 0 || c.order.Len() != 0 {
		t.Fatalf("entries=%d bytes=%d", len(c.entries), c.bytes)
	}
}

func TestResultCache_ConcurrentSameKeyKeepsBytesExact(t *testing.T) {
	c := newResultCache(1<<20, time.Minute)
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 500 {
				c.put(imageEntry("image:same", "image/png", make([]byte, 1+(i+j)%7)))
				c.get("image:same")
			}
		}()
	}
	wg.Wait()
	e, ok := c.get("image:same")
	if !ok || len(c.entries) != 1 || c.bytes != e.size {
		t.Fatalf("bytes=%d want %d entries=%d", c.bytes, e.size, len(c.entries))
	}
}

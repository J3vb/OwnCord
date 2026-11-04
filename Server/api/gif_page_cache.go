package api

import (
	"sync"
	"time"
)

// gifPageCache keeps upstream GIF pages for a short while, keyed on the
// upstream query without the API key. A nil cache keeps nothing.
type gifPageCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	max     int
	now     func() time.Time
	entries map[string]gifCachedPage
}

type gifCachedPage struct {
	page    gifResponse
	expires time.Time
}

func newGIFPageCache(ttl time.Duration, maxEntries int) *gifPageCache {
	return &gifPageCache{ttl: ttl, max: maxEntries, now: time.Now, entries: map[string]gifCachedPage{}}
}

func (c *gifPageCache) get(key string) (gifResponse, bool) {
	if c == nil {
		return gifResponse{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || !c.now().Before(e.expires) {
		return gifResponse{}, false
	}
	return e.page, true
}

// put keeps page under key, first dropping expired pages and, when still
// full, the one closest to expiring.
func (c *gifPageCache) put(key string, page gifResponse) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
	if _, replacing := c.entries[key]; !replacing && len(c.entries) >= c.max {
		oldest := ""
		for k, e := range c.entries {
			if oldest == "" || e.expires.Before(c.entries[oldest].expires) {
				oldest = k
			}
		}
		delete(c.entries, oldest)
	}
	c.entries[key] = gifCachedPage{page: page, expires: now.Add(c.ttl)}
}

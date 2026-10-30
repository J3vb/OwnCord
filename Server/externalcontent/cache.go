package externalcontent

import (
	"container/list"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"sync"
	"time"
)

// cacheEntry is one cached result: a preview or an image's bytes.
type cacheEntry struct {
	key     string
	preview previewData
	image   []byte
	media   string
	size    int64
	expires time.Time
}

// resultCache is a byte-weighted LRU with a time-to-live, so a long-running
// server neither grows without bound nor serves a changed page forever.
type resultCache struct {
	mu      sync.Mutex
	limit   int64
	ttl     time.Duration
	now     func() time.Time
	bytes   int64
	order   *list.List // front = most recently used
	entries map[string]*list.Element
}

func newResultCache(limit int64, ttl time.Duration) *resultCache {
	return &resultCache{
		limit:   limit,
		ttl:     ttl,
		now:     time.Now,
		order:   list.New(),
		entries: map[string]*list.Element{},
	}
}

func (c *resultCache) get(key string) (*cacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	entry, _ := el.Value.(*cacheEntry)
	if !c.now().Before(entry.expires) {
		c.removeLocked(el)
		return nil, false
	}
	c.order.MoveToFront(el)
	return entry, true
}

// put stores entry, evicting least recently used entries until the cache is
// back under its byte limit. An entry larger than the whole limit is not kept.
func (c *resultCache) put(entry *cacheEntry) {
	if entry.size > c.limit {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[entry.key]; ok {
		c.removeLocked(el)
	}
	entry.expires = c.now().Add(c.ttl)
	c.entries[entry.key] = c.order.PushFront(entry)
	c.bytes += entry.size
	for c.bytes > c.limit {
		c.removeLocked(c.order.Back())
	}
}

func (c *resultCache) removeLocked(el *list.Element) {
	entry, _ := c.order.Remove(el).(*cacheEntry)
	delete(c.entries, entry.key)
	c.bytes -= entry.size
}

// handle is one minted image handle: the vetted URL and the user it is for.
type handle struct {
	id    string
	owner int64
	url   string
}

// handleTable maps opaque handles to preview image URLs. Each user has their
// own oldest-first list, capped, so one member previewing a lot cannot expire
// anyone else's handles; asking again for an image that already has a handle
// hands back the same one. A handle answers only the user it was minted for.
type handleTable struct {
	mu       sync.Mutex
	perOwner int
	byID     map[string]*list.Element
	byKey    map[string]*list.Element // owner + "\x00" + url
	owners   map[int64]*list.List
}

func newHandleTable(perOwner int) *handleTable {
	return &handleTable{
		perOwner: perOwner,
		byID:     map[string]*list.Element{},
		byKey:    map[string]*list.Element{},
		owners:   map[int64]*list.List{},
	}
}

func handleKey(owner int64, url string) string {
	return strconv.FormatInt(owner, 10) + "\x00" + url
}

func (t *handleTable) mint(owner int64, url string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if el, ok := t.byKey[handleKey(owner, url)]; ok {
		t.owners[owner].MoveToFront(el)
		h, _ := el.Value.(*handle)
		return h.id, nil
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(raw[:])
	ring, ok := t.owners[owner]
	if !ok {
		ring = list.New()
		t.owners[owner] = ring
	}
	el := ring.PushFront(&handle{id: id, owner: owner, url: url})
	t.byID[id] = el
	t.byKey[handleKey(owner, url)] = el
	for ring.Len() > t.perOwner {
		old, _ := ring.Remove(ring.Back()).(*handle)
		delete(t.byID, old.id)
		delete(t.byKey, handleKey(old.owner, old.url))
	}
	return id, nil
}

func (t *handleTable) lookup(owner int64, id string) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	el, ok := t.byID[id]
	if !ok {
		return "", false
	}
	h, _ := el.Value.(*handle)
	if h.owner != owner {
		return "", false
	}
	return h.url, true
}

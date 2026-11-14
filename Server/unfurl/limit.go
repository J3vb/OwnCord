package unfurl

import (
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// userLimit caps how many links one author may have fetched per window, so a member cannot
// use the server to hammer a site. Fixed windows: simple, and the cap is a bound, not a quota.
type userLimit struct {
	per    int
	window time.Duration
	now    func() time.Time

	// mu guards buckets. A leaf lock.
	mu      syncutil.Mutex
	buckets map[int64]*bucket
}

type bucket struct {
	start time.Time
	used  int
}

// maxBuckets bounds the map; past it, expired windows are swept on the next call.
const maxBuckets = 2048

func newUserLimit(per int, window time.Duration, now func() time.Time) *userLimit {
	return &userLimit{per: per, window: window, now: now, buckets: make(map[int64]*bucket)}
}

// allow takes n links from user's window and reports whether they fit. A refused request takes
// nothing.
func (l *userLimit) allow(user int64, n int) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) >= maxBuckets {
		for id, b := range l.buckets {
			if now.Sub(b.start) >= l.window {
				delete(l.buckets, id)
			}
		}
	}
	b := l.buckets[user]
	if b == nil || now.Sub(b.start) >= l.window {
		b = &bucket{start: now}
		l.buckets[user] = b
	}
	if b.used+n > l.per {
		return false
	}
	b.used += n
	return true
}

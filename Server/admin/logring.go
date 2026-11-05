package admin

import (
	"sync"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// logRing is a fixed backing array plus write position: overwriting the
// oldest entry is a single slot store.
type logRing struct {
	entries []LogEntry // len == capacity
	pos     int        // next write position
	count   int        // entries stored (up to len(entries))
}

func (r *logRing) push(entry LogEntry) {
	r.entries[r.pos] = entry
	r.pos = (r.pos + 1) % len(r.entries)
	if r.count < len(r.entries) {
		r.count++
	}
}

func (r *logRing) snapshot() []LogEntry {
	out := make([]LogEntry, r.count)
	if r.count < len(r.entries) {
		// Not yet wrapped: entries [0, count) are already in order.
		copy(out, r.entries[:r.count])
		return out
	}
	// Wrapped: oldest entry sits at pos.
	n := copy(out, r.entries[r.pos:])
	copy(out[n:], r.entries[:r.pos])
	return out
}

// LogEntry holds a single structured log record for the ring buffer.
type LogEntry struct {
	Timestamp string `json:"ts"`
	Level     string `json:"level"`
	Message   string `json:"msg"`
	Source    string `json:"source"`
	Attrs     string `json:"attrs,omitempty"`
}

// RingBuffer is a bounded, thread-safe circular buffer of log entries with
// fan-out to SSE subscriber channels. It is a true ring (fixed backing array +
// write position, like ws.EventRingBuffer), so overwriting the oldest entry is
// a single slot store rather than an allocation + copy per write.
type RingBuffer struct {
	mu  syncutil.Mutex
	all logRing
	// warn holds the last supportEventsMax WARN-and-above entries, so an
	// INFO/DEBUG burst longer than all cannot evict a failure from the
	// support bundle.
	warn        logRing
	subscribers map[*logSubscriber]struct{}
	streamsEnd  chan struct{} // closed by EndStreams
	endOnce     sync.Once
	// history, when set, also gets every entry, for the saved log files.
	history atomic.Pointer[LogFile]
}

// NewRingBuffer creates a ring buffer with the given capacity (must be > 0).
func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		all:         logRing{entries: make([]LogEntry, capacity)},
		warn:        logRing{entries: make([]LogEntry, supportEventsMax)},
		subscribers: make(map[*logSubscriber]struct{}),
		streamsEnd:  make(chan struct{}),
	}
}

// EndStreams ends every open log stream, and any opened after it, for good.
// The server registers it with http.Server.RegisterOnShutdown: a stream never
// returns on its own and Shutdown waits for every active handler, so an open
// Logs tab would hold the drain for its whole budget. Safe to call more than
// once.
func (rb *RingBuffer) EndStreams() {
	rb.endOnce.Do(func() { close(rb.streamsEnd) })
}

// SetHistory makes every later entry also go to lf; nil stops that.
func (rb *RingBuffer) SetHistory(lf *LogFile) {
	rb.history.Store(lf)
}

// Write appends an entry, overwriting the oldest if full, and fans out
// to all subscribers (non-blocking to avoid slow clients blocking logging).
func (rb *RingBuffer) Write(entry LogEntry) {
	if h := rb.history.Load(); h != nil {
		h.Enqueue(entry)
	}
	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.all.push(entry)
	if isWarnLevel(entry.Level) {
		rb.warn.push(entry)
	}

	for sub := range rb.subscribers {
		sub.deliver(entry)
	}
}

// Snapshot returns a copy of all current entries, oldest first, for backfill.
func (rb *RingBuffer) Snapshot() []LogEntry {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.snapshotLocked()
}

// snapshotLocked is Snapshot's body, callable by callers that already hold
// rb.mu (SnapshotAndSubscribe needs the copy and the subscription to happen
// under the same critical section).
func (rb *RingBuffer) snapshotLocked() []LogEntry {
	return rb.all.snapshot()
}

// supportSnapshot returns every entry, oldest first, preceded by any of the
// last supportEventsMax WARN-and-above entries the general ring has already
// evicted. The warn ring's newest entries are the WARN+ entries still in the
// general ring, so only its older surplus is prepended.
func (rb *RingBuffer) supportSnapshot() []LogEntry {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	all, warn := rb.all.snapshot(), rb.warn.snapshot()
	retained := 0
	for _, entry := range all {
		if isWarnLevel(entry.Level) {
			retained++
		}
	}
	if evicted := len(warn) - retained; evicted > 0 {
		return append(warn[:evicted:evicted], all...)
	}
	return all
}

// isWarnLevel reports whether a LogEntry level is WARN or above.
func isWarnLevel(level string) bool {
	return level == "WARN" || level == "ERROR"
}

// Subscribe creates a buffered channel for a new SSE client.
// Returns the channel and an unsubscribe function.
func (rb *RingBuffer) Subscribe() (<-chan LogEntry, func()) {
	rb.mu.Lock()
	ch, unsub := rb.subscribeLocked()
	rb.mu.Unlock()
	return ch, unsub
}

// subscribeLocked is Subscribe's body, callable by callers that already hold
// rb.mu.
func (rb *RingBuffer) subscribeLocked() (<-chan LogEntry, func()) {
	sub := &logSubscriber{ch: make(chan LogEntry, 64)}
	rb.subscribers[sub] = struct{}{}

	return sub.ch, func() {
		rb.mu.Lock()
		delete(rb.subscribers, sub)
		rb.mu.Unlock()
	}
}

// SnapshotAndSubscribe atomically copies the current backfill entries and
// registers a new subscriber channel under a single lock acquisition.
//
// Two separate calls (Snapshot() then Subscribe()) leave a window where an
// entry written in between reaches neither the backfill nor the live feed,
// because Write's fan-out only reaches registered subscribers. The window is
// not instantaneous: handleLogStream runs a token-resolution DB round-trip per
// backfill chunk.
func (rb *RingBuffer) SnapshotAndSubscribe() ([]LogEntry, <-chan LogEntry, func()) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := rb.snapshotLocked()
	ch, unsub := rb.subscribeLocked()
	return out, ch, unsub
}

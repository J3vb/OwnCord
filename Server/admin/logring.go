package admin

import (
	"sync"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// logRing is a fixed array plus write position: overwriting the oldest entry is one slot store.
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
		copy(out, r.entries[:r.count])
		return out
	}
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

// RingBuffer is a bounded, thread-safe circular buffer of log entries with fan-out to SSE subscribers; a true
// ring (like ws.EventRingBuffer) so overwriting is one slot store, not an allocation + copy.
type RingBuffer struct {
	mu  syncutil.Mutex
	all logRing
	// warn holds the last supportEventsMax WARN+ entries so an INFO/DEBUG burst cannot evict a failure from the
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

// EndStreams ends every open log stream, and any opened later, for good. Registered with
// http.Server.RegisterOnShutdown: a stream never returns on its own and Shutdown waits for active handlers,
// so an open Logs tab would hold the drain for its whole budget. Safe to call repeatedly.
func (rb *RingBuffer) EndStreams() {
	rb.endOnce.Do(func() { close(rb.streamsEnd) })
}

// SetHistory makes every later entry also go to lf; nil stops that.
func (rb *RingBuffer) SetHistory(lf *LogFile) {
	rb.history.Store(lf)
}

// Write appends an entry, overwriting the oldest if full, and fans out to subscribers without blocking so
// slow clients cannot block logging.
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

// snapshotLocked is Snapshot's body for callers holding rb.mu (SnapshotAndSubscribe needs copy and
// subscription in one critical section).
func (rb *RingBuffer) snapshotLocked() []LogEntry {
	return rb.all.snapshot()
}

// supportSnapshot returns every entry oldest first, preceded by any of the last supportEventsMax WARN+
// entries the general ring already evicted (the warn ring's newest are still in the general ring, so only its
// older surplus is prepended).
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

func isWarnLevel(level string) bool {
	return level == "WARN" || level == "ERROR"
}

// Subscribe returns a buffered channel for a new SSE client and its unsubscribe function.
func (rb *RingBuffer) Subscribe() (<-chan LogEntry, func()) {
	rb.mu.Lock()
	ch, unsub := rb.subscribeLocked()
	rb.mu.Unlock()
	return ch, unsub
}

// subscribeLocked is Subscribe's body for callers holding rb.mu.
func (rb *RingBuffer) subscribeLocked() (<-chan LogEntry, func()) {
	sub := &logSubscriber{ch: make(chan LogEntry, 64)}
	rb.subscribers[sub] = struct{}{}

	return sub.ch, func() {
		rb.mu.Lock()
		delete(rb.subscribers, sub)
		rb.mu.Unlock()
	}
}

// SnapshotAndSubscribe atomically copies the backfill and registers a subscriber under one lock. Separate
// Snapshot() then Subscribe() calls leave a window where an entry written between reaches neither the
// backfill nor the live feed, since Write only reaches registered subscribers; the window is real because
// handleLogStream does a token-resolution DB round-trip per backfill chunk.
func (rb *RingBuffer) SnapshotAndSubscribe() ([]LogEntry, <-chan LogEntry, func()) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := rb.snapshotLocked()
	ch, unsub := rb.subscribeLocked()
	return out, ch, unsub
}

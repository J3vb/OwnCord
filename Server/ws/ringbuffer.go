package ws

import "github.com/owncord/server/syncutil"

// eventEntry stores a broadcast event for potential replay.
type eventEntry struct {
	seq       uint64
	channelID int64 // 0 = global broadcast, >0 = channel-scoped
	data      []byte
}

// EventRingBuffer is a bounded, thread-safe ring buffer for recent broadcast events.
type EventRingBuffer struct {
	mu      syncutil.RWMutex
	entries []eventEntry
	size    int
	pos     int // next write position
	count   int // total entries stored (up to size)
}

// NewEventRingBuffer creates a ring buffer with the given capacity.
func NewEventRingBuffer(size int) *EventRingBuffer {
	return &EventRingBuffer{
		entries: make([]eventEntry, size),
		size:    size,
	}
}

// Push adds an event to the ring buffer.
// channelID identifies the channel scope (0 = global broadcast).
func (rb *EventRingBuffer) Push(seq uint64, channelID int64, data []byte) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.entries[rb.pos] = eventEntry{seq: seq, channelID: channelID, data: data}
	rb.pos = (rb.pos + 1) % rb.size
	if rb.count < rb.size {
		rb.count++
	}
}

// EventsSince returns all events with seq > afterSeq, in order.
// Returns nil if afterSeq is too old (no longer in the buffer).
func (rb *EventRingBuffer) EventsSince(afterSeq uint64) [][]byte {
	rb.mu.RLock()
	defer rb.mu.RUnlock()

	if rb.count == 0 {
		return nil
	}

	// Find the oldest entry in the buffer.
	oldestIdx := (rb.pos - rb.count + rb.size) % rb.size
	oldestSeq := rb.entries[oldestIdx].seq

	// If the requested seq is at or older than our oldest, we can't guarantee
	// full coverage — return nil to trigger a full ready payload.
	if afterSeq <= oldestSeq {
		return nil
	}

	result := make([][]byte, 0)
	for i := 0; i < rb.count; i++ {
		idx := (oldestIdx + i) % rb.size
		e := rb.entries[idx]
		if e.seq > afterSeq {
			result = append(result, e.data)
		}
	}
	return result
}

// EventsSinceFiltered returns events with seq > afterSeq whose channelID is
// in allowedChannelIDs or whose channelID is 0 (global broadcasts).
// Returns nil if afterSeq is too old (same semantics as EventsSince).
func (rb *EventRingBuffer) EventsSinceFiltered(afterSeq uint64, allowedChannelIDs map[int64]bool) [][]byte {
	rb.mu.RLock()
	defer rb.mu.RUnlock()

	if rb.count == 0 {
		return nil
	}

	oldestIdx := (rb.pos - rb.count + rb.size) % rb.size
	oldestSeq := rb.entries[oldestIdx].seq

	if afterSeq <= oldestSeq {
		return nil
	}

	result := make([][]byte, 0)
	for i := 0; i < rb.count; i++ {
		idx := (oldestIdx + i) % rb.size
		e := rb.entries[idx]
		if e.seq > afterSeq {
			// channelID 0 = global broadcast, always include.
			// channelID > 0 = channel-scoped, include only if allowed.
			if e.channelID == 0 || allowedChannelIDs[e.channelID] {
				result = append(result, e.data)
			}
		}
	}
	return result
}

// OldestSeq returns the oldest sequence number in the buffer, or 0 if empty.
func (rb *EventRingBuffer) OldestSeq() uint64 {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	if rb.count == 0 {
		return 0
	}
	oldestIdx := (rb.pos - rb.count + rb.size) % rb.size
	return rb.entries[oldestIdx].seq
}

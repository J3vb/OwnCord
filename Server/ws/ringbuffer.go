package ws

import "github.com/J3vb/OwnCord/Server/syncutil"

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

	// Likewise if the client claims events newer than anything we ever held:
	// its counter and ours disagree (a restart can reseed seq below a client's
	// remembered lastSeq), so an empty slice here would be read as "caught up"
	// and freeze that client. afterSeq == newestSeq is the legitimate caught-up
	// case and still returns an empty replay.
	if afterSeq > rb.newestSeqLocked() {
		return nil
	}

	result := make([][]byte, 0)
	for i := 0; i < rb.count; i++ {
		idx := (oldestIdx + i) % rb.size
		e := rb.entries[idx]
		if e.seq <= afterSeq {
			continue
		}
		if e.data == nil {
			// A slot RemoveWhere cleared: the client would ack past a frame
			// it never saw. Replay cannot cover the range — full ready.
			return nil
		}
		result = append(result, e.data)
	}
	return result
}

// RemoveWhere drops the data of every buffered event drop reports true for
// and returns how many it dropped. The entry keeps its seq so the buffer's
// coverage window (OldestSeq/NewestSeq) is unchanged; a replay whose range
// crosses an emptied slot returns nil, so the client takes the full ready
// instead of acking past a frame it never received. Used by the account
// erasure to take an erased user's frames out of hot replay (O5).
func (rb *EventRingBuffer) RemoveWhere(drop func(data []byte) bool) int {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	removed := 0
	for i := 0; i < rb.count; i++ {
		idx := (rb.pos - rb.count + rb.size + i) % rb.size
		if rb.entries[idx].data != nil && drop(rb.entries[idx].data) {
			rb.entries[idx].data = nil
			removed++
		}
	}
	return removed
}

// newestSeqLocked returns the highest sequence number in the buffer. Callers
// must hold rb.mu and must have checked rb.count > 0.
func (rb *EventRingBuffer) newestSeqLocked() uint64 {
	return rb.entries[(rb.pos-1+rb.size)%rb.size].seq
}

// EventsSinceFiltered returns events with seq > afterSeq whose channelID is
// in allowedChannelIDs or whose channelID is 0 (global broadcasts).
// Returns nil if afterSeq is too old (same semantics as EventsSince).
func (rb *EventRingBuffer) EventsSinceFiltered(afterSeq uint64, allowedChannelIDs map[int64]bool) [][]byte {
	return rb.EventsSinceFilteredContent(afterSeq, allowedChannelIDs, allowedChannelIDs)
}

// EventsSinceFilteredContent is EventsSinceFiltered plus B5-7's content gate:
// a buffered event whose channelID is allowed is included as before UNLESS
// it is a content-bearing kind (contentBearingKinds) for a channel that is
// NOT in readableChannelIDs, in which case it is silently dropped — a
// labelled channel a caller has not acknowledged replays no content, even
// though the channel itself (metadata frames) still replays normally.
// EventsSinceFiltered is this with readableChannelIDs == allowedChannelIDs,
// i.e. no extra narrowing, for every caller that predates the content/
// metadata distinction (voice-only replay, most reconnect paths before an
// NSFW channel is involved).
func (rb *EventRingBuffer) EventsSinceFilteredContent(afterSeq uint64, allowedChannelIDs, readableChannelIDs map[int64]bool) [][]byte {
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

	// See EventsSince: a client ahead of everything we ever buffered must get a
	// full ready, not a silent "caught up".
	if afterSeq > rb.newestSeqLocked() {
		return nil
	}

	result := make([][]byte, 0)
	for i := 0; i < rb.count; i++ {
		idx := (oldestIdx + i) % rb.size
		e := rb.entries[idx]
		if e.seq > afterSeq {
			if e.data == nil {
				// See EventsSince: a cleared slot in the range forces a
				// full ready rather than a replay with a hole.
				return nil
			}
			// channelID 0 = global broadcast, always include.
			// channelID > 0 = channel-scoped, include only if allowed AND
			// (not content-bearing, or the channel is also readable).
			if e.channelID == 0 || (allowedChannelIDs[e.channelID] &&
				(!contentBearingKinds[extractEventType(e.data)] || readableChannelIDs[e.channelID])) {
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

// NewestSeq returns the highest sequence number in the buffer, or 0 if empty.
func (rb *EventRingBuffer) NewestSeq() uint64 {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	if rb.count == 0 {
		return 0
	}
	return rb.newestSeqLocked()
}

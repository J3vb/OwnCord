package ws

import (
	"sort"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

type eventEntry struct {
	seq       uint64
	channelID int64 // 0 = global broadcast, >0 = channel-scoped
	// contentBearing is contentBearingKinds[type], read once at Push so replay never re-parses a frame's
	// type.
	contentBearing bool
	data           []byte
}

// EventRingBuffer is a bounded, thread-safe ring buffer for recent broadcast events.
type EventRingBuffer struct {
	mu      syncutil.RankedRW[lockRankLeaf]
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

// Push adds an event to the ring buffer; channelID is the channel scope (0 = global).
func (rb *EventRingBuffer) Push(seq uint64, channelID int64, data []byte) {
	rb.pushEntry(seq, channelID, contentBearingKinds[extractEventType(data)], data)
}

// pushEntry is Push with the content-bearing flag worked out by the caller, so the hub can read a frame's
// type before taking the sequencing lock.
func (rb *EventRingBuffer) pushEntry(seq uint64, channelID int64, contentBearing bool, data []byte) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.entries[rb.pos] = eventEntry{seq: seq, channelID: channelID, contentBearing: contentBearing, data: data}
	rb.pos = (rb.pos + 1) % rb.size
	if rb.count < rb.size {
		rb.count++
	}
}

// EventsSince returns events with seq > afterSeq, in order; nil if afterSeq is too old.
func (rb *EventRingBuffer) EventsSince(afterSeq uint64) [][]byte {
	return rb.eventsSince(afterSeq, nil, nil, true)
}

// RemoveWhere drops the data of every buffered event drop reports true for and returns how
// many. The entry keeps its seq so the coverage window is unchanged; a replay crossing an
// emptied slot returns nil (full ready) instead of acking past a frame never received. Used
// by account erasure.
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

// newestSeqLocked returns the highest seq in the buffer; callers hold rb.mu and checked rb.count > 0.
func (rb *EventRingBuffer) newestSeqLocked() uint64 {
	return rb.entries[(rb.pos-1+rb.size)%rb.size].seq
}

// EventsSinceFiltered returns events with seq > afterSeq whose channelID is in
// allowedChannelIDs or 0 (global); nil if afterSeq is too old.
func (rb *EventRingBuffer) EventsSinceFiltered(afterSeq uint64, allowedChannelIDs map[int64]bool) [][]byte {
	return rb.EventsSinceFilteredContent(afterSeq, allowedChannelIDs, allowedChannelIDs)
}

// EventsSinceFilteredContent is EventsSinceFiltered plus the NSFW content gate: an allowed
// channel's content-bearing event (contentBearingKinds) is silently dropped unless the
// channel is in readableChannelIDs, so an unacknowledged labelled channel replays metadata
// but no content. EventsSinceFiltered is this with readableChannelIDs == allowedChannelIDs.
func (rb *EventRingBuffer) EventsSinceFilteredContent(afterSeq uint64, allowedChannelIDs, readableChannelIDs map[int64]bool) [][]byte {
	return rb.eventsSince(afterSeq, allowedChannelIDs, readableChannelIDs, false)
}

// eventsSince is the one ring walk behind EventsSince and EventsSinceFilteredContent.
// unfiltered admits every frame; otherwise channelID 0 is admitted and a channel-scoped
// frame only when allowed admits it and it is not content-bearing or readable admits its
// channel. Deliberately no nil-means-everything sentinel: a nil map must deny, or a future
// nil-map bug would read as a cross-channel replay leak.
func (rb *EventRingBuffer) eventsSince(afterSeq uint64, allowed, readable map[int64]bool, unfiltered bool) [][]byte {
	rb.mu.RLock()
	defer rb.mu.RUnlock()

	if rb.count == 0 {
		return nil
	}

	oldestIdx := (rb.pos - rb.count + rb.size) % rb.size
	oldestSeq := rb.entries[oldestIdx].seq

	// At or older than our oldest we cannot guarantee full coverage: nil triggers a full ready.
	if afterSeq <= oldestSeq {
		return nil
	}

	// Likewise if the client claims events newer than anything we held: a restart can reseed
	// seq below a client's lastSeq, and an empty slice would read as "caught up" and freeze it.
	// afterSeq == newestSeq is the legitimate caught-up case.
	if afterSeq > rb.newestSeqLocked() {
		return nil
	}

	// Seqs rise through the ring, so the first newer entry starts the tail and its length bounds the result.
	first := sort.Search(rb.count, func(i int) bool {
		return rb.entries[(oldestIdx+i)%rb.size].seq > afterSeq
	})
	result := make([][]byte, 0, rb.count-first)
	for i := first; i < rb.count; i++ {
		e := &rb.entries[(oldestIdx+i)%rb.size]
		if e.data == nil {
			// A slot RemoveWhere cleared: the client would ack past a frame it never saw; full ready.
			return nil
		}
		if unfiltered || e.channelID == 0 || (allowed[e.channelID] &&
			(!e.contentBearing || readable[e.channelID])) {
			result = append(result, e.data)
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
